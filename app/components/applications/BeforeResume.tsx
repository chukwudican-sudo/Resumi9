'use client';

import type { ReactNode } from 'react';
import Stages from '../Stages';
import { REASSURE, TAILOR_STEPS } from '../../lib/waits';
import type { RequirementMatch } from '../../lib/requirementMatch';

/** The shape of a resume page, for the one that does not exist yet. */
const PAGE_SECTIONS: number[][] = [
  [94, 86],
  [90, 96, 78, 88],
  [92, 84, 70],
];

/** Where "What changed" will be, drawn faint so it reads as not-yet. */
const LOG_LINES: number[][] = [
  [94, 70],
  [88, 62],
  [90, 48],
];

/**
 * What this screen is for at this moment. Only the middle panel changes.
 */
export type BeforeResumeState =
  | { kind: 'writing' }
  | {
      kind: 'failed';
      /** What the server said went wrong, in its own words. */
      message: string;
      /** Whether the credit came back. Only claimed when the server says so. */
      creditKept: boolean;
      onRetry: () => void;
    }
  | { kind: 'ready'; onStart: () => void };

/**
 * The application page before there is a resume on it.
 *
 * **Same three columns as the finished page, in the same places,** so when the
 * resume lands the screen fills in rather than being swapped for another: the
 * change log on the left, the page in the middle, what you act on at the right.
 *
 * What the posting asks for is already known — it was read before tailoring
 * started — so it is on screen throughout, instead of a loading screen with
 * nothing on it.
 *
 * **It covers failing, too, and that is why it exists in this shape.** A failed
 * tailor used to drop people onto a separate "Ready when you are." page, which
 * is the page this app decided not to have: you land somewhere you were not,
 * your match is gone, and the only sign anything went wrong is a line of small
 * text under a button that starts the whole thing over. One tester pressed it
 * five times in three minutes. Failing now changes this middle panel and leaves
 * the rest of the screen exactly where it was.
 *
 * **Nothing on the right can be pressed.** The composer is drawn, not live — it
 * is the control that will be there — because every action on this page acts on
 * a resume that does not exist yet.
 */
export default function BeforeResume({
  match,
  state,
}: {
  match: RequirementMatch;
  state: BeforeResumeState;
}) {
  const total = match.have.length + match.missing.length;

  let middle: ReactNode;
  if (state.kind === 'writing') {
    middle = (
      <div className="w-full max-w-[420px] rounded-md border border-rule bg-ground-surface px-5 pb-3 pt-5">
        <h1 className="font-serif text-[26px] leading-[1.1]">Writing your resume for this one.</h1>
        <div className="mt-3">
          <Stages steps={TAILOR_STEPS} done={false} reassure={REASSURE} />
        </div>
      </div>
    );
  } else if (state.kind === 'failed') {
    middle = (
      <div className="w-full max-w-[420px] rounded-md border border-rule bg-ground-surface px-5 py-5" role="status">
        <h1 className="font-serif text-[26px] leading-[1.1]">That didn&rsquo;t work.</h1>
        <p className="mt-2.5 text-[13.5px] leading-relaxed text-ink-prose">{state.message}</p>
        {/*
          Claimed only when the server says it happened. Every failure after the
          spend refunds, but running out of credits and an unbuilt profile are
          refused before anything is spent — and telling somebody their credit
          came back when it never left is the kind of small lie that costs trust
          in everything else on the page.
        */}
        {state.creditKept ? (
          <p className="mt-2.5 flex items-center gap-2 text-[13.5px] text-ink">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#2F5D50" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M20 6L9 17l-5-5" />
            </svg>
            Your credit wasn&rsquo;t used.
          </p>
        ) : null}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <button
            type="button"
            onClick={state.onRetry}
            className="rounded bg-accent px-5 py-2.5 text-[13.5px] font-medium text-ground transition hover:bg-accent-hover"
          >
            Try again
          </button>
          <span className="text-[12px] text-ink-muted">Usually about thirty seconds.</span>
        </div>
      </div>
    );
  } else {
    middle = (
      <div className="w-full max-w-[420px] rounded-md border border-rule bg-ground-surface px-5 py-5">
        <h1 className="font-serif text-[26px] leading-[1.1]">Write your resume for this one.</h1>
        <p className="mt-2.5 text-[13.5px] leading-relaxed text-ink-prose">
          Your match is already on the right. Tailoring rewrites your profile around this job,
          keeping everything true.
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <button
            type="button"
            onClick={state.onStart}
            className="rounded bg-accent px-5 py-2.5 text-[13.5px] font-medium text-ground transition hover:bg-accent-hover"
          >
            Tailor my resume
          </button>
          <span className="text-[12px] text-ink-muted">Uses 1 credit &middot; about thirty seconds</span>
        </div>
      </div>
    );
  }

  return (
    <div className="grid min-h-0 flex-grow grid-cols-1 overflow-y-auto lg:grid-cols-[320px_minmax(0,1fr)_440px] lg:overflow-hidden">
      <div className="order-3 flex min-h-0 flex-col border-t border-rule bg-ground px-5 py-5 lg:order-none lg:border-r lg:border-t-0">
        <span className="text-[10.5px] uppercase tracking-[0.12em] text-ink-faint">What changed</span>
        <p className="mt-3 text-[12.5px] leading-relaxed text-ink-faint">
          Listed here as soon as your resume is written.
        </p>
        <div aria-hidden="true" className="mt-5 flex flex-col gap-4">
          {LOG_LINES.map((widths, i) => (
            <div key={i} className="flex flex-col gap-1.5 border-l-2 border-rule-soft pl-3">
              {widths.map((w, j) => (
                <div key={j} className="h-1.5 rounded bg-rule-soft" style={{ width: `${w}%` }} />
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className="order-1 flex flex-col items-center gap-4 bg-ground-band px-6 py-7 lg:order-none lg:overflow-y-auto">
        {middle}

        {/*
          The page that is coming. It pulses only while something is actually
          being written — a skeleton still shimmering under "That didn't work"
          would be the screen contradicting itself.
        */}
        <div
          aria-hidden="true"
          className={`flex aspect-[8.5/11] w-full max-w-[420px] flex-col gap-2.5 border border-rule-field bg-ground-surface px-9 py-8 ${
            state.kind === 'writing' ? 'animate-pulse motion-reduce:animate-none' : 'opacity-60'
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
      </div>

      <aside className="order-2 flex flex-col gap-4 border-t border-rule px-5 py-5 lg:order-none lg:overflow-y-auto lg:border-l lg:border-t-0">
        {total > 0 ? (
          <div className="rounded-md border border-rule p-[18px]">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[11px] uppercase tracking-[0.12em] text-ink-faint">What they ask for</span>
              <div className="flex items-baseline gap-1.5">
                <span className="font-serif text-[30px] leading-none tabular-nums">{match.have.length}</span>
                <span className="text-[13px] text-ink-faint">of {total} on your resume</span>
              </div>
            </div>
            <div className="mt-3 h-1 overflow-hidden rounded-sm bg-rule">
              <div className="h-full rounded-sm bg-accent" style={{ width: `${(match.have.length / total) * 100}%` }} />
            </div>

            {match.have.length > 0 ? (
              <div className="mt-5">
                <span className="text-[11px] uppercase tracking-[0.12em] text-ink-faint">Already on your resume</span>
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {match.have.map((r) => (
                    <span key={r} className="rounded-[3px] bg-accent-wash px-2.5 py-1 text-xs text-accent">
                      &#10003; {r}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}

            {match.missing.length > 0 ? (
              <div className="mt-5">
                <span className="text-[11px] uppercase tracking-[0.12em] text-ink-faint">Not found on your resume</span>
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {match.missing.map((r) => (
                    <span key={r} className="rounded-[3px] bg-flag-wash px-2.5 py-1 text-xs text-flag-ink">
                      {r}
                    </span>
                  ))}
                </div>
                {/* Said at the moment it could look like the tailor's job to fill these in. */}
                <p className="mt-3 text-[12px] leading-relaxed text-ink-muted">
                  Tailoring only works with what&rsquo;s true, so it won&rsquo;t add these for you.
                </p>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="rounded-md border border-rule p-[18px]">
            <span className="text-[11px] uppercase tracking-[0.12em] text-ink-faint">What they ask for</span>
            <p className="mt-2.5 text-[13px] leading-relaxed text-ink-prose">
              This posting didn&rsquo;t name specific skills, so there&rsquo;s nothing to check your resume against.
            </p>
          </div>
        )}

        <div aria-hidden="true" className="rounded-md border border-accent-line bg-accent-tint p-[15px] opacity-60">
          <span className="text-[11px] uppercase tracking-[0.12em] text-ink-faint">Change something</span>
          <div className="mt-2.5 rounded border border-rule-field bg-ground-surface px-3 py-2.5 text-[13.5px] text-ink-ghost">
            Make the FraudWatch bullets shorter&hellip;
          </div>
          <span className="mt-2.5 block text-[12px] text-ink-muted">Ready when your resume is.</span>
        </div>
      </aside>
    </div>
  );
}
