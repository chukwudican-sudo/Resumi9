import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { renderResumeLatex } from '../../../lib/latexEngine';
import { checkReadiness } from '../../../lib/readiness';
import { requireUserId } from '../../../server/auth';
import { beginAttempt, endAttempt } from '../../../server/db/repository';
import { faultOf, sanitise } from '../../../lib/failures';
import { LatexCompileError, compileToPdf } from '../../../server/pdf';
import { resolveResume } from '../../../server/resolveResume';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * The resume as a PDF, for showing rather than saving.
 *
 * Same document as the download — same structure, same renderer — because a
 * preview that is a separate rendering is a preview of something you will never
 * receive. The app used to draw an approximation of the resume in HTML beside
 * a button that produced a real one, and the two disagreed about section order,
 * about whether coursework existed, and about whether the whole thing fitted on
 * one page. Page count is not a detail on a resume.
 *
 * The compile is skipped entirely on a repeat view. The LaTeX is deterministic,
 * so hashing it costs nothing and answers "has this changed?" before any of the
 * expensive work happens — an unchanged resume is a 304 and the browser shows
 * the copy it already has.
 */
export async function GET(req: NextRequest) {
  const userId = await requireUserId();
  const applicationId = req.nextUrl.searchParams.get('applicationId');

  // In the query string rather than a header: the browser caches by URL, so two
  // versions of one application would otherwise share a single cache entry.
  const requested = Number(req.nextUrl.searchParams.get('v'));
  const version = Number.isFinite(requested) && requested > 0 ? requested : null;

  const resolved = await resolveResume(userId, applicationId, version);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }

  // A resume too unfinished to send is too unfinished to preview: showing a
  // clean page would contradict the download refusing on the same grounds.
  const readiness = checkReadiness(resolved.structure);
  if (!readiness.ready) {
    return NextResponse.json(
      { error: 'This resume is not finished yet.', blocking: readiness.blocking },
      { status: 422 },
    );
  }

  const latex = renderResumeLatex(resolved.structure);
  const etag = `"${createHash('sha256').update(latex).digest('hex').slice(0, 32)}"`;

  if (req.headers.get('if-none-match') === etag) {
    return new NextResponse(null, { status: 304, headers: { ETag: etag } });
  }

  try {
    const pdf = await compileToPdf(latex);
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Length': String(pdf.length),
        // Inline: this one is being looked at, not saved.
        'Content-Disposition': `inline; filename="${resolved.filename}"`,
        ETag: etag,
        // Revalidate every time, but revalidation is a hash comparison rather
        // than a compile. Private because it is somebody's resume.
        'Cache-Control': 'private, max-age=0, must-revalidate',
      },
    });
  } catch (err) {
    // Same as the download: a preview nobody could build is a failure the
    // person saw, whether or not they were about to send the file.
    await endAttempt(
      await beginAttempt(userId, { kind: 'preview', applicationId, stage: 'compile' }),
      { ok: false, stage: 'compile', fault: faultOf(err, 'compile'), reason: sanitise(err) },
    );
    if (err instanceof LatexCompileError) {
      // Busy is not broken: the service holds two slots and refuses the third,
      // which a retry a moment later gets past. Saying "on us, it has been
      // logged" for that tells somebody to stop trying.
      if (err.kind === 'busy') {
        return NextResponse.json(
          { error: 'Too many resumes building at once. This will sort itself out in a moment.' },
          { status: 503 },
        );
      }
      console.error(`[Resumi9] Preview failed to compile for ${userId}:\n${err.log}`);
      return NextResponse.json(
        {
          error:
            err.kind === 'config'
              ? err.message
              : "We couldn't build this preview. This one is on us — it has been logged.",
        },
        { status: 500 },
      );
    }
    throw err;
  }
}
