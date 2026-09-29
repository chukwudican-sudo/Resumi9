import AppNav from '../components/AppNav';
import DeleteEverything from '../components/account/DeleteEverything';
import LanguagePicker from '../components/account/LanguagePicker';
import LookingFor from '../components/account/LookingFor';
import { DEFAULT_LOCALE } from '../lib/locales';
import { DAILY_CREDITS, creditsLabel, hoursUntil, nextReset } from '../lib/credits';
import { requireUserId } from '../server/auth';
import { getUser } from '../server/db/repository';

/**
 * The account, and nothing about the resume.
 *
 * This page used to be /profile, and it listed every job and project a second
 * time — the same entries /setup already shows, except read-only. Two pages
 * claiming to be the resume is what made the navigation unreadable, so the
 * duplicate went and what is left is the things that are about the person
 * rather than the document.
 *
 * Two of them could not be changed anywhere until now: the spelling every
 * generated resume uses, and what this person is actually looking for.
 */
export default async function AccountPage() {
  const userId = await requireUserId();
  const user = await getUser(userId);

  const credits = user?.credits ?? 0;
  const resetAt = user?.creditsResetAt ?? nextReset();

  return (
    <main className="min-h-screen bg-ground font-sans text-ink">
      <AppNav active="account" credits={user?.credits} />

      <div className="mx-auto max-w-[720px] px-6 py-12 sm:px-8">
        <h1 className="font-serif text-[36px] leading-tight">Account</h1>
        <p className="mt-2.5 text-[15px] leading-relaxed text-ink-prose">
          Your sign-in, how your resumes are written, and what happens to your data. Your resume
          itself lives under <span className="text-ink">Resume</span>.
        </p>

        <div className="mt-10 flex flex-col gap-3.5">
          <Block title="Signed in as">
            <p className="text-[15px] text-ink">{user?.email ?? 'Unknown'}</p>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-muted">
              Your sign-in is handled by Clerk. Change your email or password from{' '}
              <span className="text-ink-prose">Manage account</span> in the menu under your picture.
            </p>
          </Block>

          <Block
            title="Language"
            note="Which English your resumes are written in."
          >
            <LanguagePicker current={user?.locale ?? DEFAULT_LOCALE} />
          </Block>

          <Block
            title="Relevance"
            note="What you are applying for, so a resume is pitched at that rather than at whatever your dates imply."
          >
            <LookingFor stage={user?.stage ?? null} targetField={user?.targetField ?? null} />
          </Block>

          <Block title="Applications">
            <div className="flex items-baseline gap-2.5">
              <span className="font-serif text-[34px] leading-none">{credits}</span>
              <span className="text-[13px] text-ink-faint">of {DAILY_CREDITS} left today</span>
            </div>
            <div className="mt-3.5 h-1 overflow-hidden rounded-sm bg-rule">
              <div
                className="h-full rounded-sm bg-accent"
                style={{ width: `${Math.round((credits / DAILY_CREDITS) * 100)}%` }}
              />
            </div>
            <p className="mt-3 text-[12.5px] leading-relaxed text-ink-muted">
              {credits > 0 ? `${creditsLabel(credits)}. ` : 'None left. '}
              Back to {DAILY_CREDITS} in {hoursUntil(resetAt)} hours.
            </p>
          </Block>

          {/*
            Last, and on its own. Everything above changes a setting; this one
            cannot be undone, so it does not sit in the same list as a language
            preference.
          */}
          <div className="mt-6 rounded border border-rule bg-ground-surface px-6 py-6">
            <span className="text-[11px] uppercase tracking-[0.12em] text-ink-faint">
              Your data
            </span>
            <p className="mt-2.5 text-[13.5px] leading-relaxed text-ink-prose">
              Everything Resumi9 holds about you &mdash; your resume, your entries, your rules and
              every application &mdash; can be removed permanently.
            </p>
            <div className="mt-4">
              <DeleteEverything />
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}

function Block({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded border border-rule bg-ground-surface px-6 py-6">
      <span className="text-[11px] uppercase tracking-[0.12em] text-ink-faint">{title}</span>
      {note ? <p className="mt-2 text-[13.5px] leading-relaxed text-ink-prose">{note}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}
