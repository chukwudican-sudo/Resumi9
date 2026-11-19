'use client';

import { useEffect, useRef, useState } from 'react';
import { useEscape } from './useEscape';
import {
  KINDS,
  KIND_LABELS,
  MAX_MESSAGE,
  MAX_SHOTS,
  MAX_SHOT_BYTES,
  MAX_TOTAL_BYTES,
  MIN_MESSAGE,
  type Kind,
} from '../lib/feedback';

/**
 * The way to say something, from anywhere.
 *
 * In the root layout, so it is on the landing page a stranger bounces off as
 * well as on the pages you have to sign in to reach. Bottom right and quiet:
 * a panel rather than a takeover, because the thing somebody is reporting is
 * usually still on the screen behind it, and a form that covers the problem is
 * the most common complaint about feedback widgets.
 *
 * **It does not lose what you wrote.** The text is held in the component until
 * the server says it has it, and mirrored to this browser's own storage on
 * every keystroke — so a failed send, a closed panel or a reloaded tab all
 * leave the draft where you left it. Only a 200 clears it.
 *
 * Screenshots are shrunk here, before they are sent. Not for the database's
 * sake: a serverless request body is capped around four and a half megabytes,
 * and a 12MB retina screenshot is refused by the platform before any of our
 * code can say why.
 */

/**
 * The long edge a screenshot is scaled down to.
 *
 * 1600, not the panel's native 1800: a dense retina screenshot came back at
 * 1.2 MB at 1800, and this takes a typical one to 200-400 KB with no
 * legibility cost at the sizes UI text is actually set in. The per-image
 * ceiling below is the backstop, not the target.
 */
const MAX_EDGE = 1600;
/** Under this, and already small enough, a PNG is sent as it is — sharper. */
const KEEP_AS_IS = 600_000;

const DRAFT_KEY = 'resumi9.feedback.draft';

interface Attached {
  file: File;
  url: string;
}

export default function FeedbackButton({ signedIn }: { signedIn: boolean }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>('bug');
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState('');
  const [shots, setShots] = useState<Attached[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentId, setSentId] = useState<string | null>(null);
  /** Set when the report was stored but its screenshots could not be. */
  const [shotsLost, setShotsLost] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  // `close`, not `setOpen(false)`: hiding the panel without clearing the
  // thank-you meant the next person to open it was greeted by a reference
  // number for a message they had already sent.
  useEscape(open, () => close());

  // What they had typed before, whether they closed the panel or the tab.
  // Wrapped because storage throws outright in a private window, and losing
  // the draft is a worse outcome than never having had it.
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null');
      if (!saved || typeof saved !== 'object') return;
      if (typeof saved.message === 'string') setMessage(saved.message);
      if (typeof saved.email === 'string') setEmail(saved.email);
      if (KINDS.includes(saved.kind)) setKind(saved.kind);
    } catch {
      /* no draft to restore */
    }
  }, []);

  useEffect(() => {
    try {
      if (message || email) localStorage.setItem(DRAFT_KEY, JSON.stringify({ kind, message, email }));
      else localStorage.removeItem(DRAFT_KEY);
    } catch {
      /* the draft is a convenience, not the record */
    }
  }, [kind, message, email]);

  useEffect(() => {
    if (open && !sentId) box.current?.focus();
  }, [open, sentId]);

  /*
   * Every thumbnail URL ever created, so they can be released on unmount.
   *
   * A ref rather than an effect keyed on `shots`: that effect's cleanup runs on
   * every change, and the array it closes over is the PREVIOUS one — so
   * attaching a second screenshot revoked the first one's URL and blanked a
   * thumbnail that was still on screen.
   */
  const madeUrls = useRef<string[]>([]);
  useEffect(() => () => madeUrls.current.forEach((url) => URL.revokeObjectURL(url)), []);

  /** ⌘ or Ctrl. Settled after mount, because the server cannot know which. */
  const [modifier, setModifier] = useState('Ctrl-');
  useEffect(() => {
    const platform = navigator.platform || navigator.userAgent;
    if (/Mac|iPhone|iPad/.test(platform)) setModifier('⌘');
  }, []);

  async function attach(files: File[]) {
    setError(null);
    const room = MAX_SHOTS - shots.length;
    if (room <= 0) {
      setError(`${MAX_SHOTS} screenshots is the limit.`);
      return;
    }
    const added: Attached[] = [];
    for (const file of files.slice(0, room)) {
      const shrunk = await shrink(file);
      if (!shrunk) {
        setError('That image could not be attached. A PNG or JPEG screenshot works.');
        continue;
      }
      const url = URL.createObjectURL(shrunk);
      madeUrls.current.push(url);
      added.push({ file: shrunk, url });
    }
    const all = [...shots, ...added];
    if (all.reduce((n, s) => n + s.file.size, 0) > MAX_TOTAL_BYTES) {
      added.forEach((s) => URL.revokeObjectURL(s.url));
      setError('Those come to too much together. Send one at a time.');
      return;
    }
    setShots(all);
  }

  function remove(index: number) {
    URL.revokeObjectURL(shots[index].url);
    setShots(shots.filter((_, i) => i !== index));
  }

  async function send() {
    setSending(true);
    setError(null);
    try {
      const body = new FormData();
      body.set('kind', kind);
      body.set('message', message);
      if (!signedIn && email.trim()) body.set('email', email.trim());
      body.set('pageUrl', window.location.href);
      body.set('viewport', `${window.innerWidth}x${window.innerHeight} @${window.devicePixelRatio || 1}x`);
      for (const shot of shots) body.append('shot', shot.file);

      const response = await fetch('/api/feedback', { method: 'POST', body });
      const data = (await response.json().catch(() => ({}))) as {
        id?: string;
        error?: string;
        shotsKept?: number;
        shotsSent?: number;
      };
      if (!response.ok || !data.id) {
        setError(data.error ?? 'That did not send. Your message is still here — try again.');
        return;
      }
      // Only now. Everything above this line leaves the draft alone.
      setShotsLost(Boolean(data.shotsSent) && data.shotsKept === 0);
      setSentId(data.id);
      shots.forEach((s) => URL.revokeObjectURL(s.url));
      setShots([]);
      setMessage('');
      setEmail('');
      try {
        localStorage.removeItem(DRAFT_KEY);
      } catch {
        /* nothing to clear */
      }
    } catch {
      setError('That did not send — check your connection. Your message is still here.');
    } finally {
      setSending(false);
    }
  }

  function close() {
    setOpen(false);
    // So the next open is a fresh form rather than a stale thank-you.
    setSentId(null);
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        // Below the takeover's z-50 on purpose: an import or a tailor owns the
        // whole window while it runs, and a button floating over it would be
        // the one thing you could press during something you cannot stop.
        className="fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded-full border border-rule-field bg-ground-surface px-4 py-2.5 text-[13px] text-ink-prose shadow-[0_1px_12px_rgba(26,24,21,0.10)] transition hover:text-ink hover:shadow-[0_2px_16px_rgba(26,24,21,0.14)]"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.9 9.9 0 0 1-4.1-.9L3 21l1.9-4.3A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4Z" />
        </svg>
        Feedback
      </button>
    );
  }

  return (
    <div
      role="dialog"
      aria-label="Send feedback"
      onPaste={(event) => {
        // The gesture that matters: somebody has just pressed the screenshot
        // shortcut and the image is on the clipboard, not on disk.
        const images = Array.from(event.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
        if (!images.length) return;
        event.preventDefault();
        void attach(images);
      }}
      className="fixed bottom-5 right-5 z-40 flex max-h-[calc(100vh-40px)] w-[calc(100vw-40px)] max-w-[380px] animate-[fadeIn_180ms_ease-out] flex-col overflow-hidden rounded-lg border border-rule bg-ground-surface shadow-[0_4px_28px_rgba(26,24,21,0.16)]"
    >
      <div className="flex shrink-0 items-center justify-between border-b border-rule-soft px-4 py-3">
        <span className="text-[13.5px] font-medium text-ink">
          {sentId ? 'Thanks — got it.' : 'Tell us what happened'}
        </span>
        <button
          type="button"
          onClick={close}
          aria-label="Close"
          className="-mr-1 rounded p-1 text-ink-faint transition hover:text-ink"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {sentId ? (
        <div className="px-4 py-5">
          <p className="text-[13.5px] leading-relaxed text-ink-prose">
            This landed with the page you were on and your browser, so it can be looked into without
            asking you for any of that.
          </p>
          {shotsLost ? (
            <p className="mt-3 rounded border border-flag-line bg-flag-bg px-3 py-2 text-[12.5px] leading-relaxed text-flag-ink">
              Your message is saved. There was no room left for the screenshots, so those were not
              kept — describe what they showed and it will still be clear enough.
            </p>
          ) : null}
          <p className="mt-3 text-[12.5px] text-ink-faint">
            Reference <span className="font-medium text-ink-muted">{sentId}</span>
          </p>
          <div className="mt-5 flex items-center gap-4">
            <button
              type="button"
              onClick={() => {
                setSentId(null);
                setShotsLost(false);
              }}
              className="rounded bg-accent px-4 py-2 text-[13px] font-medium text-ground transition hover:bg-accent-hover"
            >
              Send another
            </button>
            <button type="button" onClick={close} className="text-[13px] text-ink-muted transition hover:text-ink">
              Done
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            <div className="flex flex-wrap gap-1.5">
              {KINDS.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setKind(option)}
                  aria-pressed={kind === option}
                  className={`rounded-full border px-3 py-1 text-[12.5px] transition ${
                    kind === option
                      ? 'border-accent-line bg-accent-wash text-accent'
                      : 'border-rule-field text-ink-muted hover:text-ink'
                  }`}
                >
                  {KIND_LABELS[option]}
                </button>
              ))}
            </div>

            <textarea
              ref={box}
              id="feedback-message"
              value={message}
              maxLength={MAX_MESSAGE}
              onChange={(event) => setMessage(event.target.value)}
              rows={5}
              placeholder={
                kind === 'bug'
                  ? 'What you were doing, and what happened instead.'
                  : kind === 'confusing'
                    ? 'What you expected this to do.'
                    : 'Whatever it is.'
              }
              className="mt-3 w-full rounded-md border border-rule-field bg-ground px-3 py-2.5 text-[13.5px] leading-relaxed outline-none transition focus:border-accent-line"
            />

            {shots.length ? (
              <div className="mt-2.5 flex flex-wrap gap-2">
                {shots.map((shot, index) => (
                  <div key={shot.url} className="relative">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={shot.url}
                      alt=""
                      className="h-14 w-20 rounded border border-rule-field object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => remove(index)}
                      aria-label="Remove screenshot"
                      className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-rule-field bg-ground-surface text-ink-muted transition hover:text-ink"
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
                        <path d="M18 6 6 18M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            ) : null}

            <input
              ref={picker}
              type="file"
              accept="image/png,image/jpeg"
              multiple
              hidden
              onChange={(event) => {
                void attach(Array.from(event.target.files ?? []));
                event.target.value = '';
              }}
            />

            {shots.length < MAX_SHOTS ? (
              <button
                type="button"
                onClick={() => picker.current?.click()}
                className="mt-2.5 text-[12.5px] text-ink-muted underline decoration-rule-field underline-offset-4 transition hover:text-ink"
              >
                Attach a screenshot
              </button>
            ) : null}
            <p className="mt-1.5 text-[11.5px] text-ink-faint">
              Or press {modifier}V to paste one straight in.
            </p>

            {!signedIn ? (
              <input
                id="feedback-email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="Email, if you want an answer (optional)"
                className="mt-3 w-full rounded-md border border-rule-field bg-ground px-3 py-2 text-[13px] outline-none transition focus:border-accent-line"
              />
            ) : null}

            {error ? (
              <p className="mt-3 rounded border border-flag-line bg-flag-bg px-3 py-2 text-[12.5px] leading-relaxed text-flag-ink">
                {error}
              </p>
            ) : null}
          </div>

          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-rule-soft px-4 py-3">
            <span className="text-[11.5px] leading-tight text-ink-faint">
              Sends the page you are on and your window size. Nothing from your resume.
            </span>
            <button
              type="button"
              onClick={() => void send()}
              disabled={sending || message.trim().length < MIN_MESSAGE}
              className="shrink-0 rounded bg-accent px-4 py-2 text-[13px] font-medium text-ground transition hover:bg-accent-hover disabled:bg-ink-ghost"
            >
              {sending ? 'Sending…' : 'Send'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * A screenshot small enough to send.
 *
 * Scaled to a long edge of 1800px and re-encoded as JPEG, stepping the quality
 * down until it fits — at which point a retina screenshot of this app is a few
 * hundred kilobytes and its text is still readable. A PNG that is already
 * small and already within that is sent untouched, because UI text in a PNG is
 * sharper than the same text through a JPEG.
 *
 * Returns null when the image cannot be made to fit, which is the one case the
 * person has to be told about rather than quietly dropped.
 */
async function shrink(file: File): Promise<File | null> {
  if (!/^image\/(png|jpeg)$/.test(file.type)) return null;

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    // Can't read it to resize it. If it is already small enough, send it as it
    // came — the server checks the bytes' own header anyway.
    return file.size <= MAX_SHOT_BYTES ? file : null;
  }

  const longest = Math.max(bitmap.width, bitmap.height);
  if (file.size <= KEEP_AS_IS && longest <= MAX_EDGE) {
    bitmap.close();
    return file;
  }

  const scale = Math.min(1, MAX_EDGE / longest);
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) {
    bitmap.close();
    return file.size <= MAX_SHOT_BYTES ? file : null;
  }
  // White first. A JPEG has no transparency, and the default behind a
  // transparent PNG is black — which turns a screenshot with rounded corners
  // into one with black corners.
  context.fillStyle = '#FFFFFF';
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  for (const quality of [0.85, 0.75, 0.65, 0.5]) {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (blob && blob.size <= MAX_SHOT_BYTES) {
      const name = file.name.replace(/\.[^.]+$/, '') || 'screenshot';
      return new File([blob], `${name}.jpg`, { type: 'image/jpeg' });
    }
  }
  return null;
}
