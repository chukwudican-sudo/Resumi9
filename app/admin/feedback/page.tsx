import Link from 'next/link';
import { notFound } from 'next/navigation';
import { currentUserId } from '../../server/auth';
import { isAdmin } from '../../server/feedback';
import { listFeedbackAcrossUsers, type FeedbackRow } from '../../server/db/repository';
import { KIND_LABELS, isKind } from '../../lib/feedback';
import SeenToggle from './SeenToggle';

export const dynamic = 'force-dynamic';

/**
 * Everything anybody has said, newest first.
 *
 * A page rather than a query, unlike scripts/health.ts, for one reason: these
 * rows have screenshots in them, and an image is not a thing a terminal can
 * show. Everything else about it is the same shape — read-only, no filters,
 * no pagination beyond a cap, because the expected count is small and a
 * dashboard over single digits is furniture.
 *
 * **A 404 to everybody else**, including a signed-in stranger who guesses the
 * path. Not a 403: this address either exists for you or it does not, and a
 * 403 tells somebody there is something here worth coming back for.
 */
export default async function FeedbackInbox() {
  const userId = await currentUserId();
  if (!(await isAdmin(userId))) notFound();

  const rows = await listFeedbackAcrossUsers(200);
  const unseen = rows.filter((row) => !row.seenAt).length;

  return (
    <main className="min-h-screen bg-ground font-sans text-ink">
      <div className="flex h-[62px] items-center justify-between border-b border-rule px-9">
        <Link href="/applications" className="flex items-center gap-2.5">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#2F5D50" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
            <path d="M12 3v18M3 12h18M6 6l12 12M18 6L6 18" />
          </svg>
          <span className="text-[12.5px] uppercase tracking-[0.16em] text-ink-prose">Resumi9</span>
        </Link>
        <span className="text-[13px] text-ink-muted">
          {rows.length} {rows.length === 1 ? 'message' : 'messages'}
          {unseen ? <span className="ml-2 text-accent">{unseen} new</span> : null}
        </span>
      </div>

      <div className="mx-auto max-w-[760px] px-6 py-10">
        <h1 className="font-serif text-[34px] leading-[1.08] tracking-[-0.01em]">Feedback</h1>

        {!rows.length ? (
          <p className="mt-6 text-[14px] leading-relaxed text-ink-prose">
            Nothing yet. The button is on every page, signed in or not, so this fills up from the
            landing page as well as from inside the app.
          </p>
        ) : (
          <div className="mt-8 flex flex-col gap-4">
            {rows.map((row) => (
              <Entry key={row.id} row={row} />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

function Entry({ row }: { row: FeedbackRow }) {
  const label = isKind(row.kind) ? KIND_LABELS[row.kind] : row.kind;
  /*
   * The address to answer on. At most one exists: a signed-in report is
   * joined to the account's email and never stores a second copy, and a
   * signed-out one has only what they chose to type. A mailto rather than
   * text, because the reply is by hand and the alternative is selecting an
   * address out of a line of grey metadata.
   */
  const replyTo = row.accountEmail ?? row.email;

  return (
    <article
      className={`rounded-lg border bg-ground-surface p-5 ${
        row.seenAt ? 'border-rule-soft' : 'border-rule'
      }`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-accent-wash px-2.5 py-0.5 text-[11.5px] text-accent">{label}</span>
          {replyTo ? (
            <a
              href={`mailto:${replyTo}?subject=${encodeURIComponent(`Resumi9 — your feedback (${row.id})`)}`}
              className="text-[12.5px] text-accent underline decoration-accent-line underline-offset-4 transition hover:decoration-accent"
            >
              {replyTo}
            </a>
          ) : (
            <span className="text-[12.5px] text-ink-faint">signed out, left no address</span>
          )}
          {!row.accountEmail && row.email ? (
            <span className="text-[11.5px] text-ink-faint">no account</span>
          ) : null}
          <span className="text-[12px] text-ink-faint">{when(row.createdAt)}</span>
        </div>
        <SeenToggle id={row.id} seen={Boolean(row.seenAt)} />
      </div>

      {/* Their words, exactly as typed — newlines included. */}
      <p className="mt-3 whitespace-pre-wrap text-[14px] leading-relaxed text-ink">{row.message}</p>

      {row.shots.length ? (
        <div className="mt-4 flex flex-wrap gap-2.5">
          {row.shots.map((shot) => (
            <a
              key={shot.id}
              href={`/api/feedback/shot/${shot.id}`}
              target="_blank"
              rel="noreferrer"
              className="block"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/feedback/shot/${shot.id}`}
                alt="Screenshot attached to this feedback"
                className="h-[108px] rounded border border-rule-field bg-ground object-cover transition hover:border-accent-line"
              />
            </a>
          ))}
        </div>
      ) : null}

      {/*
       * The attempt beside it, where the person was writing about one. This is
       * why the join exists: a one-line "it didn't work" is unanswerable on its
       * own, and the failures table already knows which stage broke and
       * whether the credit went back.
       */}
      {row.attempt ? (
        <div
          /*
           * Flag colours only when something actually went wrong. An attempt
           * that finished fine is useful context — it says this is not a
           * tailor failure — and putting that in a "needs attention" panel
           * would train the eye to ignore the colour.
           */
          className={`mt-4 rounded border px-3 py-2 text-[12.5px] leading-relaxed ${
            row.attempt.ok === true
              ? 'border-rule bg-ground-panel text-ink-prose'
              : 'border-flag-line bg-flag-bg text-flag-ink'
          }`}
        >
          <span className="font-medium">Their last attempt:</span> {row.attempt.stage}
          {row.attempt.fault ? ` · ${row.attempt.fault}` : ''}
          {row.attempt.ok === false ? ' · failed' : row.attempt.ok === null ? ' · never finished' : ' · finished ok'}
          {row.attempt.refunded ? ' · refunded' : ''}
          {row.attempt.reason ? <span className="block text-ink-muted">{row.attempt.reason}</span> : null}
        </div>
      ) : null}

      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[11.5px] text-ink-faint">
        <Detail label="page" value={row.pageUrl} />
        <Detail label="application" value={row.applicationId} />
        <Detail label="window" value={row.viewport} />
        <Detail label="build" value={row.appVersion} />
        <Detail label="browser" value={row.userAgent} />
        <Detail label="reference" value={row.id} />
      </dl>
    </article>
  );
}

function Detail({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <>
      <dt className="uppercase tracking-[0.08em]">{label}</dt>
      <dd className="break-all text-ink-muted">{value}</dd>
    </>
  );
}

/** How long ago, then the date once "ago" stops meaning anything useful. */
function when(at: Date): string {
  const minutes = Math.round((Date.now() - at.getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`;
  return at.toISOString().slice(0, 16).replace('T', ' ');
}
