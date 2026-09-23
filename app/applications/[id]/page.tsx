import { notFound } from 'next/navigation';
import ApplicationView from '../../components/applications/ApplicationView';
import type { ApplicationStatus } from '../../components/applications/ApplicationRow';
import type { ResumeStructure, ResumeWarning } from '../../lib/types';
import { requireUserId } from '../../server/auth';
import { getActiveRules, getApplication, getLatestResume, getProfile, getResumeVersion, listResumeVersions } from '../../server/db/repository';
import { runChecks } from '../../lib/ruleCheck';
import { postingReadyToTailor } from '../../lib/readiness';
import { matchRequirements } from '../../lib/requirementMatch';
import type { RuleCheck } from '../../lib/rules';

/**
 * One application: its posting, and the resume written for it.
 *
 * Not two resumes side by side. At this moment you are checking the thing you
 * are about to send, not comparing it with what you had — comparison belongs in
 * the version history, where it is asked for rather than assumed.
 */
export default async function ApplicationPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { v?: string; tailor?: string };
}) {
  const userId = await requireUserId();

  const record = await getApplication(userId, params.id);
  if (!record) notFound();

  // Which version is being read, from the URL. Browsing history used to mean
  // restoring — the picker's only action copied a version forward — so looking
  // at what you had was indistinguishable from changing what you have.
  const asked = Number(searchParams?.v);
  const wanted = Number.isFinite(asked) && asked > 0 ? asked : null;

  const [latest, versions, rules, profile] = await Promise.all([
    getLatestResume(userId, params.id),
    listResumeVersions(userId, params.id),
    getActiveRules(userId),
    // For what the posting asks for against what the profile already says,
    // shown while a tailor writes. Read here so it arrives with the page.
    getProfile(userId),
  ]);

  // An unknown version falls back rather than 404s: a stale link should show
  // the resume, not an error page.
  const viewed =
    wanted && wanted !== latest?.version
      ? (await getResumeVersion(userId, params.id, wanted)) ?? latest
      : latest;

  const resume = viewed;
  const isLatest = !resume || !latest || resume.version === latest.version;
  const requirements = (record.posting?.requirements as string[]) ?? [];

  /*
   * Whether to start tailoring on arrival.
   *
   * `tailor=1` is set once, by the posting form, so this fires only on the way in
   * from pasting a posting — not on a link, a refresh (the page takes the flag
   * out of the address bar before it starts), or a walk back through history.
   * `!latest` is the guard that matters most: arriving at an application that
   * already has a resume must never spend a credit rewriting it. The posting is
   * checked here as well as in the form, because a URL is something anybody
   * can type.
   */
  const startTailor =
    searchParams?.tailor === '1' &&
    !latest &&
    postingReadyToTailor({ description: record.posting?.description ?? null, requirements });

  return (
    <ApplicationView
      applicationId={params.id}
      isLatest={isLatest}
      startTailor={startTailor}
      requirementMatch={matchRequirements((profile?.resumeStructure ?? null) as ResumeStructure | null, requirements)}
      /*
       * Checked here, not stored.
       *
       * Scanning a resume for a forbidden word costs nothing, so there is no
       * reason to persist a verdict that could go stale. Running it on render
       * also means a rule written today is applied to a resume tailored last
       * week — and says so.
       */
      ruleResults={
        viewed
          ? runChecks(
              viewed.structure as ResumeStructure,
              rules.map((r) => ({ id: r.id, text: r.text, check: (r.check as RuleCheck) ?? null })),
              // What the compiler said when this version was written. Null on
              // every version made before it was measured, and on any tailor
              // that ran short of budget — a page rule then reads as guidance,
              // never as a failure somebody cannot account for.
              { pages: viewed.pageCount },
            )
          : []
      }
      versions={versions.map((v) => ({ ...v, createdAt: v.createdAt.toISOString() }))}
      status={record.application.status as ApplicationStatus}
      posting={{
        company: record.posting?.company ?? null,
        role: record.posting?.role ?? null,
        location: record.posting?.location ?? null,
        description: record.posting?.description ?? null,
        sourceUrl: record.posting?.sourceUrl ?? null,
        requirements: (record.posting?.requirements as string[]) ?? [],
      }}
      resume={
        resume
          ? {
              structure: resume.structure as ResumeStructure,
              matchScore: resume.matchScore,
              missingRequirements: (resume.missingRequirements as string[]) ?? [],
              log: (resume.log as string[]) ?? [],
              warnings: (resume.warnings as ResumeWarning[]) ?? [],
              version: resume.version,
            }
          : null
      }
    />
  );
}
