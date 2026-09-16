'use client';

import { useState } from 'react';
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

  // The "Not ready to send" list had the same problem as the polish panel: a
  // popover with one small × and no other exit.
  useEscape(blocking.length > 0, () => setBlocking([]));

  async function download() {
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

      const response = await fetch('/api/compile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The version being looked at, not whatever is newest. Without it the
      // download hands over the latest while an older one is on screen, and the
      // filename gives no hint that they differ.
      body: JSON.stringify(applicationId ? { applicationId, version } : {}),
      });

      if (!response.ok) {
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
      const disposition = response.headers.get('Content-Disposition') ?? '';
      const named = /filename="([^"]+)"/.exec(disposition);
      const blob = await response.blob();

      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = named?.[1] ?? 'Resume.pdf';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);

      // Finished here, not after the polish: the compile is the last step in the
      // list the person is looking at.
      wait?.finish();
      setState('idle');
    } catch {
      wait?.cancel();
      setMessage('Your internet connection dropped. Please check your connection.');
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
        {state === 'working' ? 'Building…' : 'Download PDF'}
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
