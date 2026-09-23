/** The shape of a resume page, for one that is not on screen yet. */
const PAGE_SECTIONS: number[][] = [
  [94, 86],
  [90, 96, 78, 88],
  [92, 84, 70],
];

/**
 * A sheet of paper with nothing readable on it.
 *
 * Shown wherever a resume is being written or rewritten, so the column keeps
 * the shape it will have rather than going empty for twenty seconds. Shared by
 * the wait before a resume exists and the wait over an edit, because two
 * drawings of the same thing drift.
 *
 * It pulses only while something is actually being written: a skeleton still
 * shimmering under "That didn't work" is a screen contradicting itself.
 */
export default function PageOutline({ pulse = true }: { pulse?: boolean }) {
  return (
    <div
      aria-hidden="true"
      className={`flex aspect-[8.5/11] w-full max-w-[420px] flex-col gap-2.5 border border-rule-field bg-ground-surface px-9 py-8 ${
        pulse ? 'animate-pulse motion-reduce:animate-none' : 'opacity-60'
      }`}
    >
      <div className="mx-auto h-2.5 w-[46%] rounded bg-rule" />
      <div className="mx-auto h-1.5 w-[62%] rounded bg-rule-soft" />
      {PAGE_SECTIONS.map((lines, i) => (
        <div key={i} className="mt-3 flex flex-col gap-2">
          <div className="h-1.5 w-[22%] rounded bg-rule-field" />
          {lines.map((w, j) => (
            <div key={j} className="h-1.5 rounded bg-rule" style={{ width: `${w}%` }} />
          ))}
        </div>
      ))}
    </div>
  );
}
