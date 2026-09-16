'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Fact, InterviewPhase, InterviewQuestion, ProfileEntry } from '../../lib/types';

const PHASES: { key: InterviewPhase; label: string }[] = [
  { key: 'identity', label: 'About you' },
  { key: 'breadth', label: 'Your work' },
  { key: 'depth', label: 'The details' },
  { key: 'skills', label: 'Skills' },
];

const MAX_TURNS = 25;

interface TurnResponse {
  question: InterviewQuestion | null;
  acknowledgement: string;
  newFacts: Fact[];
  entries: ProfileEntry[];
  facts: Fact[];
  turnCount: number;
  coverage: number;
  phase: InterviewPhase;
  finished: boolean;
  finishReason: string;
}

/**
 * The conversation.
 *
 * There is no transcript on purpose. Its job — reassurance that something is
 * listening — is done better by the panel on the right, which shows what was
 * actually understood rather than what was typed, and doubles as the payoff.
 * The question is then the largest thing on the page, with nothing to scroll
 * past to reach it.
 */
export default function InterviewFlow({
  initial,
}: {
  initial: {
    question: InterviewQuestion | null;
    entries: ProfileEntry[];
    facts: Fact[];
    turnCount: number;
    coverage: number;
    phase: InterviewPhase;
  };
}) {
  const router = useRouter();
  const [question, setQuestion] = useState(initial.question);
  const [entries, setEntries] = useState(initial.entries);
  const [facts, setFacts] = useState(initial.facts);
  const [freshIds, setFreshIds] = useState<Set<string>>(new Set());
  const [turnCount, setTurnCount] = useState(initial.turnCount);
  const [coverage, setCoverage] = useState(initial.coverage);
  const [phase, setPhase] = useState(initial.phase);
  const [acknowledgement, setAcknowledgement] = useState('');
  const [draft, setDraft] = useState('');
  const [thinking, setThinking] = useState(false);
  const [finished, setFinished] = useState(false);
  const [finishReason, setFinishReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const textarea = useRef<HTMLTextAreaElement | null>(null);

  // Fetch a question whenever there is none to show, rather than only when no
  // session exists. A session can legitimately have no pending question — it was
  // just created, or a previous turn failed after saving but before storing the
  // next one — and keying off "has a session" left those hanging on a spinner
  // forever with no request in flight.
  //
  // The ref guard stays because React invokes effects twice in development, and
  // two opening turns means two questions asked and one answer lost.
  const openingAsked = useRef(false);
  useEffect(() => {
    if (openingAsked.current || question) return;
    openingAsked.current = true;
    void takeTurn(null, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!thinking) textarea.current?.focus();
  }, [thinking, question]);

  async function takeTurn(answer: string | null, skipped: boolean) {
    setThinking(true);
    setError(null);
    try {
      const response = await fetch('/api/interview/turn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer, skipped }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data?.error?.message ?? 'Something went wrong. Please try again.');
        return;
      }
      const result = data as TurnResponse;
      setQuestion(result.question);
      setEntries(result.entries);
      setFacts(result.facts);
      setFreshIds(new Set(result.newFacts.map((f) => f.id)));
      setTurnCount(result.turnCount);
      setCoverage(result.coverage);
      setPhase(result.phase);
      setAcknowledgement(result.acknowledgement);
      setDraft('');
      if (result.finished) {
        setFinished(true);
        setFinishReason(result.finishReason);
      }
    } catch {
      setError('Your internet connection dropped. Please check your connection.');
    } finally {
      setThinking(false);
    }
  }

  async function buildProfile() {
    setComposing(true);
    setError(null);
    try {
      const response = await fetch('/api/interview/compose', { method: 'POST' });
      const data = await response.json();
      if (!response.ok) {
        setError(data?.error?.message ?? "We couldn't build your profile. Please try again.");
        return;
      }
      router.push('/setup');
    } catch {
      setError('Your internet connection dropped. Please check your connection.');
    } finally {
      setComposing(false);
    }
  }

  const activePhase = PHASES.findIndex((p) => p.key === phase);
  const grouped = entries
    .map((entry) => ({ entry, own: facts.filter((f) => f.entryId === entry.id) }))
    .filter((g) => g.own.length > 0);
  const globals = facts.filter((f) => !f.entryId);

  return (
    <main className="flex h-screen flex-col overflow-hidden bg-ground font-sans text-ink">
      <div className="flex h-[68px] shrink-0 items-center justify-between border-b border-rule px-6 sm:px-10">
        <div className="flex items-center gap-8">
          <div className="flex items-center gap-2.5">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#2F5D50" strokeWidth="1.5" strokeLinecap="round">
              <path d="M12 3v18M3 12h18M6 6l12 12M18 6L6 18" />
            </svg>
            <span className="text-[12.5px] uppercase tracking-[0.16em] text-ink-prose">Resumi9</span>
          </div>
          <div className="hidden items-center gap-[18px] lg:flex">
            {PHASES.map((p, i) => (
              <div key={p.key} className="flex items-center gap-[7px]">
                <div className={`h-1.5 w-1.5 rounded-full ${i <= activePhase ? 'bg-accent' : 'bg-rule-field'}`} />
                <span className={`text-[13px] ${i === activePhase ? 'text-ink' : i < activePhase ? 'text-ink-muted' : 'text-ink-ghost'}`}>
                  {p.label}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-5">
          <div className="flex items-center gap-2.5">
            <div className="h-1 w-[76px] overflow-hidden rounded-sm bg-rule">
              <div className="h-full rounded-sm bg-accent transition-[width] duration-500" style={{ width: `${Math.round(coverage * 100)}%` }} />
            </div>
            <span className="text-[13px] text-ink-prose">{Math.round(coverage * 100)}%</span>
          </div>
          {!finished ? (
            <button
              type="button"
              onClick={() => { setFinished(true); setFinishReason('You ended it here.'); }}
              disabled={thinking}
              className="rounded border border-rule-field bg-ground-surface px-4 py-2 text-[13.5px] text-ink-prose transition hover:border-ink-faint disabled:opacity-50"
            >
              Finish here
            </button>
          ) : null}
        </div>
      </div>

      <div className="grid min-h-0 flex-grow grid-cols-1 lg:grid-cols-[minmax(0,1fr)_400px]">
        <div className="flex min-h-0 flex-col justify-center overflow-y-auto px-6 py-12 sm:px-14">
          <div className="max-w-[620px]">
            {finished ? (
              <>
                <span className="text-[11.5px] uppercase tracking-[0.14em] text-accent">All done</span>
                <h1 className="mt-4 font-serif text-[38px] leading-[1.1]">
                  {facts.length} things captured across {entries.length}{' '}
                  {entries.length === 1 ? 'entry' : 'entries'}
                </h1>
                <p className="mt-3 text-[15.5px] text-ink-prose">{finishReason}</p>
                <div className="mt-8 flex flex-wrap gap-3">
                  <button
                    type="button"
                    onClick={buildProfile}
                    disabled={composing}
                    className="rounded bg-accent px-6 py-3.5 font-medium text-ground transition hover:bg-accent-hover disabled:opacity-60"
                  >
                    {composing ? 'Building your profile…' : 'Build my resume profile'}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setFinished(false); void takeTurn(null, false); }}
                    disabled={composing}
                    className="rounded border border-rule-field bg-ground-surface px-6 py-3.5 text-ink-prose transition hover:border-ink-faint disabled:opacity-50"
                  >
                    Keep going
                  </button>
                </div>
              </>
            ) : thinking ? (
              <Thinking />
            ) : question ? (
              <>
                {acknowledgement ? (
                  <p className="font-serif text-[17px] italic leading-relaxed text-ink-muted">
                    {acknowledgement}
                  </p>
                ) : null}

                <h1 className="mt-[22px] font-serif text-[32px] leading-[1.14] tracking-[-0.01em] sm:text-[42px]">
                  {question.text}
                </h1>

                {question.why ? (
                  <div className="mt-4 flex items-center gap-2">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#A8A39B" strokeWidth="1.7" strokeLinecap="round">
                      <circle cx="12" cy="12" r="9" /><path d="M12 16v-4M12 8h.01" />
                    </svg>
                    <span className="text-[13.5px] text-ink-faint">{question.why}</span>
                  </div>
                ) : null}

                <div className="mt-7 overflow-hidden rounded-md border border-rule-field bg-ground-surface">
                  <textarea
                    ref={textarea}
                    rows={4}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        if (draft.trim()) void takeTurn(draft.trim(), false);
                      }
                    }}
                    placeholder="Type your answer…"
                    className="[field-sizing:content] max-h-[10lh] w-full resize-none px-5 py-5 text-base leading-relaxed text-ink outline-none placeholder:text-ink-ghost"
                  />
                  <div className="flex items-center justify-between border-t border-rule-soft bg-ground-panel/50 px-4 py-3">
                    <span className="hidden text-[12.5px] text-ink-faint sm:block">
                      Enter to send &middot; Shift + Enter for a new line
                    </span>
                    <div className="flex items-center gap-2.5">
                      {question.skippable ? (
                        <button
                          type="button"
                          onClick={() => void takeTurn('', true)}
                          className="px-3.5 py-2 text-[13.5px] text-ink-muted transition hover:text-ink"
                        >
                          Skip
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => draft.trim() && takeTurn(draft.trim(), false)}
                        disabled={!draft.trim()}
                        className="flex items-center gap-2 rounded bg-accent px-5 py-2.5 text-sm font-medium text-ground transition hover:bg-accent-hover disabled:bg-rule-field disabled:text-ink-ghost"
                      >
                        Send
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M5 12h14M13 6l6 6-6 6" />
                        </svg>
                      </button>
                    </div>
                  </div>
                </div>

                <p className="mt-5 text-[13.5px] text-ink-faint">
                  Question {turnCount + 1} &middot; usually done in about fifteen
                </p>
              </>
            ) : (
              <Thinking />
            )}

            {error ? <p className="mt-5 text-sm text-flag">{error}</p> : null}
          </div>
        </div>

        <aside className="flex min-h-0 flex-col gap-5 overflow-hidden border-t border-rule bg-ground-panel px-7 py-8 lg:border-l lg:border-t-0">
          <div className="flex items-baseline justify-between">
            <span className="text-[11px] uppercase tracking-[0.13em] text-ink-faint">Building your profile</span>
            <span className="text-[12.5px] text-ink-muted">{facts.length} details</span>
          </div>

          <div className="-mr-2 flex min-h-0 flex-grow flex-col gap-5 overflow-y-auto pr-2">
            {grouped.map(({ entry, own }) => (
              <div key={entry.id} className="flex flex-col gap-2.5">
                <div className="flex items-baseline justify-between gap-2.5">
                  <span className="text-sm text-ink">
                    {[entry.title, entry.org].filter(Boolean).join(' · ') || 'Untitled'}
                  </span>
                  {entry.datesDisplay ? (
                    <span className="whitespace-nowrap text-xs text-ink-ghost">{entry.datesDisplay}</span>
                  ) : null}
                </div>
                {own.map((f) => <FactChip key={f.id} fact={f} fresh={freshIds.has(f.id)} />)}
              </div>
            ))}

            {globals.length > 0 ? (
              <div className="flex flex-col gap-2.5">
                <span className="text-sm text-ink">About you</span>
                {globals.map((f) => <FactChip key={f.id} fact={f} fresh={freshIds.has(f.id)} />)}
              </div>
            ) : null}

            {facts.length === 0 ? (
              <p className="text-[13px] leading-relaxed text-ink-faint">
                What you tell us appears here, in your own words, as it is captured.
              </p>
            ) : null}
          </div>

          <div className="shrink-0 border-t border-rule pt-4">
            <span className="text-[12.5px] leading-relaxed text-ink-faint">
              Nothing here is written by us &mdash; it is what you said, kept in your words until
              the resume is built.
            </span>
          </div>
        </aside>
      </div>
    </main>
  );
}

function FactChip({ fact, fresh }: { fact: Fact; fresh: boolean }) {
  const weak = fact.category === 'metric' && !fact.hasNumber;
  return (
    <div
      className={`flex items-start gap-2.5 rounded border px-3 py-2.5 transition-colors duration-700 ${
        fresh ? 'border-accent-line bg-accent-wash' : weak ? 'border-flag-line bg-flag-bg' : 'border-rule bg-ground-surface'
      }`}
    >
      <span className={`shrink-0 pt-[3px] text-[9.5px] uppercase tracking-[0.1em] ${fresh ? 'text-accent' : 'text-ink-ghost'}`}>
        {fact.category}
      </span>
      <span className="min-w-0 flex-1 break-words text-[13.5px] leading-snug text-ink-prose">
        {fact.text}
      </span>
    </div>
  );
}

/**
 * The wait names its own work. Each turn takes several seconds because it
 * re-reads everything said so far, and a bare spinner for that long reads as
 * broken rather than busy.
 */
function Thinking() {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <div className="h-4 w-4 animate-spin rounded-full border-2 border-rule border-t-accent" />
        <span className="text-[15.5px] text-ink">Working out what to ask next</span>
      </div>
      <p className="font-serif text-[19px] italic leading-relaxed text-ink-ghost">
        Takes a few seconds &mdash; it is reading everything you have said so far, not just that
        answer.
      </p>
    </div>
  );
}
