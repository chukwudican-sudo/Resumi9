'use client';

import { useState, useTransition } from 'react';
import { removeEntry, saveEntry, type EntryInput } from '../../server/actions';
import { useUndo } from '../undo/UndoProvider';
import { useConfirm } from '../undo/ConfirmProvider';
import { useEscape } from '../useEscape';
import { isLink } from '../../lib/contactValidation';
import { CREDENTIALS } from '../../lib/degree';
import type { DateParts, PlaceParts } from '../../lib/entryFormat';
import DateRange from './DateRange';
import PlaceFields from './PlaceFields';

/**
 * Which section an entry belongs to.
 *
 * A string rather than the three the app started with: an entry can belong to a
 * section this person's own resume had — 'volunteering', 'extracurricular' —
 * and the branches below that ask `kind === 'education'` are simply false for
 * it, which leaves exactly the generic fields such an entry wants.
 */
export type Kind = string;

export interface EditableEntry extends EntryInput {
  dates: DateParts;
  place: PlaceParts;
  url: string;
  extra: Record<string, string>;
}

export function blankEntry(kind: Kind): EditableEntry {
  return {
    id: null, kind, title: '', org: '', location: '', datesDisplay: '', tech: '',
    bullets: [''],
    dates: { startMonth: null, startYear: null, endMonth: null, endYear: null, isCurrent: false },
    place: { city: null, region: null, country: null },
    url: '',
    extra: {},
  };
}

/**
 * The wording for one section's form.
 *
 * The fields are the same everywhere on purpose — five shapes, no bespoke
 * sections — but the WORDS are not, and using one section's words on another
 * makes the form read as nonsense. A certification asked "What you did" under a
 * placeholder about payment pipelines, and offered a Location box with no hint
 * that it is there for a licence's issuing state.
 */
interface Copy {
  /** The form's heading when adding a new one. */
  addLabel: string;
  titleLabel: string;
  orgLabel: string;
  titlePlaceholder: string;
  orgPlaceholder: string;
  placeLabel: string;
  linesLabel: string;
  linesBlurb: string;
  linesPlaceholder: string;
}

const LINES_BLURB =
  'One line each, in your own words. Write them plainly \u2014 tailoring rewrites them for each job, and the questions push for numbers once you have a posting.';

const COPY: Record<string, Copy> = {
  experience: {
    addLabel: 'Add a job',
    titleLabel: 'Job title', orgLabel: 'Company',
    titlePlaceholder: 'Backend Engineering Intern', orgPlaceholder: 'Northbound',
    placeLabel: 'Location',
    linesLabel: 'What you did',
    linesBlurb: LINES_BLURB,
    linesPlaceholder: 'Rebuilt the payment retry pipeline so failed charges were retried automatically',
  },
  education: {
    addLabel: 'Add education',
    titleLabel: 'Field of study', orgLabel: 'School',
    titlePlaceholder: 'Software Engineering', orgPlaceholder: 'Ontario Tech University',
    placeLabel: 'Location',
    linesLabel: 'Coursework, honours, anything worth naming',
    linesBlurb:
      'Relevant coursework is worth listing while you are still studying \u2014 it is often the most relevant thing you have.',
    linesPlaceholder: 'Relevant Coursework: Data Structures, Algorithms, Operating Systems',
  },
  project: {
    addLabel: 'Add a project',
    titleLabel: 'Project name', orgLabel: 'Context',
    titlePlaceholder: 'Resumi', orgPlaceholder: 'Personal project',
    placeLabel: 'Location',
    linesLabel: 'What you did',
    linesBlurb: LINES_BLURB,
    linesPlaceholder: 'Rebuilt the payment retry pipeline so failed charges were retried automatically',
  },
  awards: {
    addLabel: 'Add an award',
    titleLabel: 'Award', orgLabel: 'Awarded by',
    titlePlaceholder: "Dean's Honour List", orgPlaceholder: 'Ontario Tech University',
    placeLabel: 'Where it was awarded',
    linesLabel: 'Details',
    linesBlurb: 'What it was for, if the name does not already say. Most awards need none.',
    linesPlaceholder: 'Top 5% of the faculty, awarded each term',
  },
  certifications: {
    addLabel: 'Add a certification',
    titleLabel: 'Certification', orgLabel: 'Issuer',
    titlePlaceholder: 'AWS Certified Cloud Practitioner', orgPlaceholder: 'Amazon Web Services',
    // Kept, and named for the one case it serves: a nursing, teaching or trades
    // licence is expected to carry the state that issued it. A certificate
    // needs none of this, which is what "optional" is for.
    placeLabel: 'Where it was issued',
    linesLabel: 'Details',
    linesBlurb: 'A credential ID, a score, anything worth adding. Most certificates need none of this.',
    linesPlaceholder: 'Credential ID 0000000',
  },
};

/**
 * Field labels for a section the app has no copy written for.
 *
 * The table above holds three keys and `Kind` is a string, so every lookup in
 * it type-checks and any unfamiliar section returned undefined — and the next
 * line read `.titleLabel` off it. That crashed the editor for a section
 * imported from somebody's own resume, on Edit and on Add alike, which made the
 * whole section read-only. The same fallback exists in EntrySection; this is
 * its second table, for the fields rather than the headings.
 */
function copyFor(kind: Kind): Copy {
  return (
    COPY[kind] ?? {
      addLabel: 'Add an entry',
      titleLabel: 'Title',
      orgLabel: 'Organisation',
      titlePlaceholder: 'Team Lead',
      orgPlaceholder: 'Hack the North',
      placeLabel: 'Location',
      linesLabel: 'What you did',
      linesBlurb: LINES_BLURB,
      linesPlaceholder: 'Led a team of four through a two-week build',
    }
  );
}

/**
 * One entry, with the fields that section actually needs.
 *
 * Required is only what a resume genuinely cannot print without — a title, and
 * a year so entries can be ordered. Everything else is marked optional and
 * means it, because a form that calls a field optional and then refuses to save
 * is worse than one that never offered the choice.
 */
export default function EntryEditor({
  kind,
  entry,
  onSaved,
  onCancel,
}: {
  kind: Kind;
  entry: EditableEntry;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const copy = copyFor(kind);
  const [draft, setDraft] = useState(entry);
  const [pending, startTransition] = useTransition();
  const { offer } = useUndo();
  const ask = useConfirm();

  // The same question the contact form asks of its link fields, so a link is
  // judged the same way wherever it is typed.
  const urlProblem = draft.url.trim() && !isLink(draft.url) ? 'That does not look like a link.' : null;
  const canSave = draft.title.trim().length > 0 && !urlProblem;

  /**
   * Leaving without saving, from the button or from the key.
   *
   * One function so the two cannot diverge. An Escape that skipped the question
   * would be a faster way to lose an afternoon's typing than the button it sits
   * beside — the opposite of what a way out is for.
   */
  async function cancel() {
    // Asking only when something actually changed keeps it out of the way of
    // opening an entry, looking at it, and closing it again.
    const changed = JSON.stringify(draft) !== JSON.stringify(entry);
    if (changed) {
      const ok = await ask({
        title: 'Discard these changes?',
        body: 'Nothing you have typed here has been saved yet.',
        action: 'Discard',
      });
      if (!ok) return;
    }
    onCancel();
  }

  // Always on: this editor replaces the whole centre column, and on a new entry
  // with an empty title the Save button is disabled — so Cancel was the single
  // exit from a full-screen form.
  useEscape(true, () => void cancel());

  function save() {
    // The entry as it was when this form opened. For an edit that IS the undo —
    // saving it again writes the old values back over the new ones. For a new
    // entry there is nothing to write back, so undoing means removing the row.
    const before = entry;
    startTransition(async () => {
      const id = await saveEntry({
        ...draft,
        kind,
        bullets: draft.bullets.map((b) => b.trim()).filter(Boolean),
      });
      onSaved();
      const name = draft.title.trim() || 'Entry';
      offer(
        before.id
          ? {
              message: `${name} saved.`,
              undo: async () => {
                await saveEntry({ ...before, kind });
                onSaved();
              },
            }
          : {
              message: `${name} added.`,
              undo: async () => {
                await removeEntry(id);
                onSaved();
              },
            },
      );
    });
  }

  const setExtra = (key: string, value: string) =>
    setDraft({ ...draft, extra: { ...draft.extra, [key]: value } });

  /**
   * Taking a bullet out, with a way back.
   *
   * A bullet is a sentence somebody wrote and rewrote, and the × sits directly
   * beside the box holding it. Nothing is saved until Save, which does not help
   * at all once the words are off the screen.
   */
  function removeBullet(i: number) {
    const line = draft.bullets[i];
    setDraft({ ...draft, bullets: draft.bullets.filter((_, j) => j !== i) });
    offer({
      message: line.trim() ? `${line.trim()} removed.` : 'Empty line removed.',
      // The one bullet, back at its own position — not the list as it was, which
      // would discard anything typed into the other boxes since.
      undo: () =>
        setDraft((d) => ({ ...d, bullets: [...d.bullets.slice(0, i), line, ...d.bullets.slice(i)] })),
    });
  }

  return (
    <div>
      <h1 className="font-serif text-[34px] leading-tight">
        {draft.id ? 'Edit' : copy.addLabel}
      </h1>

      <div className="mt-7 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field
          label={copy.titleLabel}
          value={draft.title}
          onChange={(v) => setDraft({ ...draft, title: v })}
          placeholder={copy.titlePlaceholder}
        />
        <Field
          label={copy.orgLabel}
          optional={kind === 'project'}
          value={draft.org}
          onChange={(v) => setDraft({ ...draft, org: v })}
          placeholder={copy.orgPlaceholder}
        />
      </div>

      <div className="mt-6">
        <DateRange value={draft.dates} kind={kind} onChange={(dates) => setDraft({ ...draft, dates })} />
      </div>

      <div className="mt-6">
        <PlaceFields label={copy.placeLabel} value={draft.place} onChange={(place) => setDraft({ ...draft, place })} />
      </div>

      {/* Fields that only make sense for one kind. */}
      {kind === 'project' ? (
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            label="Built with" optional
            value={draft.tech}
            onChange={(v) => setDraft({ ...draft, tech: v })}
            placeholder="Next.js, TypeScript, Postgres"
          />
          <Field
            label="Link" optional
            value={draft.url}
            onChange={(v) => setDraft({ ...draft, url: v })}
            placeholder="github.com/you/project"
            problem={urlProblem}
          />
        </div>
      ) : null}

      {kind === 'education' ? (
        <div className="mt-6">
          <span className="text-[13.5px] text-ink-prose">Credential</span>
          <p className="mt-1 text-[13px] leading-snug text-ink-faint">
            Written out in full on a resume &mdash; &ldquo;Bachelor of Engineering in Software
            Engineering&rdquo;, not &ldquo;Software Engineering&rdquo; on its own.
          </p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            {CREDENTIALS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setExtra('credential', draft.extra.credential === c ? '' : c)}
                className={`rounded-full border px-3.5 py-1.5 text-[13px] transition ${
                  draft.extra.credential === c
                    ? 'border-accent bg-accent-tint text-accent'
                    : 'border-rule-field text-ink-muted hover:border-ink-faint'
                }`}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {kind === 'education' ? (
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            label="GPA" optional
            value={draft.extra.gpa ?? ''}
            onChange={(v) => setExtra('gpa', v)}
            placeholder="3.8 / 4.0"
            hint="only if it helps you"
          />
          <Field
            label="Honours or awards" optional
            value={draft.extra.honours ?? ''}
            onChange={(v) => setExtra('honours', v)}
            placeholder="Dean's List"
          />
        </div>
      ) : null}

      {kind === 'experience' ? (
        <div className="mt-6">
          <span className="text-[13.5px] text-ink-prose">
            Type of role <span className="text-ink-faint">optional</span>
          </span>
          <div className="mt-2.5 flex flex-wrap gap-2">
            {['Internship', 'Full-time', 'Part-time', 'Contract', 'Volunteer'].map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setExtra('employment', draft.extra.employment === t ? '' : t)}
                className={`rounded-full border px-3.5 py-1.5 text-[13px] transition ${
                  draft.extra.employment === t
                    ? 'border-accent bg-accent-tint text-accent'
                    : 'border-rule-field text-ink-muted hover:border-ink-faint'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="mt-7">
          <span className="text-[13.5px] text-ink-prose">{copy.linesLabel}</span>
          <p className="mt-1 text-[13px] leading-snug text-ink-faint">{copy.linesBlurb}</p>
          <div className="mt-3 flex flex-col gap-2.5">
            {draft.bullets.map((b, i) => (
              <div key={i} className="flex items-start gap-2">
                <span className="pt-3.5 text-ink-ghost">&bull;</span>
                <textarea
                  rows={2}
                  value={b}
                  onChange={(e) => {
                    const next = [...draft.bullets];
                    next[i] = e.target.value;
                    setDraft({ ...draft, bullets: next });
                  }}
                  placeholder={copy.linesPlaceholder}
                  className="[field-sizing:content] max-h-[10lh] w-full resize-none rounded border border-rule-field bg-ground-surface px-3.5 py-2.5 text-[14.5px] leading-relaxed outline-none transition placeholder:text-ink-ghost focus:border-accent"
                />
                {draft.bullets.length > 1 ? (
                  <button
                    type="button"
                    onClick={() => removeBullet(i)}
                    className="pt-3 text-ink-ghost transition hover:text-flag"
                    aria-label="Remove line"
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                      <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                  </button>
                ) : null}
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setDraft({ ...draft, bullets: [...draft.bullets, ''] })}
            className="mt-3 text-[13.5px] text-accent transition hover:text-accent-hover"
          >
            + Add another line
          </button>

          {/*
            Advice about writing, shown on every entry whatever state it is in
            — never a remark about this one. The same guidance used to arrive as
            a warning on a page that could not edit anything; here it sits above
            the field that answers it.
          */}
          {kind !== 'education' ? (
            <p className="mt-4 text-[12.5px] leading-relaxed text-ink-muted">
              A number &mdash; a percentage, a count, time saved &mdash; tends to land harder than
              describing the duty.
            </p>
          ) : null}
      </div>

      <div className="mt-8 flex items-center justify-between border-t border-rule pt-6">
        <button
          type="button"
          onClick={() => void cancel()}
          disabled={pending}
          className="text-sm text-ink-muted transition hover:text-ink disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={save}
          disabled={pending || !canSave}
          className="rounded bg-accent px-6 py-3 text-sm font-medium text-ground transition hover:bg-accent-hover disabled:bg-rule-field disabled:text-ink-ghost"
        >
          {pending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

function Field({
  label, value, onChange, placeholder, optional, hint, problem,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  optional?: boolean;
  hint?: string;
  /** Shown beneath, once the field has been left. */
  problem?: string | null;
}) {
  const [touched, setTouched] = useState(false);
  const visible = touched ? problem : null;

  return (
    <label className="flex flex-col gap-2">
      <span className="text-[13.5px] text-ink-prose">
        {label} {optional ? <span className="text-ink-faint">optional</span> : null}
        {hint ? <span className="text-ink-faint"> &mdash; {hint}</span> : null}
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          if (touched) setTouched(false);
        }}
        onBlur={() => setTouched(true)}
        placeholder={placeholder}
        aria-invalid={visible ? true : undefined}
        className={`w-full rounded border bg-ground-surface px-4 py-3 text-[15px] outline-none transition placeholder:text-ink-ghost ${
          visible ? 'border-flag focus:border-flag' : 'border-rule-field focus:border-accent'
        }`}
      />
      {visible ? <span className="text-[12.5px] leading-snug text-flag">{visible}</span> : null}
    </label>
  );
}
