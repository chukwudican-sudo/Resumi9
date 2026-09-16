'use client';

import { MONTHS, formatDates, worksTowards, type DateParts } from '../../lib/entryFormat';

const THIS_YEAR = new Date().getFullYear();
// Far enough back for a career, far enough forward for a degree in progress.
const YEARS = Array.from({ length: 46 }, (_, i) => THIS_YEAR + 5 - i);

/**
 * When something happened, as parts rather than free text.
 *
 * Month is genuinely optional — "2022 – 2026" is how people write a degree, and
 * forcing a month there invents precision nobody has. Year is what actually
 * matters, so it is the field that carries the requirement.
 */
export default function DateRange({
  value,
  kind,
  onChange,
}: {
  value: DateParts;
  kind: string;
  onChange: (next: DateParts) => void;
}) {
  // A certificate you are studying for is not a job you still hold, and its
  // finish date is a date to enter rather than one to grey out.
  const towards = worksTowards(kind);
  /*
   * Said the way the section's own content would say it.
   *
   * Everything that was not education or a certificate fell through to "I still
   * work here", so a project in progress, an award, and somebody's own
   * Volunteering section all claimed employment. Experience is the only one
   * that is a job.
   */
  const currentLabel =
    kind === 'education'
      ? 'Still studying'
      : towards
        ? 'Still working towards it'
        : kind === 'experience'
          ? 'I still work here'
          : kind === 'projects'
            ? 'Still working on it'
            : 'Still ongoing';
  const preview = formatDates(value, kind);

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[13.5px] text-ink-prose">Dates</span>
        {preview ? (
          <span className="text-[12.5px] text-ink-faint">
            reads as <span className="text-ink-prose">{preview}</span>
          </span>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={value.startMonth}
          onChange={(v) => onChange({ ...value, startMonth: v })}
          placeholder="Month"
          options={MONTHS.map((m, i) => ({ value: i + 1, label: m }))}
        />
        <Select
          value={value.startYear}
          onChange={(v) => onChange({ ...value, startYear: v })}
          placeholder="Year"
          options={YEARS.map((y) => ({ value: y, label: String(y) }))}
          width="w-[96px]"
        />

        <span className="px-1 text-ink-faint">–</span>

        {value.isCurrent ? (
          <span className="rounded border border-rule-field bg-ground-band px-3.5 py-3 text-[14.5px] text-ink-muted">
            {towards ? 'Expected' : 'Present'}
          </span>
        ) : null}

        <Select
          value={value.endMonth}
          onChange={(v) => onChange({ ...value, endMonth: v })}
          placeholder="Month"
          options={MONTHS.map((m, i) => ({ value: i + 1, label: m }))}
          disabled={value.isCurrent && !towards}
        />
        <Select
          value={value.endYear}
          onChange={(v) => onChange({ ...value, endYear: v })}
          placeholder="Year"
          options={YEARS.map((y) => ({ value: y, label: String(y) }))}
          width="w-[96px]"
          disabled={value.isCurrent && !towards}
        />
      </div>

      <label className="flex w-fit cursor-pointer items-center gap-2.5">
        <input
          type="checkbox"
          checked={value.isCurrent}
          onChange={(e) => onChange({ ...value, isCurrent: e.target.checked })}
          className="h-4 w-4 accent-[#2F5D50]"
        />
        <span className="text-[13.5px] text-ink-prose">{currentLabel}</span>
      </label>
    </div>
  );
}

function Select({
  value, onChange, placeholder, options, width = 'w-[120px]', disabled,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  placeholder: string;
  options: { value: number; label: string }[];
  width?: string;
  disabled?: boolean;
}) {
  return (
    <select
      value={value ?? ''}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
      className={`${width} rounded border border-rule-field bg-ground-surface px-3 py-3 text-[14.5px] outline-none transition focus:border-accent disabled:bg-ground-band disabled:text-ink-ghost ${
        value ? 'text-ink' : 'text-ink-ghost'
      }`}
    >
      <option value="">{placeholder}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value} className="text-ink">
          {o.label}
        </option>
      ))}
    </select>
  );
}
