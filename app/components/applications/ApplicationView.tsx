'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ResumeStructure } from '../../lib/types';
import DownloadPdf from './DownloadPdf';
import Stages from '../Stages';
import { INSTRUCT_STEPS, REASSURE } from '../../lib/waits';
import type { RuleResult } from '../../lib/rules';
import StatusPicker from './StatusPicker';
import VersionPicker, { type ResumeVersion } from './VersionPicker';
import type { ApplicationStatus } from './ApplicationRow';
import PdfPreview from './PdfPreview';
import PageOutline from './PageOutline';
import StrengthenPanel from './StrengthenPanel';
import { restoreResumeVersion } from '../../server/actions';
import BeforeResume from './BeforeResume';
import { useConfirm } from '../undo/ConfirmProvider';
import type { RequirementMatch } from '../../lib/requirementMatch';
import { splitWarnings } from '../../lib/changeLog';

interface Props {
  applicationId: string;
  /** False while an older version is being read. Then the screen is read-only. */
  isLatest: boolean;
  /**
   * Start tailoring on arrival.
   *
   * True only on the way in from the posting form, for a posting that read
   * cleanly, into an application with no resume yet. Decided on the server,
   * which holds all three facts — see applications/[id]/page.tsx.
   */
  startTailor: boolean;
  /** Hand edits made since the last tailor — all of them undone by another one. */
  editsSinceTailor: number;
  /** What the posting asks for, split by whether the profile already says it. */
  requirementMatch: RequirementMatch;
  /** How each of the person's rules fared on this version. Computed, not stored. */
  ruleResults: RuleResult[];
  status: ApplicationStatus;
  posting: {
    company: string | null;
    role: string | null;
    location: string | null;
    description: string | null;
    sourceUrl: string | null;
    requirements: string[];
  };
  resume: {
    structure: ResumeStructure;
    matchScore: number | null;
    missingRequirements: string[];
    log: string[];
    warnings: string[];
    version: number;
  } | null;
  versions: ResumeVersion[];
}

export default function ApplicationView({ applicationId, isLatest, startTailor, editsSinceTailor, requirementMatch, ruleResults, status, posting, resume, versions }: Props) {
  const router = useRouter();
  const ask = useConfirm();
  // Starts true when arriving to tailor, so the first paint is already the wait.
  // Starting false put the start panel and its live button on screen for the
  // frame before the effect below runs — a button that, pressed, buys a second
  // resume.
  const [tailoring, setTailoring] = useState(startTailor);
  const [error, setError] = useState<string | null>(null);
  /** Whether the failed attempt's credit came back, as the server reported it. */
  const [creditKept, setCreditKept] = useState(false);
  const [tab, setTab] = useState<'review' | 'posting'>('review');
  const [instruction, setInstruction] = useState('');
  const composer = useRef<HTMLTextAreaElement>(null);
  const [editing, setEditing] = useState(false);
  /**
   * A question put to the person, and the instruction it is about.
   *
   * Held here rather than saved, because nothing happened: no version, no edit
   * spent. The next request carries both halves so the answer is read against
   * what it answers.
   */
  const [asking, setAsking] = useState<{ instruction: string; question: string } | null>(null);
  const [confirmTailor, setConfirmTailor] = useState(false);
  /** The gaps and the sentence explaining them, folded shut until asked for. */
  const [showGaps, setShowGaps] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [editsLeft, setEditsLeft] = useState<number | null>(null);
  /** What the last edit was held back from touching, and what was typed. */
  const [held, setHeld] = useState<{ frozen: string[]; instruction: string } | null>(null);
  const [pending, startTransition] = useTransition();

  /*
   * Warnings, sorted by who they are about.
   *
   * "No CAD evidence in this profile" decides whether to apply at all and
   * belongs beside the score. "Your own wording was put back" is the app
   * reporting itself and belongs with the change log. One field held both.
   */
  const { aboutTheJob: fitNotes, aboutTheApp: appNotes } = splitWarnings(resume?.warnings ?? []);

  /*
   * The same request, asked again without the scope.
   *
   * An edit is held to what its sentence named, and the change log says what
   * it held. `wholeResume` is how the person says they meant it everywhere —
   * sent as a fresh edit rather than applied to the version already saved, so
   * the narrow result stays on the shelf and both are theirs to compare.
   */
  async function applyInstruction(again?: { instruction: string; wholeResume: true }) {
    const typed = again ? again.instruction : instruction.trim();
    if (!typed || editing) return;
    setEditing(true);
    setError(null);
    setHeld(null);
    try {
      const response = await fetch(`/api/applications/${applicationId}/instruct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Answering carries the question and the instruction it was about, so
        // the answer is read against what it answers rather than on its own.
        body: JSON.stringify(
          again
            ? { instruction: again.instruction, wholeResume: true }
            : asking
              ? { instruction: asking.instruction, question: asking.question, answer: typed }
              : { instruction: typed },
        ),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data?.error?.message ?? 'Something went wrong. Please try again.');
        return;
      }
      setEditsLeft(typeof data?.editsLeft === 'number' ? data.editsLeft : null);

      /*
       * A question, not a change.
       *
       * Nothing was saved, so nothing is refreshed and no edit was spent. The
       * box becomes the place to answer, and the original instruction is kept —
       * a second question about the same instruction still answers the first.
       */
      if (typeof data?.question === 'string' && data.question.trim()) {
        setAsking({ instruction: asking?.instruction ?? typed, question: data.question.trim() });
        setInstruction('');
        return;
      }

      setAsking(null);
      setInstruction('');
      // Only when the app actually held something back, and never on the
      // second try — asking for the whole resume cannot be held.
      setHeld(
        !again && data?.held && Array.isArray(data.held.frozen) && data.held.frozen.length
          ? { frozen: data.held.frozen as string[], instruction: String(data.held.instruction ?? typed) }
          : null,
      );
      // Inside the transition, so the spinner outlasts the request and a second
      // click cannot land on a screen that has not caught up yet.
      startTransition(() => router.refresh());
    } catch {
      setError('Your internet connection dropped. Please check your connection.');
    } finally {
      setEditing(false);
    }
  }

  /** Resolves false when the tailor failed, so a caller can say so. */
  async function tailor(): Promise<boolean> {
    setTailoring(true);
    setError(null);
    setCreditKept(false);
    try {
      const response = await fetch(`/api/applications/${applicationId}/tailor`, { method: 'POST' });
      const data = await response.json();
      if (!response.ok) {
        setError(data?.error?.message ?? 'Something went wrong. Please try again.');
        setCreditKept(data?.error?.creditKept === true);
        return false;
      }
      // Inside the transition, so `pending` stays true until the server render
      // actually lands. router.refresh() returns void — it does not resolve
      // when the new page arrives — so clearing the flag straight after it put
      // the start panel and its live button back on screen while the resume was
      // still being written. A second click there spends a second credit.
      startTransition(() => router.refresh());
      return true;
    } catch {
      setError('Your internet connection dropped. Please check your connection.');
      return false;
    } finally {
      setTailoring(false);
    }
  }

  /*
   * Tailoring on arrival, when the posting form asked for it.
   *
   * The form reads the posting behind a short full-window wait, then comes here
   * with `?tailor=1`, so the resume is written while this page shows what the
   * posting asks for — rather than behind a loading screen with nothing on it.
   * The server decided whether to honour the flag; see `startTailor`.
   *
   * The flag leaves the address bar BEFORE the request goes out, through the
   * browser's own history rather than the router, so it costs no server render.
   * That line is what stops a refresh mid-tailor landing back here still
   * carrying `tailor=1` with nothing saved yet, and buying a second resume.
   *
   * `fired` covers the other double: React's development StrictMode runs every
   * effect twice, and a second run here is a second credit.
   */
  /*
   * A question arrives where the person was already typing, but a panel that
   * looks the same as it did a second ago is easy to walk past — it was, the
   * first time this shipped. So the page comes to them: the answer box scrolls
   * into view and takes the caret, and the card itself glows once. The same
   * three moves the "Ask it to fix this" link already makes.
   */
  useEffect(() => {
    if (!asking) return;
    composer.current?.scrollIntoView({ block: 'nearest' });
    composer.current?.focus();
  }, [asking]);

  const fired = useRef(false);
  useEffect(() => {
    if (!startTailor || fired.current) return;
    fired.current = true;
    window.history.replaceState(null, '', `/applications/${applicationId}`);
    void tailor();
    // `tailor` is redeclared every render; `fired` makes this once per arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startTailor, applicationId]);

  // One flag for "something is happening", covering both the request and the
  // re-render that follows it.
  const busy = tailoring || pending;

  /**
   * Done: back to the list.
   *
   * Every applied edit is already saved as a version, so nothing on this page
   * needs saving on the way out. The one thing that can be lost is an
   * instruction typed into the composer and never applied — so it asks then,
   * and only then.
   */
  async function leave() {
    if (instruction.trim() || asking) {
      const discard = await ask({
        title: 'Leave without applying?',
        body: 'The change you typed has not been applied to this resume yet.',
        action: 'Discard',
      });
      if (!discard) return;
    }
    router.push('/applications');
  }

  return (
    <main className="flex h-screen flex-col overflow-hidden bg-ground font-sans text-ink">
      <div className="flex h-[62px] shrink-0 items-center justify-between border-b border-rule bg-ground-surface px-8">
        <div className="flex items-center gap-4">
          {/*
            The logo is the way off this screen.

            There is no back arrow here on purpose — the browser has one directly
            above, and a second arrow beneath it competes with the control people
            already reach for. But a screen with NO exit of its own is a dead end
            on a phone, where the browser's arrow lives in a toolbar that hides
            itself, and in an installed window, where there is no toolbar at all.
          */}
          <Link
            href="/applications"
            // Inert while a tailor runs. Leaving is harmless in itself, but coming
            // back before it finishes lands on the start panel with a live button,
            // and pressing that spends a second credit on the same resume.
            aria-disabled={busy || undefined}
            tabIndex={busy ? -1 : undefined}
            className={`flex items-center gap-2.5 transition hover:opacity-70 ${busy ? 'pointer-events-none' : ''}`}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#2F5D50" strokeWidth="1.5" strokeLinecap="round">
              <path d="M12 3v18M3 12h18M6 6l12 12M18 6L6 18" />
            </svg>
            <span className="text-[12.5px] uppercase tracking-[0.16em] text-ink-prose">Resumi9</span>
          </Link>
          <div className="flex flex-col">
            <span className="text-sm text-ink">{posting.role ?? 'Untitled role'}</span>
            <span className="text-[12.5px] text-ink-muted">
              {[posting.company, posting.location].filter(Boolean).join(' · ') || 'Unknown company'}
            </span>
          </div>
        </div>

        {resume && !busy ? (
          <div className="flex items-center gap-2.5">
            <StatusPicker applicationId={applicationId} status={status} />
            <VersionPicker
              applicationId={applicationId}
              current={resume.version}
              versions={versions}
            />
            <DownloadPdf applicationId={applicationId} version={resume.version} />
            {/* Held while an edit applies: leaving mid-edit lands back on a
                version that is about to be replaced. */}
            <button
              type="button"
              onClick={leave}
              disabled={editing}
              className="rounded bg-accent px-4 py-2 text-[13px] font-medium text-ground transition hover:bg-accent-hover disabled:opacity-50"
            >
              Done
            </button>
          </div>
        ) : null}
      </div>

      {busy || !resume ? (
        /*
         * One screen before there is a resume, in three states.
         *
         * What the posting asks for is already known — it was read before this
         * started — so it is on screen while the resume is being written, instead
         * of a loading screen with nothing on it. Same columns as the finished
         * page, so nothing jumps when the resume lands.
         *
         * Failing used to land on a separate "Ready when you are." page — the
         * page this app had already decided not to have, because pressing a
         * button to start something you just asked for is a step nobody wants.
         * It survived as the empty state, so every failed tailor sent people
         * there: match gone, and one line of small text under a button that
         * starts the whole thing again. A tester pressed it five times in three
         * minutes. Now failing changes the middle of this screen and nothing
         * else moves.
         */
        <BeforeResume
          match={requirementMatch}
          state={
            busy
              ? { kind: 'writing' }
              : error
                ? { kind: 'failed', message: error, creditKept, onRetry: () => void tailor() }
                : { kind: 'ready', onStart: () => void tailor() }
          }
        />
      ) : (
        <div className="grid min-h-0 flex-grow grid-cols-1 overflow-y-auto lg:grid-cols-[320px_minmax(0,1fr)_440px] lg:overflow-hidden">
          {/*
            What happened, at column width instead of a count behind a link.
            This is the app's account of what it did to somebody's career
            history, and it used to be the least readable thing on the screen —
            collapsed, in a 440px rail, next to the controls. The band either
            side of the centred page was three hundred pixels of empty grey.

            Read left, act right: everything here describes, everything on the
            right changes.
          */}
          <div className="order-3 flex min-h-0 flex-col border-t border-rule bg-ground px-5 py-5 lg:order-none lg:border-r lg:border-t-0 lg:overflow-y-auto">
            <span className="text-[10.5px] uppercase tracking-[0.12em] text-ink-faint">
              {resume.log.length
                ? `What changed · ${resume.log.length} ${resume.log.length === 1 ? 'edit' : 'edits'}`
                : 'What changed'}
            </span>
            {/*
              Three lines, then the rest on request.

              A tailor writes eight or more and they filled the column — every
              one true, none of them urgent. The first three are the ones that
              changed the resume most, because the guard's repairs lead and the
              model's own account follows.
            */}
            {resume.log.length ? (
              <div className="mt-4 flex flex-col gap-3">
                {(showLog ? resume.log : resume.log.slice(0, 3)).map((line, i) => (
                  <div key={i} className="border-l-2 border-rule pl-3">
                    <span className="text-[12.5px] leading-relaxed text-ink-prose">{line}</span>
                  </div>
                ))}
                {resume.log.length > 3 ? (
                  <button
                    type="button"
                    onClick={() => setShowLog((open) => !open)}
                    aria-expanded={showLog}
                    className="self-start text-[12.5px] text-accent transition hover:text-accent-hover"
                  >
                    {showLog ? 'Show fewer' : `${resume.log.length - 3} more`}
                  </button>
                ) : null}
              </div>
            ) : (
              <p className="mt-4 text-[12.5px] leading-relaxed text-ink-muted">
                Nothing has been changed on this version yet.
              </p>
            )}
            {/*
              What the app did to protect the resume, beside what it changed.

              These were filed with the warnings, in a box at the bottom of the
              review column headed "Worth checking" — next to the sentence
              saying whether this posting is worth applying to at all. Two
              unrelated kinds of thing in one place, and the one that mattered
              was under the one that did not. A line saying your own wording was
              put back belongs here, with the rest of what happened.
            */}
            {appNotes.length ? (
              <div className="mt-5 flex flex-col gap-3 border-t border-rule pt-4">
                {appNotes.map((note, i) => (
                  <div key={i} className="border-l-2 border-flag-line pl-3">
                    <span className="text-[12.5px] leading-relaxed text-flag-ink">{note}</span>
                  </div>
                ))}
              </div>
            ) : null}
            {/*
              Claims only what is actually checked.

              It used to end "Nothing is invented to fill a gap", which nothing
              verified — and five reviewed resumes each carried invented claims
              under that sentence. The checks named here are real: the guard
              reverts dates, employers and schools to the profile, and puts back
              entries and skills the tailoring dropped.
            */}
            <p className="mt-6 border-t border-rule pt-4 text-[12.5px] leading-relaxed text-ink-muted">
              Your dates, employers and schools are set back to whatever your profile says, and
              anything the tailoring dropped is put back.
            </p>
          </div>

          <div className="order-1 flex min-h-0 flex-col bg-ground-band lg:order-none">
            {editing ? (
              /*
               * The wait IS the column while an edit runs, rather than a layer
               * over it.
               *
               * An overlay was tried twice. `inset-0` inside the scrolling
               * element covered the first screenful of CONTENT rather than what
               * was on screen, so scrolled down to page two the wait sat above
               * the viewport and the resume showed through beneath it — "it
               * shows half of the preview when buffering". Moving the overlay
               * out to a column that no longer scrolls should have fixed that,
               * and on a real screen it still came back half covered: the whole
               * approach depends on the column being exactly as tall as the
               * viewport, which is an assumption about six ancestors.
               *
               * Not rendering the resume at all cannot half-cover anything, and
               * it costs nothing — an edit changes the version, so the preview
               * was going to be rebuilt the moment this cleared either way.
               */
              <div className="flex w-full flex-col items-center gap-4 px-8 py-7">
                <div className="w-full max-w-[420px] rounded-md border border-rule bg-ground-surface px-5 pb-3 pt-5">
                  <h1 className="font-serif text-[26px] leading-[1.1]">Making that change.</h1>
                  <div className="mt-3">
                    <Stages
                      steps={INSTRUCT_STEPS}
                      done={false}
                      estimate="Usually about twenty seconds."
                      reassure={REASSURE}
                    />
                  </div>
                </div>
                {/* The same sheet the tailor's wait draws, so an edit does not
                    look like a different app for twenty seconds. */}
                <PageOutline />
              </div>
            ) : (
              <div className="flex w-full flex-col items-center px-8 py-7 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
                <div className="mb-4 flex w-full max-w-[600px] items-center justify-between">
                  <span className="text-xs text-ink-muted">
                    Version {resume.version}
                    {!isLatest ? ' · an earlier version' : null}
                  </span>
                  <span className="inline-flex items-center gap-1.5 rounded-[3px] bg-accent-wash px-2.5 py-1 text-[11.5px] text-accent">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                    ATS-safe
                  </span>
                </div>
                {/* The compiled document, and nothing drawn on it: this is what
                    downloads, so a marked-up copy would stop it being a preview. */}
                <PdfPreview applicationId={applicationId} version={resume.version} reloadKey={resume.version} />
              </div>
            )}
          </div>

          <aside className="order-2 flex min-h-0 flex-col border-t border-rule bg-ground-surface lg:order-none lg:border-l lg:border-t-0">
            <div className="flex shrink-0 gap-6 border-b border-rule px-6">
              {(['review', 'posting'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTab(t)}
                  className={`py-4 text-[13.5px] ${tab === t ? 'border-b-2 border-accent text-ink' : 'text-ink-muted'}`}
                >
                  {t === 'review' ? 'Review' : 'Job posting'}
                </button>
              ))}
            </div>

            <div className="flex min-h-0 flex-grow flex-col gap-5 overflow-y-auto px-6 py-6">
              {tab === 'review' && !isLatest ? (
                /*
                  Reading an older version is reading only. Not disabled
                  controls — a greyed-out button invites a click and explains
                  nothing — and not silently acting on the newest either, which
                  would apply an edit to a resume that is not on the screen.
                */
                <div className="rounded-md border border-rule bg-ground p-[18px]">
                  <span className="text-[11px] uppercase tracking-[0.12em] text-ink-faint">
                    Looking back
                  </span>
                  <p className="mt-2.5 text-[13.5px] leading-relaxed text-ink-prose">
                    You are looking at version {resume.version}. Everything here &mdash; the match,
                    the gaps, what changed &mdash; describes this version, and the download gives
                    you this one. Restore it to work from here.
                  </p>
                  {/*
                    A way forward as well as a way to commit.
                    
                    The banner explained you were somewhere old and offered only
                    Restore — which WRITES a new version. Somebody who opened an
                    old one to look at it had no way back to the latest that did
                    not change something, short of the browser.
                  */}
                  <Link
                    href={`/applications/${applicationId}`}
                    className="mt-3 inline-flex items-center gap-2 text-[12.5px] text-accent transition hover:text-accent-hover"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M19 12H5M12 19l-7-7 7-7" />
                    </svg>
                    Back to the latest version
                  </Link>
                  <RestoreVersion
                    applicationId={applicationId}
                    version={resume.version}
                    id={versions.find((v) => v.version === resume.version)?.id ?? ''}
                  />
                </div>
              ) : null}

              {tab === 'review' ? (
                <>
                  {/*
                    One block for how this resume stands against this job.

                    The score, the gaps and the sentence explaining them were
                    three separate cards, top to bottom, with other things
                    between — and the sentence, which is the only one that says
                    anything a person can act on, was LAST, below the fold,
                    under a heading that reads like a proofreading note. On a
                    posting asking for nine things this resume has none of, it
                    was never seen.

                    Folded shut by default and one tap from open. A tap is not
                    free, and on screen behind a tap is not obviously better
                    than visible after a scroll — but a thing nobody scrolls to
                    is a thing nobody reads, and this way the whole column fits
                    on one screen.
                  */}
                  {resume.matchScore !== null || resume.missingRequirements.length > 0 || fitNotes.length > 0 ? (
                    <div
                      className={`rounded-md border p-[18px] ${
                        resume.missingRequirements.length > 0 || fitNotes.length > 0
                          ? 'border-flag-line bg-flag-bg'
                          : 'border-rule'
                      }`}
                    >
                      <div className="flex items-baseline justify-between">
                        <span className="text-[11px] uppercase tracking-[0.12em] text-ink-faint">
                          Against this job
                        </span>
                        {resume.matchScore !== null ? (
                          <div className="flex items-baseline gap-1.5">
                            <span className="font-serif text-[30px] leading-none">{resume.matchScore}</span>
                            <span className="text-[13px] text-ink-faint">/ 100</span>
                          </div>
                        ) : null}
                      </div>
                      {resume.matchScore !== null ? (
                        <div className="mt-3 h-1 overflow-hidden rounded-sm bg-rule">
                          <div className="h-full rounded-sm bg-accent" style={{ width: `${resume.matchScore}%` }} />
                        </div>
                      ) : null}

                      {resume.missingRequirements.length > 0 || fitNotes.length > 0 ? (
                        <>
                          <button
                            type="button"
                            onClick={() => setShowGaps((open) => !open)}
                            aria-expanded={showGaps}
                            className="mt-3.5 flex w-full items-center justify-between gap-3 text-left text-[13.5px] text-flag-ink"
                          >
                            <span>
                              {resume.missingRequirements.length > 0 ? (
                                <>
                                  <strong className="font-semibold">
                                    {resume.missingRequirements.length}{' '}
                                    {resume.missingRequirements.length === 1 ? 'thing' : 'things'} missing
                                  </strong>
                                  {' — '}
                                  {resume.missingRequirements.slice(0, 2).join(', ')}
                                  {resume.missingRequirements.length > 2
                                    ? `, +${resume.missingRequirements.length - 2}`
                                    : ''}
                                </>
                              ) : (
                                <strong className="font-semibold">Worth reading before you send this</strong>
                              )}
                            </span>
                            <span className="shrink-0 text-[12px] text-accent">{showGaps ? 'Hide' : 'Show'}</span>
                          </button>

                          {showGaps ? (
                            <div className="mt-3 border-t border-flag-line pt-3">
                              {resume.missingRequirements.length > 0 ? (
                                <div className="flex flex-wrap gap-1.5">
                                  {resume.missingRequirements.map((r) => (
                                    <span
                                      key={r}
                                      className="rounded-[3px] border border-flag-line bg-ground-surface px-2.5 py-1 text-xs text-flag-ink"
                                    >
                                      {r}
                                    </span>
                                  ))}
                                </div>
                              ) : null}
                              {fitNotes.map((w, i) => (
                                <p key={i} className="mt-3 text-[12.5px] leading-snug text-flag-ink">
                                  {w}
                                </p>
                              ))}
                              {resume.missingRequirements.length > 0 ? (
                                <p className="mt-3 text-[12.5px] leading-snug text-flag">
                                  If you have touched any of these, say so below and it goes in. If not,
                                  leave it &mdash; nothing gets invented.
                                </p>
                              ) : null}
                            </div>
                          ) : null}
                        </>
                      ) : null}
                    </div>
                  ) : null}

                  {isLatest ? (
                    <StrengthenPanel
                      applicationId={applicationId}
                      missingCount={resume.missingRequirements.length}
                      onImproved={tailor}
                      compact
                    />
                  ) : null}

                  {/*
                    What your own rules did to this version.
                    
                    Measured, not asked. The model is never questioned about
                    whether it obeyed — this app has been caught by a self-report
                    before, when a tailor dropped a fifteen-month job and its own
                    change log mentioned the role in none of its sixteen entries.
                    A rule that can be checked is checked; a rule that cannot says
                    so plainly rather than showing a tick it has not earned.
                  */}
                  {ruleResults.length ? (
                    <div className="rounded-md border border-rule p-[18px]">
                      {/*
                        One line when every rule passed, which is the usual case
                        and was costing a whole card. A failure opens itself: a
                        rule somebody wrote and this resume broke is not
                        something they should have to go looking for.
                      */}
                      <button
                        type="button"
                        onClick={() => setShowRules((open) => !open)}
                        aria-expanded={showRules || ruleResults.some((r) => r.verdict === 'fail')}
                        className="flex w-full items-baseline justify-between gap-3 text-left"
                      >
                        <span className="text-[11px] uppercase tracking-[0.12em] text-ink-faint">
                          Your rules
                        </span>
                        <span className="flex items-baseline gap-2.5">
                          <span className={ruleResults.some((r) => r.verdict === 'fail') ? 'text-[12px] text-flag' : 'text-[12px] text-ink-muted'}>
                            {ruleResults.filter((r) => r.verdict === 'pass').length} of{' '}
                            {ruleResults.filter((r) => r.verdict !== 'guidance').length} checked
                          </span>
                          {ruleResults.some((r) => r.verdict === 'fail') ? null : (
                            <span className="text-[12px] text-accent">{showRules ? 'Hide' : 'Show'}</span>
                          )}
                        </span>
                      </button>

                      <ul
                        hidden={!showRules && !ruleResults.some((r) => r.verdict === 'fail')}
                        className="mt-3 flex flex-col gap-2.5"
                      >
                        {ruleResults.map((r) => (
                          <li key={r.ruleId} className="flex items-start gap-2.5">
                            <span className="mt-[3px] grid h-3.5 w-3.5 shrink-0 place-items-center">
                              {r.verdict === 'pass' ? (
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#2F5D50" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                  <path d="M20 6L9 17l-5-5" />
                                </svg>
                              ) : r.verdict === 'fail' ? (
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#8A6414" strokeWidth="2.8" strokeLinecap="round" aria-hidden="true">
                                  <path d="M18 6L6 18M6 6l12 12" />
                                </svg>
                              ) : (
                                <span aria-hidden="true" className="h-px w-2.5 bg-ink-ghost" />
                              )}
                            </span>

                            <span className="min-w-0">
                              <span
                                className={`block text-[12.5px] leading-snug ${
                                  r.verdict === 'guidance' ? 'text-ink-muted' : 'text-ink-prose'
                                }`}
                              >
                                {r.text}
                              </span>

                              {r.verdict === 'fail' ? (
                                <>
                                  <span className="mt-1 block text-[12px] leading-snug text-flag-ink">
                                    {r.evidence}
                                  </span>
                                  {/*
                                    The free way out. Instructions are ten per
                                    tailor and cost nothing, so a broken rule is
                                    fixable without spending a credit — and
                                    without the app rewriting a sentence blind.
                                  */}
                                  {isLatest && r.fix ? (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setInstruction(r.fix!);
                                        // The composer is in another column, so
                                        // it has to be brought to you. The
                                        // example chips beside it never needed
                                        // this.
                                        composer.current?.scrollIntoView({ block: 'nearest' });
                                        composer.current?.focus();
                                      }}
                                      className="mt-1.5 text-[12px] text-accent transition hover:text-accent-hover"
                                    >
                                      Ask it to fix this &mdash; free
                                    </button>
                                  ) : null}
                                </>
                              ) : r.verdict === 'guidance' ? (
                                <span className="mt-0.5 block text-[11.5px] leading-snug text-ink-faint">
                                  Guidance &mdash; nothing to check automatically
                                </span>
                              ) : null}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                </>
              ) : (
                <div className="flex flex-col gap-4">
                  {posting.sourceUrl ? (
                    <a href={posting.sourceUrl} target="_blank" rel="noreferrer" className="text-[13.5px] text-accent underline">
                      Original listing
                    </a>
                  ) : null}
                  <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink-prose">
                    {posting.description ?? 'No description was captured.'}
                  </p>
                </div>
              )}
            </div>

            {isLatest ? (
              <div className="flex shrink-0 flex-col gap-3 border-t border-rule px-6 py-4">
                {/*
                  The missing half. Until now the only way to alter a tailored
                  resume was to regenerate it, which spends a credit and rewrites
                  the parts somebody was happy with — so a resume that was
                  ninety-five per cent right could be replaced but not fixed.

                  Free, because a credit means "one application" and charging one
                  to shorten a bullet means nobody ever does it. The examples are
                  there because nobody knows what to type into an empty box.
                */}
                <div className="flex flex-col gap-2.5 rounded-md border border-accent-line bg-accent-tint p-[15px]">
                  <span className="text-[11px] uppercase tracking-[0.12em] text-ink-faint">
                    Change something
                  </span>

                  {/*
                    Asked rather than guessed. "Drop the second bullet" used to
                    take the first job's, silently, because it was first.
                  */}
                  {asking ? (
                    <div className="flex animate-[askedYou_900ms_ease-out] flex-col gap-1.5 rounded border border-accent-line bg-ground-surface px-3 py-2.5">
                      <span className="text-[13px] leading-snug text-ink">{asking.question}</span>
                      <span className="text-[12px] leading-snug text-ink-muted">
                        About &ldquo;{asking.instruction}&rdquo;
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setAsking(null);
                          setInstruction(asking.instruction);
                        }}
                        className="self-start text-[12px] text-accent transition hover:text-accent-hover"
                      >
                        Start over
                      </button>
                    </div>
                  ) : null}

                  <textarea
                    rows={2}
                    value={instruction}
                    onChange={(e) => setInstruction(e.target.value)}
                    disabled={editing || busy}
                    placeholder={asking ? 'Your answer…' : 'Make the FraudWatch bullets shorter…'}
                    className="[field-sizing:content] max-h-[10lh] w-full resize-none rounded border border-rule-field bg-ground-surface px-3 py-2.5 text-[13.5px] leading-relaxed outline-none transition placeholder:text-ink-ghost focus:border-accent disabled:opacity-60"
                  />
                  <div className="flex flex-wrap gap-1.5">
                    {/*
                      "make it fit one page" was here and could not work: the
                      guard restores every entry an edit removes, while the
                      bullet trims stick, so asking for one page returned a
                      resume that was still two pages and had lost its best
                      bullets. Fitting to a page is the app's job, not an
                      instruction — it comes back when the app measures pages.
                    */}
                    {['drop the second bullet', 'lead with the Python work', 'shorten the Aegon bullets'].map((example) => (
                      <button
                        key={example}
                        type="button"
                        onClick={() => setInstruction(example)}
                        disabled={editing || busy}
                        className="rounded-full border border-accent-line bg-ground-surface px-2.5 py-1 text-[11px] text-accent transition hover:border-accent disabled:opacity-50"
                      >
                        {example}
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[11.5px] text-ink-muted">
                      {editsLeft === null ? 'Free · 10 per tailor' : `Free · ${editsLeft} left`}
                    </span>
                    <button
                      type="button"
                      onClick={() => applyInstruction()}
                      disabled={editing || busy || !instruction.trim()}
                      className="rounded bg-accent px-4 py-2 text-[13px] font-medium text-ground transition hover:bg-accent-hover disabled:pointer-events-none disabled:bg-rule-field disabled:text-ink-ghost"
                    >
                      {editing ? 'Applying…' : asking ? 'Answer' : 'Apply'}
                    </button>
                  </div>

                  {/*
                    * What the edit was held back from touching.
                    *
                    * An edit is scoped to what its sentence named, and
                    * everything else goes back byte for byte. That is almost
                    * always what somebody wants and occasionally is not, so
                    * the narrow reading is reported with the wide one one
                    * click away rather than guessed at.
                    */}
                  {held && !editing && (
                    <div className="mt-3 rounded border border-rule-field bg-band px-3 py-2 text-[11.5px] leading-[1.55] text-ink-muted">
                      Kept {held.frozen.join(', ')} as {held.frozen.length > 1 ? 'they were' : 'it was'} — your
                      instruction named something narrower.{' '}
                      <button
                        type="button"
                        onClick={() => applyInstruction({ instruction: held.instruction, wholeResume: true })}
                        disabled={busy}
                        className="font-medium text-accent underline decoration-dotted underline-offset-2 transition hover:text-accent-hover disabled:pointer-events-none disabled:text-ink-ghost"
                      >
                        Apply to the whole resume
                      </button>
                    </div>
                  )}
                </div>

                {/*
                  * Tailoring again rebuilds from the profile, so every edit
                  * made by hand since the last one is undone. That is the
                  * design and it is right — but one click silently reversing
                  * an afternoon's work is not. Ten edits went that way in
                  * testing: a removed job came back, a skill came back, and
                  * wording somebody had deliberately simplified reverted.
                  *
                  * Only asks when there is something to lose.
                  */}
                {confirmTailor ? (
                  <div className="flex animate-[askedYou_900ms_ease-out] flex-col gap-2 rounded border border-flag-line bg-flag-bg px-3 py-2.5">
                    <p className="text-[13px] leading-relaxed text-ink-prose">
                      This rebuilds the resume from your profile.{' '}
                      {editsSinceTailor === 1 ? 'The change you made' : `The ${editsSinceTailor} changes you made`} here
                      will be undone.
                    </p>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setConfirmTailor(false);
                          tailor();
                        }}
                        className="rounded bg-accent px-3 py-1.5 text-[12.5px] font-medium text-ground transition hover:bg-accent-hover"
                      >
                        Tailor again
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmTailor(false)}
                        className="text-[12.5px] text-ink-muted underline underline-offset-2 transition hover:text-ink"
                      >
                        Keep my changes
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => (editsSinceTailor > 0 ? setConfirmTailor(true) : tailor())}
                    disabled={busy || editing}
                    className="w-full rounded border border-rule-field bg-ground-surface py-3 text-[13.5px] text-ink-prose transition hover:border-accent disabled:opacity-50"
                  >
                    Tailor again · 1 credit
                  </button>
                )}
                {error ? <p className="text-[13px] text-flag">{error}</p> : null}
              </div>
            ) : error ? (
              <div className="shrink-0 border-t border-rule px-6 py-4">
                <p className="text-[13px] text-flag">{error}</p>
              </div>
            ) : null}
          </aside>
        </div>
      )}
    </main>
  );
}

/**
 * Brings an older version back as the newest.
 *
 * Still a copy forward rather than a rewind, so restoring is itself undoable
 * and nothing in the history is ever lost. That used to be the picker's only
 * action, which made looking indistinguishable from changing; now that browsing
 * is free it is a deliberate step, taken when somebody means it.
 */
function RestoreVersion({
  applicationId,
  version,
  id,
}: {
  applicationId: string;
  version: number;
  id: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  if (!id) return null;

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await restoreResumeVersion(applicationId, id);
          router.push(`/applications/${applicationId}`);
          router.refresh();
        })
      }
      className="mt-4 w-full rounded bg-accent px-4 py-2.5 text-[13.5px] font-medium text-ground transition hover:bg-accent-hover disabled:opacity-50"
    >
      {pending ? 'Restoring…' : `Restore version ${version}`}
    </button>
  );
}
