import { NextRequest, NextResponse } from 'next/server';
import { renderResumeLatex } from '../../lib/latexEngine';
import { checkReadiness } from '../../lib/readiness';
import { requireUserId } from '../../server/auth';
import { beginAttempt, endAttempt } from '../../server/db/repository';
import { faultOf, sanitise } from '../../lib/failures';
import { LatexCompileError, compileToPdf } from '../../server/pdf';
import { resolveResume } from '../../server/resolveResume';

// tectonic must run in Node (child_process), not the edge runtime.
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Turns one of your saved resumes into a PDF.
 *
 * This endpoint used to accept a LaTeX string and compile whatever it was
 * given, from anyone, with no sign-in. That is remote code execution wearing a
 * hat: TeX can read files (`\input{/etc/passwd}` renders them into the returned
 * PDF) and loop forever, so the returned document was an exfiltration channel
 * and the timeout was a denial-of-service budget.
 *
 * The fix is not to filter the LaTeX — you cannot reliably filter a Turing
 * complete macro language. It is to stop accepting it. Callers name a resume
 * they own; the server loads it and renders the LaTeX itself. User text now
 * reaches TeX only as escaped arguments, through exactly one function.
 */
export async function POST(req: NextRequest) {
  const userId = await requireUserId();

  let body: { applicationId?: unknown; version?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { applicationId } = body;
  if (applicationId !== undefined && typeof applicationId !== 'string') {
    return NextResponse.json({ error: '"applicationId" must be a string' }, { status: 400 });
  }

  // The version the person is actually looking at. Without this the download
  // silently hands over the latest while an older one is on screen, and the
  // filename gives no hint that they differ.
  const version = typeof body.version === 'number' && body.version > 0 ? body.version : null;

  const resolved = await resolveResume(userId, applicationId, version);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }
  const { structure, filename } = resolved;

  // Checked here rather than only in the page, because a disabled button is a
  // suggestion — this is where the PDF is actually produced.
  const readiness = checkReadiness(structure);
  if (!readiness.ready) {
    return NextResponse.json(
      {
        error: 'This resume is not finished yet.',
        blocking: readiness.blocking,
      },
      { status: 422 },
    );
  }

  try {
    const pdf = await compileToPdf(renderResumeLatex(structure));
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Length': String(pdf.length),
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    /*
     * A compile that never produced a PDF. Logged for everybody, including
     * the busy case — "too many at once" is the kind of thing that is
     * invisible until somebody counts it, and it is the one error shape a
     * real user has plausibly met without anyone knowing.
     */
    await endAttempt(
      await beginAttempt(userId, { kind: 'compile', applicationId: typeof applicationId === 'string' ? applicationId : null, stage: 'compile' }),
      { ok: false, stage: 'compile', fault: faultOf(err, 'compile'), reason: sanitise(err) },
    );
    if (err instanceof LatexCompileError) {
      if (err.kind === 'busy') {
        // Transient, and it says so. Reported as a logged bug until now, which
        // tells somebody to give up on a thing that would work in five seconds.
        return NextResponse.json(
          { error: 'Too many resumes building at once. Try again in a few seconds.' },
          { status: 503 },
        );
      }
      if (err.kind === 'config') {
        console.error(`[Resumi9] ${err.message}`);
        return NextResponse.json({ error: err.message }, { status: 500 });
      }
      // The LaTeX was ours, so the log is our debugging material, not theirs —
      // and a TeX trace is not something to put in front of someone who only
      // asked for a PDF.
      console.error(`[Resumi9] Resume failed to compile for ${userId}:\n${err.log}`);
      return NextResponse.json(
        { error: "We couldn't build that PDF. This one is on us — it has been logged." },
        { status: 500 },
      );
    }
    throw err;
  }
}
