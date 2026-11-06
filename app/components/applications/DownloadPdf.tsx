'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { polishMasterResume } from '../../server/actions';
import { useUndo } from '../undo/UndoProvider';
import { useEscape } from '../useEscape';
import { DOWNLOAD_STEPS, DOWNLOAD_WHY } from '../../lib/waits';
import type { WaitControl } from '../setup/waitControl';

/**
 * Gets the PDF onto someone's machine.
 *
 * Sends an id rather than a document: the server already holds the resume, and
 * asking the browser to send back a rendering of it would mean trusting
 * whatever came back. What returns here is a finished PDF and a filename the
 * server chose, so the name is right without the client knowing the rule.
 */
export default function DownloadPdf({
  applicationId,
  version,
  polishFirst = false,
  disabled = false,
  wait,
}: {
  applicationId?: string;
  /** Which version to hand over. Omitted means the latest. */
  version?: number;
  /**
   * Polish before handing the file over.
   *
   * Set when the master resume has unpolished edits. The button does not
   * advertise it — polishing is how a resume gets made here, not a separate
   * feature to be opted into — but it does report afterwards, because it now
   * corrects the entries themselves and editing someone's stored data without
   * telling them is not a thing to do quietly.
   */
  polishFirst?: boolean;
  /** Held shut while a form has unsaved changes that a polish would undo. */
  disabled?: boolean;
  /**
   * The preview pane, on /setup only.
   *
   * Pressing Download on a stale resume runs a full editorial pass first — two
   * model calls, twenty-odd seconds — behind a button that says "Building…".
   * That half belongs in the pane. The compile after it is a second or two and
   * stays on the button, which is the right length for a label.
   */
  wait?: WaitControl;
}) {
  const router = useRouter();
  const [state, setState] = useState<'idle' | 'working' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [blocking, setBlocking] = useState<{ message: string }[]>([]);
  const { dismiss } = useUndo();

  /**
   * The finished PDF, fetched before anybody asks for it.
   *
   * Three faults, one cause: the file was built after the click. Chrome
   * allows a programmatic save only while the click that caused it is still
   * the current user gesture, and `await fetch(...)` spends that gesture — so
   * the FIRST download worked and every one after it in the same tab was
   * blocked silently, no error, no file. Navigating away mid-build threw the
   * work away, and the only sign anything was happening was the word
   * "Building…" on the button.
   *
   * So it is built up front and the click only saves it. The save is then
   * synchronous with the gesture, which is what Chrome asks for; the file is
   * already on the machine when the button is pressed, so leaving the page
   * cannot lose it; and the button can say whether it is ready instead of
   * going quiet for several seconds.
   *
   * It costs no extra compile. This is the same URL, with the same ETag, that
   * the preview beside it has already fetched — the browser serves it from
   * cache, and a revalidation the server answers is a hash comparison rather
   * than a build.
   */
  const [ready, setReady] = useState<{ blob: Blob; filename: string } | null>(null);
  const building = useRef<Promise<{ blob: Blob; filename: string } | null> | null>(null);

  // The "Not ready to send" list had the same problem as the polish panel: a
  // popover with one small × and no other exit.
  useEscape(blocking.length > 0, () => setBlocking([]));

  /**
   * Fetches the PDF and its server-chosen name, once per version.
   *
   * Shared by the prefetch and the click, through `building`, so pressing
   * the button while the prefetch is still in flight waits for that one
   * rather than starting a second compile.
   *
   * Errors are deliberately swallowed here and re-raised by the click: a
   * prefetch nobody asked for must never put a message on screen, and the
   * readiness list in particular belongs to the moment somebody tries to
   * send the thing.
   */
  const fetchPdf = useCallback(async () => {
    if (building.current) return building.current;
    const query = applicationId
      ? `?applicationId=${encodeURIComponent(applicationId)}${version ? `&v=${version}` : ''}`
      : '';
    const run = (async () => {
      const response = await fetch(`/api/resume/preview${query}`);
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw Object.assign(new Error(body?.error ?? `Something went wrong (${response.status}).`), {
          blocking: Array.isArray(body?.blocking) ? body.blocking : [],
        });
      }
      const disposition = response.headers.get('Content-Disposition') ?? '';
      const named = /filename="([^"]+)"/.exec(disposition);
      return { blob: await response.blob(), filename: named?.[1] ?? 'Resume.pdf' };
    })();
    building.current = run;
    try {
      const got = await run;
      setReady(got);
      return got;
    } catch (err) {
      // Cleared so a later click retries rather than replaying the failure.
      building.current = null;
      throw err;
    }
  }, [applicationId, version]);

  /*
   * Built as soon as there is something to build, and again when the version
   * changes — an edit makes a new resume, and handing over the previous one
   * because it happened to be cached is worse than any delay.
   *
   * Not on the master-resume path: that one may have to polish first, which
   * rewrites bullets and costs two model calls, and doing it because a page
   * loaded would be spending somebody's time on a file they have not asked
   * for.
   */
  useEffect(() => {
    if (!applicationId || polishFirst) return;
    setReady(null);
    building.current = null;
    let cancelled = false;
    void fetchPdf().catch(() => {
      // Quiet by design. The click reports it.
      if (!cancelled) setReady(null);
    });
    return () => {
      cancelled = true;
    };
  }, [applicationId, version, polishFirst, fetchPdf]);

  /** Hands a blob to the browser. Must stay synchronous — see `ready`. */
  function save({ blob, filename }: { blob: Blob; filename: string }) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  async function download() {
    /*
     * The file is already here, so it is handed over inside the click.
     *
     * No await before `save`, deliberately: the gesture is still current, and
     * that is the whole difference between a download and Chrome silently
     * dropping the second one of the session.
     */
    if (ready && !polishFirst) {
      save(ready);
      setMessage(null);
      setBlocking([]);
      return;
    }

    setState('working');
    setMessage(null);
    setBlocking([]);
    try {
      if (polishFirst) {
        // One list with the PDF on the end of it. Press Download, get twenty
        // seconds of spell-checking, and the polish reads as something that
        // wandered in — unless you can see where it is going.
        wait?.start({
          title: 'Getting your resume ready.',
          steps: DOWNLOAD_STEPS,
          estimate: DOWNLOAD_WHY,
          scope: 'pane',
        });
      // A polish rewrites bullets across every entry, so any offer still
      // standing is about text that has just moved underneath it. Taking it
      // away is what stops Undo writing a pre-polish value back over the pass.
      //
      // The pass still records what it overwrote, and undoing it lives on the
      // Polish button rather than here: offering to unpick an edit from the
      // button that just handed over a PDF made from it would be a question
      // about the wrong thing at the wrong moment.
        dismiss();
        // Not reported afterwards. The note this used to leave in the header
        // never cleared, so it sat between Download and Done for the rest of
        // the session holding a gap open — and the steps above have already
        // said what the pass does, while it is doing it.
        await polishMasterResume();
        router.refresh();
      }

      /*
       * The master resume still compiles on demand, because a polish has to
       * run first and may have just rewritten every bullet. Applications take
       * the prefetched copy above; this is the path where there is nothing to
       * prefetch.
       *
       * Still POST /api/compile for that case: it is the route that builds
       * from the profile rather than from a saved version.
       */
      const response = applicationId
        ? null
        : await fetch('/api/compile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          });

      if (response && !response.ok) {
        // The wait goes first, or the reason for the failure is behind it.
        wait?.cancel();
        const body = await response.json().catch(() => null);
        setMessage(body?.error ?? `Something went wrong (${response.status}).`);
        // The server says what is missing; repeating "not finished" without the
        // list would leave someone clicking the same button again.
        setBlocking(Array.isArray(body?.blocking) ? body.blocking : []);
        setState('error');
        return;
      }

      // The filename is the server's to decide — it is the one thing a
      // recruiter sees before opening the file.
      let got: { blob: Blob; filename: string };
      if (response) {
        const disposition = response.headers.get('Content-Disposition') ?? '';
        const named = /filename="([^"]+)"/.exec(disposition);
        got = { blob: await response.blob(), filename: named?.[1] ?? 'Resume.pdf' };
      } else {
        /*
         * Clicked before the prefetch finished, which is the one case left
         * where the save happens after an await. Chrome allows the first
         * such download in a tab, and by the second the prefetch has long
         * since landed — so this path is the rare one, not the usual one.
         */
        const prefetched = await fetchPdf();
        if (!prefetched) throw new Error('No PDF came back.');
        got = prefetched;
      }

      save(got);

      // Finished here, not after the polish: the compile is the last step in the
      // list the person is looking at.
      wait?.finish();
      setState('idle');
    } catch (err) {
      wait?.cancel();
      /*
       * A readiness refusal is not a network fault.
       *
       * `fetchPdf` throws the server's own message with its blocking list
       * attached, and reporting that as "your internet connection dropped"
       * sends somebody to check a router over an unfinished resume.
       */
      const said = err instanceof Error ? err.message : '';
      const list = (err as { blocking?: { message: string }[] })?.blocking;
      setMessage(said || 'Your internet connection dropped. Please check your connection.');
      setBlocking(Array.isArray(list) ? list : []);
      setState('error');
    }
  }

  return (
    <div className="relative flex items-center gap-3">
      {message && !blocking.length ? <span className="text-[12.5px] text-flag">{message}</span> : null}
      <button
        type="button"
        onClick={download}
        disabled={state === 'working' || disabled}
        className="flex items-center gap-2 rounded bg-accent px-4 py-2 text-[13px] font-medium text-ground transition hover:bg-accent-hover disabled:opacity-50"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />
        </svg>
        {/*
          Says which of the three states it is in.

          It said "Download PDF" through several seconds of compiling and
          then nothing happened, which is the "no preparing message" report.
          Now the preparing happens before the click, so the usual reading is
          the plain label on a button that saves instantly; "Preparing…"
          only shows in the short window after a page load or an edit.
        */}
        {state === 'working'
          ? 'Building…'
          : applicationId && !polishFirst && !ready
            ? 'Preparing…'
            : 'Download PDF'}
      </button>

      {blocking.length ? (
        <div className="absolute right-0 top-full z-50 mt-2 w-[360px] rounded-lg border border-flag/40 bg-ground-surface p-4 text-left shadow-xl shadow-ink/10">
          <div className="mb-2 flex items-start justify-between gap-4">
            <span className="text-[11px] uppercase tracking-[0.12em] text-flag">Not ready to send</span>
            <button
              type="button"
              onClick={() => setBlocking([])}
              aria-label="Dismiss"
              className="-mt-0.5 shrink-0 rounded p-1 text-ink-faint transition hover:bg-ground-panel hover:text-ink"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
          <ul className="flex flex-col gap-1.5">
            {blocking.map((b) => (
              <li key={b.message} className="text-[12.5px] leading-snug text-ink-prose">
                {b.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
