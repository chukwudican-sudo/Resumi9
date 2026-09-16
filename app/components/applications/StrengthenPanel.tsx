'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Spinner from '../Spinner';

interface JobQuestion {
  text: string;
  why: string;
  about: string;
}

/**
 * The questions, offered rather than imposed.
 *
 * They sit beside a resume that already exists, so answering is an upgrade to
 * something visible rather than a toll on the way in. All of them on one screen
 * because a turn-by-turn conversation costs a round trip per question, and
 * several seconds each is a long wait in the middle of applying for a job.
 */
export default function StrengthenPanel({
  applicationId,
  missingCount,
  onImproved,
}: {
  applicationId: string;
  missingCount: number;
  /** Re-tailors. Resolves false when the re-tailor itself failed. */
  onImproved: () => Promise<boolean> | void;
}) {
  const router = useRouter();
  const [state, setState] = useState<'closed' | 'loading' | 'open' | 'saving'>('closed');
  const [questions, setQuestions] = useState<JobQuestion[]>([]);
  const [answers, setAnswers] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setState('loading');
    setError(null);
    try {
      const response = await fetch(`/api/applications/${applicationId}/questions`);
      const data = await response.json();
      if (!response.ok) {
        setError(data?.error?.message ?? 'Could not work out what to ask.');
        setState('closed');
        return;
      }
      if (!data.questions?.length) {
        setError('Nothing worth asking — this resume already covers the posting well.');
        setState('closed');
        return;
      }
      setQuestions(data.questions);
      setAnswers(new Array(data.questions.length).fill(''));
      setState('open');
    } catch {
      setError('Your internet connection dropped.');
      setState('closed');
    }
  }

  async function submit() {
    setState('saving');
    setError(null);
    try {
      const response = await fetch(`/api/applications/${applicationId}/questions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          answers: questions.map((q, i) => ({ question: q.text, answer: answers[i] })),
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data?.error?.message ?? 'Could not save your answers.');
        setState('open');
        return;
      }
      setState('closed');
      setQuestions([]);
      router.refresh();

      // The answers are saved by the request above; the re-tailor is a second
      // one. When that failed there was no sign of it — the panel closed, the
      // credit was spent, and the resume was the one you already had. Saying so
      // is the difference between a retry and a mystery.
      const rewritten = await onImproved();
      if (rewritten === false) {
        setError('Your answers are saved, but the resume did not update. Press Tailor again.');
      }
    } catch {
      setError('Your internet connection dropped.');
      setState('open');
    }
  }

  const answeredCount = answers.filter((a) => a.trim()).length;

  if (state === 'open' || state === 'saving') {
    return (
      <div className="rounded-md border border-accent-line bg-accent-tint p-[18px]">
        <div className="flex items-baseline justify-between">
          <span className="text-[11px] uppercase tracking-[0.12em] text-accent">
            {questions.length} {questions.length === 1 ? 'question' : 'questions'}
          </span>
          <button
            type="button"
            onClick={() => setState('closed')}
            disabled={state === 'saving'}
            className="text-[12.5px] text-accent transition hover:text-accent-hover disabled:opacity-50"
          >
            Not now
          </button>
        </div>

        <div className="mt-4 flex flex-col gap-5">
          {questions.map((q, i) => (
            <div key={i} className="flex flex-col gap-2">
              <span className="text-[14px] leading-snug text-ink">{q.text}</span>
              <span className="text-[12.5px] leading-snug text-accent">{q.why}</span>
              <textarea
                rows={2}
                value={answers[i]}
                disabled={state === 'saving'}
                onChange={(e) => {
                  const next = [...answers];
                  next[i] = e.target.value;
                  setAnswers(next);
                }}
                placeholder="Your answer, or leave blank to skip"
                className="[field-sizing:content] max-h-[10lh] w-full resize-none rounded border border-accent-line bg-ground-surface px-3 py-2.5 text-[13.5px] leading-relaxed outline-none transition placeholder:text-ink-ghost focus:border-accent disabled:opacity-60"
              />
            </div>
          ))}
        </div>

        {error ? <p className="mt-3 text-[13px] text-flag">{error}</p> : null}

        <button
          type="button"
          onClick={submit}
          disabled={state === 'saving' || answeredCount === 0}
          className="mt-5 w-full rounded bg-accent py-3 text-sm font-medium text-ground transition hover:bg-accent-hover disabled:bg-rule-field disabled:text-ink-ghost"
        >
          {state === 'saving'
            ? 'Saving…'
            : answeredCount === 0
              ? 'Answer at least one'
              : `Save ${answeredCount} ${answeredCount === 1 ? 'answer' : 'answers'} and re-tailor \u00b7 1 credit`}
        </button>
        <p className="mt-2.5 text-center text-[12px] text-accent">
          Anything you add here stays on your profile for every future job.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-rule bg-ground-surface p-[18px]">
      <span className="text-[14px] text-ink">
        {missingCount > 0
          ? `A few questions would close ${missingCount === 1 ? 'the gap' : 'these gaps'}`
          : 'A few questions would make this stronger'}
      </span>
      <p className="mt-1.5 text-[13px] leading-snug text-ink-muted">
        About this job specifically &mdash; usually three, and they take a minute.
      </p>
      <button
        type="button"
        onClick={load}
        disabled={state === 'loading'}
        className="mt-3.5 w-full rounded border border-rule-field py-2.5 text-[13.5px] text-ink-prose transition hover:border-accent hover:text-accent disabled:opacity-60"
      >
        {state === 'loading' ? (
          <span className="flex items-center justify-center gap-2.5">
            <Spinner /> Working out what to ask…
          </span>
        ) : (
          'Show me'
        )}
      </button>
      {error ? <p className="mt-3 text-[13px] text-ink-muted">{error}</p> : null}
    </div>
  );
}
