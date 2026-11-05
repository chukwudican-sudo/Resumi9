/**
 * The Nov 4 bug report's acceptance tests, re-run against real postings.
 *
 *   npx tsx scripts/acceptance.ts            # every posting of that run
 *   npx tsx scripts/acceptance.ts "Deep Learning"   # one, by role
 *
 * **It spends money and it writes nothing.** Eleven tailors and eleven claim
 * checks, about fifty cents, and every read is a select — no resume is saved,
 * no credit is spent, nothing in the account changes. That is deliberate: the
 * report's own instruction is "re-run the same 11 postings after the fixes",
 * and a run that saved its results would bury the real history under harness
 * output.
 *
 * It mirrors the tailor route's sequence rather than calling the route, which
 * needs a signed-in request. The order below — annotate, model, resolve,
 * honesty, claim check, guard, fit — is the route's, and if the route's order
 * changes this has to change with it. The alternative was a harness that
 * could not run at all, since the route saves and saving is the one thing
 * this must not do.
 *
 * Lives here rather than in the test suite because it needs tectonic, an API
 * key, and a minute of wall clock. It lives in the repo rather than in a
 * scratch directory because it has now been lost twice to a cleaned temp
 * folder, both times immediately before somebody asked for its results.
 */
import postgres from 'postgres';
import fs from 'node:fs';
import { callClaude } from '../app/lib/anthropic';
import { TAILOR_INVARIANT, buildUserContext } from '../app/lib/systemPrompt';
import { annotate, cutTargets, resolveTailored, unreadable } from '../app/lib/provenance';
import { applyFlags, checkBullets } from '../app/lib/honesty';
import {
  CLAIM_CHECK_PROMPT,
  CLAIM_CHECK_TOOL,
  claimCheckInput,
  flagsFromVerdicts,
  type ClaimVerdict,
} from '../app/lib/claimCheck';
import { surfaceRepairs, validateTailored } from '../app/lib/tailorGuard';
import { fitToPages } from '../app/lib/fit';
import { pinsFromRules } from '../app/lib/pins';
import { renderResumeLatex } from '../app/lib/latexEngine';
import { compileWithMeta } from '../app/server/pdf';
import { tailorToolFor } from '../app/api/claude/shared';
import type { ResumeStructure } from '../app/lib/types';

/** The eleven phrases the report tabulates as lifted from the postings. */
const LIFTED = [
  'flag anomalies', 'tracking data quality', 'latency constraints', 'integration checks before merge',
  'endpoint logic for consumers', 'AI-assisted development', 'against baseline',
  'prepare data for the models', 'multi-discipline', 'defect tracking', 'trend analysis and reporting',
];

/**
 * Skills the person said they are taking off their profile.
 *
 * Docker, Excel, PowerPoint and Microsoft 365 are NOT here: the report guessed
 * the model was adding them and they were in the profile all along, so they
 * are real skills and stay.
 */
const UNVERIFIED = ['Cybersecurity', 'ChatGPT', 'AI-Assisted Development Tools'];

async function main() {
  const env = Object.fromEntries(
    fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
      .split('\n')
      .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
      .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]),
  );
  for (const [k, v] of Object.entries(env)) if (!process.env[k]) process.env[k] = v as string;

  const sql = postgres(env.DATABASE_URL, { prepare: false, max: 1 });

  // The account that made the apply run the report is about: whoever produced
  // the most resumes in it. Named by what they did rather than by an id, so the
  // script carries nobody's identity.
  const [{ user_id: userId }] = await sql`
    select r.user_id from resumes r
    where r.created_at > '2026-11-04 21:00'
    group by r.user_id order by count(*) desc limit 1`;

  const [{ resume_structure: base }] = await sql`select resume_structure from profiles where user_id = ${userId}`;
  const rules = (await sql`
    select id, text, "check" from rules
    where user_id = ${userId} and active = true order by order_index`) as unknown as {
    id: string;
    text: string;
    check: unknown;
  }[];
  const supporting = (await sql`
    select f.category, f.text, f.entry_id as "entryId", coalesce(pe.org, pe.title) as "entryName"
    from facts f left join profile_entries pe on pe.id = f.entry_id
    where f.user_id = ${userId} and f.status = 'active' and f.category not in ('identity','skill')
    limit 80`) as unknown as { text: string; entryId: string | null; entryName: string | null }[];
  const [user] = await sql`
    select display_name as "displayName", locale, stage, target_field as "targetField"
    from users where id = ${userId}`;
  const postings = (await sql`
    select p.company, p.role, p.description, p.requirements
    from job_postings p
    join applications a on a.posting_id = p.id
    join resumes r on r.application_id = a.id
    where r.created_at > '2026-11-04 21:00' and r.user_id = ${userId}
    group by p.id, p.company, p.role, p.description, p.requirements
    order by min(r.created_at)`) as unknown as {
    company: string | null;
    role: string | null;
    description: string | null;
    requirements: unknown;
  }[];
  await sql.end();

  const structure = base as ResumeStructure;
  const only = process.argv[2];
  const chosen = only ? postings.filter((p) => new RegExp(only, 'i').test(String(p.role))) : postings;
  const PINS = pinsFromRules(rules, structure);

  console.log(`profile: ${structure.experience.length} jobs, ${structure.projects.length} projects, ${(structure.skills ?? []).length} skills lines`);
  for (const r of rules) console.log(`   rule: ${r.check ? 'Checked ' : 'Guidance'} — ${String(r.text).slice(0, 78)}`);
  console.log(`pinned by a rule: ${PINS.map((p) => p.label).join(', ') || 'nothing'}`);
  console.log(`\nrunning ${chosen.length} posting(s)\n`);

  interface Result {
    label: string;
    failed?: string;
    pages?: number | null;
    jobs?: string[];
    projects?: string[];
    skills?: string[];
    skillItems?: string;
    thin?: string[];
    coursework?: string;
    degree?: string;
    projectDates?: string[];
    text?: string;
    claims?: number;
    claimNote?: string;
    log?: string[];
  }

  const results: Result[] = [];

  for (const posting of chosen) {
    const label = `${String(posting.company ?? '?').slice(0, 14)} / ${String(posting.role ?? '?').slice(0, 42)}`;
    const postingWords = [posting.description ?? '', ((posting.requirements as string[]) ?? []).join(' ')].join(' \n ');
    const deadline = Date.now() + 110_000;

    try {
      const { profile: annotated, index } = annotate(structure, supporting);
      const said = supporting.length
        ? 'Also true of this person, in their own words, from questions they have answered — the `facts` list above. These are NOT yet on the resume. Use any that the posting makes relevant, worked into an existing entry rather than added as a new one, and name its id in that bullet\'s "from". They are the only other thing you may draw on, and you may not extrapolate beyond what each one says.'
        : null;

      const { toolInput } = await callClaude<any>({
        userId,
        kind: 'tailor',
        system: TAILOR_INVARIANT,
        systemSuffix: buildUserContext({
          displayName: structure.name || user?.displayName,
          locale: user?.locale,
          rules,
          stage: user?.stage,
          targetField: user?.targetField,
        }),
        content: [{
          type: 'text' as const,
          text: [
            'Their profile — the Resume Structure to edit. This is the resume of record; keep the same entries, dates, and section identities, and rewrite freely within them. Every entry and bullet carries an id: return each entry\'s id unchanged, and name in each bullet\'s "from" the bullet or fact ids it is a rewrite of.',
            '```json', JSON.stringify(annotated), '```',
            said,
            `Job posting — Company: ${posting.company ?? '(not provided)'}, Role: ${posting.role ?? '(not provided)'}\n${posting.description ?? '(no description)'}`,
            'Produce the tailored resume now via submit_tailored_resume. The structure and the facts above are your only sources for what this person has done — tailor within them and invent nothing to fill gaps. A bullet you are leaving as it stands needs only its "from"; leave its text out.',
          ].filter(Boolean).join('\n\n'),
        }],
        tool: tailorToolFor({ hasSummary: Boolean(structure.summary?.trim()) }),
        deadline,
      });

      const resolved = resolveTailored(toolInput.structure, index);
      if (unreadable(resolved.bullets)) throw new Error('came back in a shape nothing could read');

      const flags = checkBullets(resolved.bullets, (posting.requirements as string[]) ?? [], undefined, undefined, postingWords);
      let checked = flags;
      let claimNote = 'nothing to ask about';
      const asking = claimCheckInput(resolved.bullets);
      if (asking.length) {
        try {
          const { toolInput: verdicts } = await callClaude<{ verdicts: ClaimVerdict[] }>({
            userId,
            kind: 'claim_check',
            system: CLAIM_CHECK_PROMPT,
            content: [{ type: 'text' as const, text: JSON.stringify(asking) }],
            tool: CLAIM_CHECK_TOOL,
            deadline,
          });
          const read = flagsFromVerdicts(verdicts?.verdicts ?? [], resolved.bullets);
          const already = new Set(flags.map((f) => f.text));
          checked = [...flags, ...read.flags.filter((f) => !already.has(f.text))];
          claimNote = `${asking.length} asked, ${read.flags.length} flagged, ${read.discarded} discarded`;
        } catch (err) {
          claimNote = `failed: ${(err as Error).message.slice(0, 40)}`;
        }
      }

      const honest = applyFlags(resolved.structure, checked);
      const guarded = validateTailored(structure, honest.structure, {
        alsoSaid: supporting.map((f) => f.text).join(' \n '),
      });
      const fitted = await fitToPages(guarded.structure, {
        target: 1,
        cuts: cutTargets(toolInput.cutOrder, resolved.bullets, index, new Map(flags.map((f) => [f.text, f.revertTo]))),
        posting: postingWords,
        pinned: PINS,
        measure: async (candidate) => (await compileWithMeta(renderResumeLatex(candidate))).pages,
        affords: () => Date.now() < deadline,
      });

      const s = fitted.structure;
      const result: Result = {
        label,
        pages: fitted.pages,
        jobs: s.experience.map((e) => e.org),
        projects: s.projects.map((p) => p.name),
        skills: (s.skills ?? []).map((g) => g.category),
        skillItems: (s.skills ?? []).map((g) => g.items).join(', '),
        thin: [...s.experience, ...s.projects].filter((e) => (e.bullets ?? []).length < 2).map((e: any) => e.org ?? e.name),
        coursework: (s.education ?? []).flatMap((e) => e.bullets ?? []).join(' '),
        degree: (s.education ?? []).map((e) => `${e.degree} ${e.dates}`).join(' | '),
        projectDates: s.projects.map((p) => String(p.dates ?? '')),
        text: JSON.stringify(s),
        claims: checked.length,
        claimNote,
        log: [...honest.log, ...surfaceRepairs(guarded.repairs).log, ...fitted.log],
      };
      results.push(result);

      console.log(`${label}\n   ${result.pages}pg  ${result.jobs!.length}j/${result.projects!.length}p/${result.skills!.length}sk  claims=${result.claims} (${claimNote})`);
      console.log(`   jobs:   ${result.jobs!.join(', ')}`);
      console.log(`   skills: ${result.skills!.join(', ')}`);
      if (result.thin!.length) console.log(`   THIN: ${result.thin!.join(', ')}`);
    } catch (err) {
      console.log(`${label}\n   DID NOT RUN: ${(err as Error).message.slice(0, 150)}`);
      results.push({ label, failed: (err as Error).message });
    }
  }

  // ── the report's checks ────────────────────────────────────────────────────

  const live = results.filter((r) => !r.failed);

  /*
   * A check with nothing to check is not a pass.
   *
   * Every "does any resume break this" test is a filter over the completed
   * runs, and a filter over an empty list is empty — so a run where every
   * posting failed reported ten passes. It did that once, and the list was the
   * deliverable.
   */
  const ok = (b: boolean) => (!live.length ? 'n/a' : b ? 'PASS' : 'FAIL');
  const some = (f: (r: Result) => boolean) => live.filter(f).map((r) => r.label.split(' / ')[1]?.slice(0, 22));
  const check = (n: number, name: string, verdict: string, note = '') =>
    console.log(`${String(n).padStart(2)}. ${verdict.padEnd(5)} ${name}${note ? `\n            ${note}` : ''}`);

  console.log(`\n\n══ acceptance tests, ${live.length} of ${results.length} postings completed ══\n`);
  for (const r of results.filter((x) => x.failed)) {
    console.log(`   DID NOT RUN  ${r.label}\n                ${String(r.failed).slice(0, 110)}\n`);
  }
  if (!live.length) console.log('   Nothing ran, so nothing below is a pass.\n');

  check(1, 'One page (11pt / 0.5in margins are template constants)', ok(!some((r) => r.pages !== 1).length),
    some((r) => r.pages !== 1).join(', '));

  /*
   * Checks 2 and 3 named one employer each, from a report about one person's
   * resume. The rule the app owes everybody is the general one — a pinned entry
   * is never dropped — and that account is one instance of it.
   */
  const lost = live.flatMap((r) =>
    PINS.filter((pin) => {
      const where = pin.place === 'experience' ? r.jobs!.join(' | ')
        : pin.place === 'projects' ? r.projects!.join(' | ')
        : `${r.skillItems} ${r.skills!.join(' ')}`;
      return !new RegExp(pin.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(where);
    }).map((pin) => `${pin.label} off ${r.label.split(' / ')[1]?.slice(0, 18)}`),
  );
  check(2, 'Everything a rule pins survives on every resume',
    PINS.length ? ok(!lost.length) : 'n/a',
    PINS.length ? lost.join('; ') : 'no rule carries an always_include check');

  const bp = live.find((r) => /Buying and Planning/i.test(r.label));
  check(4, 'Celestica B&P keeps Western Bell + the cylinder bullet',
    bp ? ok(bp.jobs!.some((j) => /Western/i.test(j)) && /cylinder/i.test(bp.text!)) : 'n/a',
    bp ? `jobs: ${bp.jobs!.join(', ')}` : 'that posting was not in this run');

  const fewJobs = some((r) => r.jobs!.length < 3);
  const unreported = some((r) => r.jobs!.length < structure.experience.length && !r.log!.some((l) => /Dropped \d+ role/.test(l)));
  check(5, '3+ jobs; any drop reported', ok(!fewJobs.length && !unreported.length),
    [fewJobs.length ? `under 3: ${fewJobs.join(', ')}` : '', unreported.length ? `unreported: ${unreported.join(', ')}` : ''].filter(Boolean).join('; '));

  const thin = live.filter((r) => r.thin!.length).map((r) => `${r.label.split(' / ')[1]?.slice(0, 18)} (${r.thin!.join(',')})`);
  check(6, 'Every entry has 2+ bullets', ok(!thin.length), thin.join('; '));

  const reappeared = live.flatMap((r) =>
    LIFTED.filter((phrase) => new RegExp(phrase, 'i').test(r.text!))
      .map((phrase) => `"${phrase}" on ${r.label.split(' / ')[1]?.slice(0, 18)}`),
  );
  check(7, 'No phrase from the claim-safety table reappears', ok(!reappeared.length), reappeared.join('; '));
  if (live.length) {
    console.log(`            claim check: ${live.reduce((n, r) => n + (r.claims ?? 0), 0)} bullets reverted across ${live.length} resumes`);
  }

  const tooMany = some((r) => r.skills!.length > 5);
  const dupCat = some((r) => new Set(r.skills!.map((c) => c.toLowerCase())).size !== r.skills!.length);
  const dupItem = some((r) => {
    const items = r.skillItems!.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
    return new Set(items).size !== items.length;
  });
  const unverified = [...new Set(live.flatMap((r) => UNVERIFIED.filter((t) => new RegExp(`\\b${t}\\b`, 'i').test(r.skillItems!))))];
  check(8, 'Skills ≤5 rows, no duplicate items or categories, verified only',
    ok(!tooMany.length && !dupCat.length && !dupItem.length && !unverified.length),
    [tooMany.length ? `over 5 rows: ${tooMany.join(', ')}` : '', dupCat.length ? `duplicate category: ${dupCat.join(', ')}` : '',
     dupItem.length ? `duplicate item: ${dupItem.join(', ')}` : '',
     unverified.length ? `in profile but unwanted: ${unverified.join(', ')}` : ''].filter(Boolean).join('; '));

  const wanted = [['FastAPI', /Applied AI Engineer/i], ['Figma', /User Experience/i], ['pytest', /Test Engineer/i]] as const;
  const missingWanted = wanted.filter(([term, where]) => {
    const row = live.find((r) => where.test(r.label));
    return row && !new RegExp(term, 'i').test(row.text!);
  }).map(([term]) => term);
  const distinct = new Set(live.map((r) => r.skillItems)).size;
  check(9, 'Skills differ between postings; FastAPI / Figma / pytest where asked',
    live.length < 2 ? 'n/a' : ok(distinct > 1 && !missingWanted.length),
    live.length < 2
      ? 'needs more than one posting to compare'
      : `${distinct} distinct skill lists across ${live.length}${missingWanted.length ? `; missing: ${missingWanted.join(', ')}` : ''}`);

  const courses = [['Intel', /Digital Systems/i], ['Electronic Art', /Linear Algebra/i]] as const;
  const missingCourse = courses.filter(([company, course]) => {
    const row = live.find((r) => r.label.startsWith(company));
    return row && !course.test(row.coursework!);
  }).map(([company]) => company);
  const anyCourse = courses.some(([company]) => live.some((r) => r.label.startsWith(company)));
  check(10, 'Intel lists Digital Systems; EA lists Linear Algebra',
    anyCourse ? ok(!missingCourse.length) : 'n/a',
    anyCourse ? (missingCourse.length ? `missing on: ${missingCourse.join(', ')}` : '') : 'neither posting was in this run');

  check(12, 'Degree reads "Sep 2023 – Apr 2028 (Expected)" and "(Co-op)"',
    ok(live.every((r) => /Apr 2028/.test(r.degree!) && /Co-?op/i.test(r.degree!))),
    live[0]?.degree ?? '');

  /*
   * Reverse chronological, by the same reading recencyKey uses: a date with no
   * month counts as the END of its year, so a project dated "2026" sits above
   * one finished in August 2026.
   */
  const outOfOrder = live.filter((r) => {
    const dates = r.projectDates!;
    const key = (d: string) => {
      if (/present|current/i.test(d)) return Number.MAX_SAFE_INTEGER;
      const years = d.match(/(20\d{2})/g);
      if (!years) return 0;
      const year = Number(years[years.length - 1]);
      const month = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.exec(d.slice(d.lastIndexOf(years[years.length - 1]) - 9));
      const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
      return year * 12 + (month ? months.indexOf(month[1].toLowerCase()) + 1 : 12);
    };
    for (let i = 1; i < dates.length; i += 1) if (key(dates[i]) > key(dates[i - 1])) return true;
    return false;
  }).map((r) => r.label.split(' / ')[1]?.slice(0, 20));
  check(14, 'Projects in reverse chronological order', ok(!outOfOrder.length), outOfOrder.join(', '));

  console.log('\n11, 13, 15 and 16 are not readable from the tailor pipeline: the header is rendering (compile a');
  console.log('resume and read the PDF), the remote flag and title variant are profile fields, filenames are');
  console.log('lib/filename.ts, and the revision test needs the edit route. Reported separately.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
