'use client';

import { useEffect, useRef } from 'react';

/**
 * One screenshot, opened the way every application opens a picture.
 *
 * A dimmed backdrop, the image at its own proportions in the middle, and a
 * cross. Not a new tab stretched to the width of a monitor, which is what a
 * plain link to the bytes does: a 1702px screenshot filling a 3420px display
 * is bigger than it was taken at and harder to read than the thumbnail.
 *
 * Three ways out, because one is never enough: the cross, the backdrop, and
 * Escape. The guidance here is unusually consistent — a backdrop click must
 * never be the only exit, since a keyboard user cannot perform one, and a
 * visible close control must always be present. Clicks that land ON the image
 * are ignored, so nobody dismisses it by trying to look closer.
 *
 * Focus moves to the cross when it opens and returns to the thumbnail that
 * opened it when it closes — otherwise the keyboard is left at the top of the
 * document and the reader has to find their place again. Tab cycles between
 * the two controls rather than wandering behind the backdrop.
 */
export default function Lightbox({
  src,
  caption,
  onClose,
  returnFocusTo,
}: {
  src: string;
  caption: string;
  onClose: () => void;
  returnFocusTo: HTMLElement | null;
}) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    closeButton.current?.focus();
    const previous = returnFocusTo;
    return () => previous?.focus();
  }, [returnFocusTo]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      // A trap rather than a hint: without it Tab walks off into the page
      // behind a backdrop nobody can see past, which is the single most
      // common way a lightbox strands a keyboard.
      const focusable = panel.current?.querySelectorAll<HTMLElement>('button, a[href]');
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    // The page behind must not scroll while this is up.
    const had = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = had;
    };
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={caption}
      onClick={onClose}
      className="fixed inset-0 z-[60] flex animate-[fadeIn_180ms_ease-out] items-center justify-center bg-[rgba(20,18,16,0.90)] p-6 sm:p-10"
    >
      <div
        ref={panel}
        // Clicks on the picture are for looking at the picture.
        onClick={(event) => event.stopPropagation()}
        className="flex max-h-full max-w-full flex-col items-center gap-3"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={caption}
          className="max-h-[80vh] max-w-full rounded-md bg-ground-surface object-contain shadow-[0_8px_40px_rgba(0,0,0,0.45)]"
        />
        <a
          href={src}
          target="_blank"
          rel="noreferrer"
          className="text-[12.5px] text-ground/80 underline decoration-ground/30 underline-offset-4 transition hover:text-ground"
        >
          Open the original
        </a>
      </div>

      <button
        ref={closeButton}
        type="button"
        onClick={onClose}
        aria-label="Close image"
        className="absolute right-5 top-5 flex h-10 w-10 items-center justify-center rounded-full bg-[rgba(255,255,255,0.12)] text-ground transition hover:bg-[rgba(255,255,255,0.22)] focus:outline-none focus-visible:ring-2 focus-visible:ring-ground"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
