'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import Takeover from '../Takeover';
import { READ_POSTING_STEPS } from '../../lib/waits';

/**
 * One screen: the posting, and a button.
 *
 * The three-panel workspace this replaces asked for an About Me PDF and a rules
 * document every time. The profile already holds both, so tailoring needs
 * nothing here but the job — and saying so ("tailoring from your profile · N
 * details") is what makes that obvious rather than merely true.
 */
export default function NewApplicationForm({ detailCount }: { detailCount: number }) {
  const router = useRouter();
  const [text, setText] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!text.trim()) {
      setError('Paste the job posting first.');
      return;
    }
    setBusy(true);
    setError(null);
    // Whether this call ends in a navigation. On that path the wait must stay
    // up: `router.push` does not resolve when the next screen arrives, so
    // clearing the flag put the form back on screen for the length of the
    // navigation, at the end of a journey somebody had already committed to.
    let leaving = false;
    try {
      const response = await fetch('/api/applications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, sourceUrl }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data?.error?.message ?? 'Something went wrong. Please try again.');
        return;
      }

      const applicationId: string = data.applicationId;
      leaving = true;

      /*
       * Straight on into tailoring, without asking again — on the next screen.
       *
       * Pressing "Tailor my resume" here and again on the application was the
       * same question twice, so `tailor=1` asks that page to start on arrival.
       * The resume is written there rather than here because that page can show
       * what the posting asks for while it is being written, and this one has
       * nothing worth looking at for thirty seconds.
       *
       * A posting the extraction could not read — no description, or no named
       * requirements — goes without the flag and stops to ask, because tailoring
       * towards that spends a credit on a resume aimed at nothing.
       */
      router.push(`/applications/${applicationId}${data.ready ? '?tailor=1' : ''}`);
    } catch {
      setError('Your internet connection dropped. Please check your connection.');
    } finally {
      if (!leaving) setBusy(false);
    }
  }

  /*
   * Only the reading is a full-window wait now — about eight seconds.
   *
   * The writing that follows happens on the application page, beside what the
   * posting asks for, which cannot be shown until this has found out. Nothing on
   * this form is worth leaving up meanwhile, and its button would start another.
   */
  if (busy) {
    return <Takeover title="Reading the posting." steps={READ_POSTING_STEPS} done={false} />;
  }

  return (
    <main className="min-h-screen bg-ground font-sans text-ink">
      <div className="flex h-[62px] items-center justify-between border-b border-rule bg-ground-surface px-8">
        {/*
          The logo is the way off this screen.
          
          There is no back arrow here on purpose — the browser has one directly
          above, and a second arrow beneath it competes with the control people
          already reach for. But a screen with NO exit of its own is a dead end
          on a phone, where the browser's arrow lives in a toolbar that hides
          itself, and in an installed window, where there is no toolbar at all.
        */}
        <Link href="/applications" className="flex items-center gap-2.5 transition hover:opacity-70">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#2F5D50" strokeWidth="1.5" strokeLinecap="round">
            <path d="M12 3v18M3 12h18M6 6l12 12M18 6L6 18" />
          </svg>
          <span className="text-[12.5px] uppercase tracking-[0.16em] text-ink-prose">Resumi9</span>
        </Link>
      </div>

      <div className="mx-auto flex max-w-[660px] flex-col px-6 py-11">
        <h1 className="font-serif text-[34px] leading-[1.08] sm:text-[40px]">
          What are you applying <em className="text-accent">for</em>?
        </h1>
        <p className="mt-3 text-[15px] text-ink-prose">
          Paste the posting. We&rsquo;ll pull out the company, the role, and what they&rsquo;re asking for.
        </p>

        <div className="mt-7 overflow-hidden rounded-md border border-rule-field bg-ground-surface">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Paste the job posting here…"
            className="min-h-[220px] w-full resize-none px-5 py-5 text-[14.5px] leading-relaxed text-ink outline-none placeholder:text-ink-ghost disabled:opacity-60"
          />
          <div className="flex items-center gap-2.5 border-t border-rule-soft bg-ground-panel/50 px-4 py-3">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#8A8680" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
              <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
              <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
            </svg>
            <input
              type="url"
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
              placeholder="Link to the posting (optional — kept for your records)"
              className="flex-grow bg-transparent text-[13.5px] text-ink outline-none placeholder:text-ink-ghost"
            />
          </div>
        </div>

        <div className="mt-5 flex items-start gap-3 rounded-md bg-ground-band px-4 py-3.5">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8A8680" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="mt-px shrink-0">
            <path d="M21 8v13H3V8" /><path d="M1 3h22v5H1z" /><path d="M10 12h4" />
          </svg>
          <span className="text-[13.5px] leading-relaxed text-ink-prose">
            We keep a copy of this posting. Listings come down within weeks &mdash; you will want it
            back the day before an interview.
          </span>
        </div>

        {error ? <p className="mt-4 text-sm text-flag">{error}</p> : null}

        <div className="mt-7 flex flex-wrap items-center justify-between gap-4 border-t border-rule pt-6">
          <div className="flex items-center gap-2.5">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#2F5D50" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6L9 17l-5-5" />
            </svg>
            <span className="text-[13.5px] text-ink-prose">
              Tailoring from your profile &middot; {detailCount} {detailCount === 1 ? 'detail' : 'details'}
            </span>
          </div>
          <div className="flex flex-col items-end gap-2">
            <button
              type="button"
              onClick={submit}
              disabled={!text.trim()}
              className="rounded bg-accent px-[30px] py-3.5 text-[15px] font-medium text-ground transition hover:bg-accent-hover disabled:bg-rule-field disabled:text-ink-ghost"
            >
              Tailor my resume
            </button>
            {/*
              A greyed-out button with no reason beside it is a dead end. The
              link field looks like it might be enough — two other screens used
              to say it was — so somebody who pastes only a URL sits in front of
              a button that will not move and is told nothing.
            */}
            {!text.trim() ? (
              <span className="text-[12.5px] text-ink-muted">
                Paste the posting text above to continue
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </main>
  );
}
