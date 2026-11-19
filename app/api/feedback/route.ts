import { NextRequest, NextResponse } from 'next/server';
import {
  MAX_AGENT,
  MAX_EMAIL,
  MAX_MESSAGE,
  MAX_SHOTS,
  MAX_SHOT_BYTES,
  MAX_TOTAL_BYTES,
  MAX_URL,
  MIN_MESSAGE,
  RATE_GLOBAL_PER_HOUR,
  RATE_PER_SENDER,
  RATE_WINDOW_MINUTES,
  applicationIdFrom,
  isKind,
  trimTo,
} from '../../lib/feedback';
import { currentUserId } from '../../server/auth';
import { appVersion, callerIp, senderKey, sniffImage, storeLimitBytes } from '../../server/feedback';
import {
  countFeedbackAcrossUsers,
  countFeedbackFrom,
  hasApplication,
  latestAttemptFor,
  saveFeedback,
  storedShotBytes,
} from '../../server/db/repository';

export const maxDuration = 30;

/**
 * Somebody telling us something.
 *
 * **Public.** A visitor who bounced off the landing page is the one person
 * whose reason nobody ever learns, and a form behind a sign-in cannot hear
 * from them. Signed in or not, the shape is the same; what differs is that a
 * signed-in report can be joined to the account, the application and the
 * attempt that failed, and a signed-out one carries only what they typed.
 *
 * Everything the browser sends is a limit restated — the panel enforces the
 * same numbers so nobody waits for an upload that was never going to be
 * accepted, but this is the enforcement. The context that matters is read
 * here instead: the browser string and the address off the request, the build
 * off the environment, the application and the failed attempt out of the
 * database under the signed-in id.
 *
 * It answers with the reference and nothing else. The panel keeps the person's
 * text until this returns 200, so every failure below costs a retry rather
 * than what they wrote.
 */
export async function POST(request: NextRequest) {
  const userId = await currentUserId();

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    // A body over the platform's request cap never reaches here as a parseable
    // form. Saying so beats "something went wrong" for the one person whose
    // screenshots were too big for a limit the panel should have caught.
    return NextResponse.json(
      { error: 'That was too large to send. Try fewer or smaller screenshots.' },
      { status: 413 },
    );
  }

  const field = (name: string): string => {
    const value = form.get(name);
    return typeof value === 'string' ? value.trim() : '';
  };

  const message = field('message');
  if (message.length < MIN_MESSAGE) {
    return NextResponse.json({ error: 'Tell us what happened first.' }, { status: 400 });
  }
  if (message.length > MAX_MESSAGE) {
    return NextResponse.json({ error: `Keep it under ${MAX_MESSAGE} characters.` }, { status: 400 });
  }

  const raw = field('kind');
  // An unrecognised kind is sorted rather than refused: the person has
  // something to say either way, and losing it over a dropdown would be absurd.
  const kind = isKind(raw) ? raw : 'other';

  // ── what they attached ─────────────────────────────────────────────────
  const files = form.getAll('shot').filter((part): part is File => part instanceof File);
  if (files.length > MAX_SHOTS) {
    return NextResponse.json({ error: `At most ${MAX_SHOTS} screenshots.` }, { status: 400 });
  }

  const shots: { contentType: string; bytes: Buffer }[] = [];
  let total = 0;
  for (const file of files) {
    if (file.size === 0) continue;
    if (file.size > MAX_SHOT_BYTES) {
      return NextResponse.json({ error: 'One of those screenshots is too large.' }, { status: 400 });
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    // The bytes' own header, not the part's content type — that is a string
    // the sender chose, and the admin page serves these back.
    const contentType = sniffImage(bytes);
    if (!contentType) {
      return NextResponse.json({ error: 'Screenshots need to be PNG or JPEG.' }, { status: 400 });
    }
    total += bytes.byteLength;
    if (total > MAX_TOTAL_BYTES) {
      return NextResponse.json(
        { error: 'Those screenshots come to too much together. Try one at a time.' },
        { status: 400 },
      );
    }
    shots.push({ contentType, bytes });
  }

  const email = field('email');
  const pageUrl = field('pageUrl');

  /*
   * One try around everything that touches the database, so any failure in it
   * is the same answer: a 500 the panel can read, with the person's text still
   * in the box. There are four queries below and the rate limit is two of
   * them — a window where the table does not exist yet (the migration not
   * applied, or applied after the deploy) would otherwise surface as a raw
   * framework error from a query made before anything was even validated.
   */
  try {
    // ── how often ────────────────────────────────────────────────────────
    const sender = senderKey(userId, callerIp(request.headers));
    const tooMuch = 'Thanks — that is a few in a row. Give it a few minutes and send the rest.';
    if (sender) {
      const recent = await countFeedbackFrom(sender, RATE_WINDOW_MINUTES);
      if (recent >= RATE_PER_SENDER) return NextResponse.json({ error: tooMuch }, { status: 429 });
    }
    if ((await countFeedbackAcrossUsers(60)) >= RATE_GLOBAL_PER_HOUR) {
      return NextResponse.json({ error: tooMuch }, { status: 429 });
    }

    // ── where they were ──────────────────────────────────────────────────
    const claimed = applicationIdFrom(pageUrl);
    // Checked rather than trusted. A made-up id becomes null, not a pointer
    // into somebody else's rows.
    const applicationId = userId && claimed && (await hasApplication(userId, claimed)) ? claimed : null;

    // The attempt they are most likely writing about, if one is recent enough
    // to plausibly be it. The join that makes "it didn't work" answerable.
    const attemptId = userId ? await latestAttemptFor(userId, applicationId, 120) : null;

    /*
     * ── is there room ──────────────────────────────────────────────────
     *
     * The per-submission caps above bound ONE report and nothing else. This
     * is the cap that bounds the table, and so the database — which is
     * shared with every resume in the app and is not large.
     *
     * Past it the report is still stored and the images are not, and the
     * person is told which. Dropping somebody's words because an unrelated
     * table is full would be protecting the wrong thing; dropping them
     * silently would be worse than either.
     */
    let kept = shots;
    if (shots.length && (await storedShotBytes()) + total > storeLimitBytes()) {
      console.error('[Resumi9] Feedback screenshot store is full; storing the message only.');
      kept = [];
    }

    const { id } = await saveFeedback({
      userId,
      applicationId,
      kind,
      message,
      // Only asked of somebody signed out — a signed-in account already has
      // one, and storing a second copy beside every report is a second place
      // to have to delete it from.
      email: userId ? null : trimTo(email, MAX_EMAIL) || null,
      pageUrl: trimTo(pageUrl, MAX_URL) || null,
      userAgent: trimTo(request.headers.get('user-agent') ?? '', MAX_AGENT) || null,
      viewport: trimTo(field('viewport'), 40) || null,
      appVersion: appVersion(),
      attemptId,
      sender,
      shots: kept,
    });
    return NextResponse.json({ id, shotsKept: kept.length, shotsSent: shots.length });
  } catch (error) {
    // Said out loud, because the alternative is the person's text sitting in a
    // panel that will not clear with no idea why. The panel keeps it either way.
    console.error('[Resumi9] Could not store feedback.', error);
    return NextResponse.json(
      { error: 'That did not send. Your message is still here — try again.' },
      { status: 500 },
    );
  }
}
