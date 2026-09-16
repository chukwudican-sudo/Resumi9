'use client';

import { useEffect } from 'react';
import { useResumeUpload } from '../ResumeUpload';
import { IMPORT_STEPS } from '../../lib/waits';
import type { WaitControl } from './waitControl';
import { useConfirm } from '../undo/ConfirmProvider';

/**
 * "Upload a resume" at the foot of the rail.
 *
 * The reason it exists is a complaint about back: choosing "Fill it in myself"
 * on onboarding sent you here with no way to return and pick the other option.
 * Rather than teach the back control to sometimes mean "the choice you just
 * made", the choice stops being one you have to go back for.
 *
 * Quiet on purpose. Somebody who typed their resume in has no use for this, and
 * a second prominent upload button on a page full of their own writing reads as
 * the app suggesting they start again.
 */
export default function SetupUpload({
  disabled,
  imported,
  entryCount,
  sectionCount,
  hasSkills,
  onDone,
  wait,
}: {
  /** Held shut while a form is dirty, for the same reason "+ Add a section" is. */
  disabled: boolean;
  /**
   * Whether this profile already came from a file.
   *
   * The card exists to tell somebody typing their resume in that there is a
   * faster way. Shown to somebody who has already uploaded, it is the app
   * suggesting they start again — so it shrinks to a link, which is still the
   * only route back to a second import once onboarding has been passed.
   */
  imported: boolean;
  entryCount: number;
  sectionCount: number;
  hasSkills: boolean;
  onDone: () => void;
  /** The preview pane carries the wait — this card is far too small to. */
  wait: WaitControl;
}) {
  const ask = useConfirm();

  /**
   * What an import would destroy, in the person's own units.
   *
   * `replaceProfileFromResume` deletes every entry, section and fact in one
   * transaction — so this is the one control on the page where "are you sure"
   * carries a fact you genuinely cannot see: the file has not been read yet and
   * nothing on screen says the upload is a replacement rather than an addition.
   */
  const holds = [
    entryCount > 0 ? `${entryCount} ${entryCount === 1 ? 'entry' : 'entries'}` : null,
    sectionCount > 0 ? `${sectionCount} ${sectionCount === 1 ? 'section' : 'sections'}` : null,
    hasSkills ? 'your skills' : null,
  ].filter(Boolean) as string[];

  const upload = useResumeUpload({
    onDone,
    confirmBefore: holds.length
      ? () =>
          ask({
            title: 'Replace everything with this file?',
            body: `${holds.join(', ')} are removed and rebuilt from the resume you upload.`,
            action: 'Replace',
          })
      : // Nothing to lose. Asking would be the reflex click every confirm in
        // this app is written to avoid.
        undefined,
  });

  function start() {
    // Started before the picker opens, so the pane commits the moment the
    // gesture does — not thirty seconds later when bytes start moving.
    wait.start({
      title: 'Reading your resume.',
      steps: IMPORT_STEPS,
      estimate: 'Usually about thirty seconds.',
      // The window: this replaces every entry, section and fact. The rail
      // and the editor behind it are already gone.
      scope: 'window',
    });
    upload.pick();
  }

  const error = upload.error ? (
    <p className="pt-1.5 text-[12px] leading-snug text-flag">{upload.error}</p>
  ) : null;

  if (imported) {
    return (
      <div className="mt-4 hidden lg:block">
        <button
          type="button"
          onClick={start}
          disabled={disabled || upload.busy}
          className="text-[12.5px] text-accent transition hover:text-accent-hover disabled:opacity-40"
        >
          {upload.busy ? 'Reading your resume…' : 'Upload a different resume'}
        </button>
        {upload.input}
        {error}
      </div>
    );
  }

  return (
    // A card, not another row.
    //
    // This was a grey line directly under "+ Add a section", which made it read
    // as one more item in the list of sections rather than as an alternative to
    // filling the list in by hand. It borrows the treatment onboarding already
    // gives this exact choice — accent tint, accent border, the same icon, the
    // same "about 30 seconds" — so the two screens offer it in one voice.
    <div className="mt-4 hidden lg:block">
      <button
        type="button"
        onClick={start}
        disabled={disabled || upload.busy}
        className="flex w-full flex-col items-start gap-1.5 rounded-md border border-accent-line bg-accent-tint p-3.5 text-left transition hover:bg-accent-wash disabled:opacity-40 disabled:hover:bg-accent-tint"
      >
        <span className="flex items-center gap-2.5">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2F5D50" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <path d="M17 8l-5-5-5 5" />
            <path d="M12 3v13" />
          </svg>
          <span className="text-[13.5px] text-ink">
            {upload.busy ? 'Reading your resume…' : 'Upload a resume'}
          </span>
        </span>

        {/* The cost, stated the way onboarding states it. Somebody weighing this
            against typing wants the two numbers, not an adjective. */}
        {!upload.busy ? (
          <>
            {/* self-start, or a flex column stretches it into a full-width bar. */}
            <span className="self-start rounded-[3px] bg-accent-line px-1.5 py-0.5 text-[10.5px] text-accent">
              about 30 seconds
            </span>
            <span className="mt-0.5 text-[12px] leading-relaxed text-ink-prose">
              Faster than typing it in. We read it and fill this in for you.
            </span>
          </>
        ) : null}
      </button>

      {upload.input}
      {error}
    </div>
  );
}
