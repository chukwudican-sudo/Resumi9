'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { saveSectionContent } from '../../server/actions';
import { useUndo } from '../undo/UndoProvider';
import SectionHeading from './SectionHeading';

/**
 * A section that is one piece of writing — a summary, an objective, a profile.
 *
 * This is the editor a summary never had. Uploaded resumes carried one for as
 * long as the extractor has existed and it went straight into a derived blob
 * with no row behind it and nothing on screen to edit, so the first save or the
 * first Polish deleted it and the only evidence was a paragraph missing from
 * the preview.
 *
 * Deliberately plain. There is nothing here to structure, and the one thing
 * worth saying about a summary is how long it should be.
 */
export default function ProseSection({
  sectionKey,
  label,
  text,
  onSaved,
  onDirty,
}: {
  sectionKey: string;
  label: string;
  text: string;
  onSaved: () => void;
  onDirty: (dirty: boolean) => void;
}) {
  const [draft, setDraft] = useState(text);
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);
  const { offer, dismiss } = useUndo();

  /**
   * What is in the database right now, which is what Undo has to write back.
   *
   * Not the `text` prop on its own: that only catches up when the refresh after
   * a save lands, so saving twice in quick succession would offer the value
   * from two saves ago — the offer would revert the wrong step and silently
   * throw away what was just typed. Updated the moment a save goes out, and
   * re-synced from the prop whenever the server's answer changes.
   */
  const stored = useRef(text);
  useEffect(() => { stored.current = text; }, [text]);

  const words = draft.trim() ? draft.trim().split(/\s+/).length : 0;

  function save() {
    const before = stored.current;
    stored.current = draft;
    startTransition(async () => {
      await saveSectionContent(sectionKey, { text: draft });
      onDirty(false);
      setSaved(true);
      onSaved();
      offer({
        message: before.trim() && !draft.trim() ? `${label} cleared.` : `${label} saved.`,
        undo: async () => {
          stored.current = before;
          setDraft(before);
          await saveSectionContent(sectionKey, { text: before });
          onSaved();
        },
      });
    });
  }

  return (
    <div>
      <SectionHeading sectionKey={sectionKey} label={label} onRenamed={onSaved} />
      <p className="mt-2.5 text-[15px] leading-relaxed text-ink-prose">
        Three or four lines at the top of the page, in your own voice. A recruiter reads this
        first and then decides whether to read the rest, so it is worth being specific &mdash; what
        you build, what you are good at, what you are looking for.
      </p>

      <textarea
        value={draft}
        onChange={(e) => {
          // See SkillsSection.edit: an offer left over from the last save would
          // revert this typing along with it.
          dismiss();
          setDraft(e.target.value);
          setSaved(false);
          onDirty(true);
        }}
        rows={7}
        placeholder="Software engineer building full-stack products, strongest in TypeScript and Python&hellip;"
        className="[field-sizing:content] max-h-[20lh] mt-7 w-full resize-y rounded border border-rule-field bg-ground-surface px-3.5 py-3 text-[15px] leading-relaxed text-ink outline-none transition focus:border-accent"
      />

      <div className="mt-3 flex items-center justify-between">
        <span className="text-[12.5px] text-ink-faint">
          {/* A number, not a limit. Longer than this and it stops being a
              summary and starts competing with the entries underneath it. */}
          {words} {words === 1 ? 'word' : 'words'}
          {words > 90 ? ' — long for a summary' : ''}
        </span>

        <div className="flex items-center gap-3">
          {saved && !pending ? <span className="text-[12.5px] text-ink-faint">Saved</span> : null}
          <button
            type="button"
            onClick={save}
            disabled={pending}
            className="rounded bg-accent px-5 py-2.5 text-sm font-medium text-ground transition hover:bg-accent-hover disabled:opacity-50"
          >
            {pending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {/*
        Emptying it does not remove the section from the rail. Someone clearing
        the box to rewrite it should not have to find their way back to a
        section that vanished the moment it was blank; it simply stops printing.
      */}
      {!draft.trim() && text ? (
        <p className="mt-4 text-[12.5px] leading-relaxed text-ink-muted">
          Empty, so it will not print. The section stays here for when you want it.
        </p>
      ) : null}
    </div>
  );
}
