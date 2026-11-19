/**
 * Acceptance, across people — the real pipeline, the real compiler, invented profiles.
 *
 *   ACCEPTANCE_USER_ID=user_... npx tsx scripts/acceptance.ts
 *   ACCEPTANCE_USER_ID=user_... npx tsx scripts/acceptance.ts swe-student
 *
 * **It spends money and it writes nothing.** One tailor and one claim check
 * per combination — sixteen of each at full size — and it touches no account
 * beyond metering the spend: it reads no profile, no rules and no postings
 * from the database. Everything it runs on is app/lib/fixtures/people.ts.
 *
 * It mirrors the tailor route's sequence rather than calling the route, which
 * needs a signed-in request. The order — annotate, model, resolve, honesty,
 * claim check, guard, fit — is the route's, and when the route's changes this
 * has to change with it. It had drifted three times by 16 Nov: `checkBullets`
 * lost an argument, the guard lost another, and the page target was pinned at
 * one, which meant it could not run at all for somebody whose rule says two.
 * A run then reported the behaviour of a fortnight earlier as what ships. The
 * arguments below are written one per line for that reason, so a change to
 * the route's call shows up as a diff here.
 *
 * **Why this as well as the unit suite.** app/lib/pipeline.test.ts runs the
 * same fixtures through the guard and the fitter with no model call and a
 * counted page, which is free and fast and catches what the APP decides. It
 * cannot catch what the MODEL decides, and it explicitly cannot catch a
 * pagination bug, because nothing in it compiles. This calls Claude and
 * compiles with tectonic, which is why it is a script and not a test.
 *
 * What used to live in this file ran against one real account and asserted
 * things about that person's employers, degree and coursework. It is now
 * scripts/personal-smoke.ts, and it is nobody's acceptance criteria.
 */
import fs from 'node:fs';
import { callClaude } from '../app/lib/anthropic';
import { TAILOR_INVARIANT, buildUserContext } from '../app/lib/systemPrompt';
import { annotate, cutTargets, resolveTailored, unreadable } from '../app/lib/provenance';
import { applyFlags, checkBullets, wholeRecord } from '../app/lib/honesty';
import {
  CLAIM_CHECK_PROMPT,
  CLAIM_CHECK_TOOL,
  claimCheckInput,
  flagsFromVerdicts,
  type ClaimVerdict,
} from '../app/lib/claimCheck';
import { surfaceRepairs, validateTailored } from '../app/lib/tailorGuard';
import { MAX_SKILL_LINES, fitToPages } from '../app/lib/fit';
import { pinsFromRules } from '../app/lib/pins';
import { pageLimit, type RuleCheck } from '../app/lib/rules';
import { splitTerms } from '../app/lib/names';
import { patternFor, waysOfWriting } from '../app/lib/requirementMatch';
import { renderResumeLatex } from '../app/lib/latexEngine';
import { LatexCompileError, compileWithMeta } from '../app/server/pdf';
import { tailorToolFor } from '../app/api/claude/shared';
import { PEOPLE, type Person } from '../app/lib/fixtures/people';

interface Run {
  who: string;
  failed?: string;
  pages?: number | null;
  target?: number;
  jobs?: string[];
  projects?: string[];
  skills?: string[];
  items?: string[];
  thin?: string[];
  dropped?: string[];
  log?: string[];
  warnings?: string[];
  reverted?: number;
  /** Of those, the ones satisfied by cutting a clause rather than reverting. */
  cutOnly?: number;
  /** And the ones that discarded the whole rewritten sentence. */
  revertedWhole?: number;
  moved?: string[];
  person?: Person;
  /** Share of printed bullets whose wording is not the profile's, 0–1. */
  rewritten?: number;
  /**
   * The same share BEFORE the honesty passes run, 0–1.
   *
   * The gap between this and `rewritten` is the whole subject of the revert
   * work: it is how much of the tailoring the checks took back. Measured
   * off the model's own `changed` flags, so it counts what was attempted
   * rather than what survived.
   */
  attempted?: number;
  /** Share of the person's posting-relevant skills that reach the page, 0–1. */
  covered?: number;
}

/**
 * How much tailoring actually survived to the page.
 *
 * Reverts are easy to drive down by rewriting less, and a resume that comes
 * back untouched reverts nothing and helps nobody. So the churn number is
 * never read on its own: these two say whether there was anything to revert.
 *
 * `rewritten` is the share of printed bullets whose wording is not verbatim
 * from the profile. `covered` is the share of the person's own skills that
 * this posting mentions which actually appear somewhere on the finished page
 * — their vocabulary, not the posting's, because a resume cannot cover a
 * requirement the person does not have and should not be scored for it.
 */
function tailoring(profile: Person['profile'], posting: string, page: Person['profile']) {
  const exact = new Set(
    [...(profile.experience ?? []), ...(profile.projects ?? [])]
      .flatMap((e) => e.bullets ?? [])
      .map((b) => b.replace(/\s+/g, ' ').trim().toLowerCase()),
  );
  const printed = [...(page.experience ?? []), ...(page.projects ?? [])].flatMap((e) => e.bullets ?? []);
  const rewritten = printed.length
    ? printed.filter((b) => !exact.has(b.replace(/\s+/g, ' ').trim().toLowerCase())).length / printed.length
    : 0;

  const says = (haystack: string, term: string) => {
    const safe = term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![a-z0-9])${safe}(?![a-z0-9])`).test(haystack.toLowerCase());
  };
  const theirs = (profile.skills ?? []).flatMap((g) => splitTerms(g.items ?? ''));
  const wanted = theirs.filter((t) => says(posting, t));
  const onPage = [
    ...(page.skills ?? []).map((g) => `${g.category} ${g.items}`),
    ...[...(page.experience ?? []), ...(page.projects ?? [])].flatMap((e: any) => [e.title, e.tech, ...(e.bullets ?? [])]),
  ].filter(Boolean).join(' \n ');
  const covered = wanted.length ? wanted.filter((t) => says(onPage, t)).length / wanted.length : 1;

  return { rewritten, covered, wanted: wanted.length };
}

async function main() {
  const env = Object.fromEntries(
    fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
      .split('\n')
      .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
      .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]),
  );
  for (const [k, v] of Object.entries(env)) if (!process.env[k]) process.env[k] = v as string;

  /*
   * An account id, for metering only.
   *
   * callClaude records spend and enforces the daily ceiling against a user,
   * so the calls have to be charged somewhere. Nothing else about that
   * account is read — not their profile, not their rules, not their
   * postings — which is the whole point of this file.
   */
  const userId = process.env.ACCEPTANCE_USER_ID;
  if (!userId) {
    console.error('Set ACCEPTANCE_USER_ID to the account this run\'s API spend should be metered against.');
    process.exit(1);
  }

  const only = process.argv[2];
  const people = only ? PEOPLE.filter((p) => new RegExp(only, 'i').test(p.name)) : PEOPLE;
  if (!people.length) {
    console.error(`No fixture matches "${only}". Known: ${PEOPLE.map((p) => p.name).join(', ')}`);
    process.exit(1);
  }

  const runs: Run[] = [];
  const tailors = people.reduce((n, p) => n + p.postings.length, 0);

  /*
   * Paced against the app's own burst limiter, not around it.
   *
   * Every call goes through callClaude, which refuses more than eight a
   * minute per account (BURST_PER_MINUTE.default in server/limits.ts) to stop
   * a runaway client. A combination costs two — a tailor and a claim check —
   * so a full matrix run at speed gets four combinations in and is refused
   * twelve times. The first run of this file did exactly that and reported
   * "4 of 16 completed" with two checks passing on a quarter of the evidence.
   *
   * The limiter is right and the harness was wrong, so it waits. Raising the
   * limit for a script would be turning off the thing that protects the
   * account the script is metered against.
   */
  const CALLS_PER_RUN = 2;
  const SPACING_MS = Math.ceil((60_000 / 8) * CALLS_PER_RUN) + 2_000;
  const pace = async (index: number) => {
    if (index === 0) return;
    process.stdout.write(`   …waiting ${Math.round(SPACING_MS / 1000)}s for the burst window\n`);
    await new Promise((resolve) => setTimeout(resolve, SPACING_MS));
  };

  const minutes = Math.ceil((tailors * SPACING_MS) / 60_000);
  console.log(`${people.length} profile(s), ${tailors} tailor(s), real compiles — about ${minutes} min\n`);
  let done = 0;

  for (const person of people) {
    const rules = person.rules.map((r) => ({ id: r.id, text: r.text, check: (r.check as RuleCheck) ?? null }));
    const limit = pageLimit(rules);
    const pins = pinsFromRules(person.rules, person.profile);

    for (const posting of person.postings) {
      const who = `${person.name} / ${posting.role}`;
      await pace(done);
      done += 1;
      const deadline = Date.now() + 110_000;
      try {
        const { profile: annotated, index } = annotate(person.profile, []);
        const { toolInput } = await callClaude<any>({
          userId,
          kind: 'tailor',
          system: TAILOR_INVARIANT,
          systemSuffix: buildUserContext({ displayName: person.profile.name, rules: [...person.rules] }),
          content: [{
            type: 'text' as const,
            text: [
              'Their profile — the Resume Structure to edit. This is the resume of record; keep the same entries, dates, and section identities, and rewrite freely within them. Every entry and bullet carries an id: return each entry\'s id unchanged, and name in each bullet\'s "from" the bullet or fact ids it is a rewrite of.',
              '```json', JSON.stringify(annotated), '```',
              `Job posting — Company: (not provided), Role: ${posting.role}\n${posting.text}`,
              'Produce the tailored resume now via submit_tailored_resume. The structure and the facts above are your only sources for what this person has done — tailor within them and invent nothing to fill gaps. A bullet you are leaving as it stands needs only its "from"; leave its text out.',
            ].join('\n\n'),
          }],
          tool: tailorToolFor({ hasSummary: Boolean(person.profile.summary?.trim()) }),
          deadline,
        });

        const resolved = resolveTailored(toolInput.structure, index);
        if (unreadable(resolved.bullets)) throw new Error('came back in a shape nothing could read');

        const flags = checkBullets(
          resolved.bullets,
          [],
          undefined,
          undefined,
          posting.text,
          wholeRecord(person.profile),
        );

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
        const guarded = validateTailored(person.profile, honest.structure, {
          posting: posting.text,
        });
        const fitted = await fitToPages(guarded.structure, {
          target: limit.target,
          targetIsTheirs: limit.theirs,
          cuts: cutTargets(toolInput.cutOrder, resolved.bullets, index, new Map(flags.map((f) => [f.text, f.revertTo]))),
          posting: posting.text,
          pinned: pins,
          // The real compiler. This is the half pipeline.test.ts cannot do.
          //
          // Retried once when the compiler is BUSY rather than broken: the
          // service holds two slots and refuses the third, and the fitter
          // measures many candidates in a row. A refusal is not a failed
          // resume, and treating it as one lost a whole combination out of a
          // sixteen-run baseline — which is the number everything after this
          // is measured against.
          measure: async (candidate) => {
            const latex = renderResumeLatex(candidate);
            try {
              return (await compileWithMeta(latex)).pages;
            } catch (err) {
              if (!(err instanceof LatexCompileError) || err.kind !== 'busy') throw err;
              await new Promise((resolve) => setTimeout(resolve, 3_000));
              return (await compileWithMeta(latex)).pages;
            }
          },
          affords: () => Date.now() < deadline,
        });

        const s = fitted.structure;
        /** Anything the pipeline is never allowed to rewrite, compared by value. */
        const moved: string[] = [];
        for (const before of person.profile.experience ?? []) {
          const after = (s.experience ?? []).find((e) => e.org === before.org);
          if (!after) continue;
          if (after.dates !== before.dates) moved.push(`${before.org} dates`);
          if (after.location !== before.location) moved.push(`${before.org} location`);
        }
        for (const before of person.profile.education ?? []) {
          const after = (s.education ?? []).find((e) => e.school === before.school);
          if (after && after.dates !== before.dates) moved.push(`${before.school} dates`);
        }

        runs.push({
          who,
          person,
          pages: fitted.pages,
          target: limit.target,
          jobs: s.experience.map((e) => e.org),
          projects: s.projects.map((p) => p.name),
          skills: (s.skills ?? []).map((g) => g.category),
          items: (s.skills ?? []).flatMap((g) => splitTerms(g.items ?? '')),
          /*
           * Thinned BY the pipeline, not arriving thin.
           *
           * The floor stops trimming; it does not pad. An entry the person
           * wrote one line for keeps one line, and flagging that reported
           * their own profile back to them as a fault.
           */
          thin: [...s.experience, ...s.projects]
            .filter((e: any) => {
              if ((e.bullets ?? []).length >= 2) return false;
              const name = e.org ?? e.name;
              const before = [...(person.profile.experience ?? []), ...(person.profile.projects ?? [])]
                .find((b: any) => (b.org ?? b.name) === name);
              return (before?.bullets ?? []).length >= 2;
            })
            .map((e: any) => e.org ?? e.name),
          dropped: fitted.dropped.map((d) => `${d.section}:${d.index}`),
          log: [...honest.log, ...surfaceRepairs(guarded.repairs).log, ...fitted.log],
          warnings: fitted.warnings,
          reverted: checked.length,
          cutOnly: honest.cut,
          revertedWhole: honest.reverted,
          moved,
          ...tailoring(person.profile, posting.text, s as Person['profile']),
          attempted: resolved.bullets.length
            ? resolved.bullets.filter((b) => b.changed).length / resolved.bullets.length
            : 0,
        });

        const r = runs[runs.length - 1];
        console.log(`${who}\n   ${r.pages}/${r.target}pp  ${r.jobs!.length}j/${r.projects!.length}p/${r.skills!.length}sk  flagged=${r.reverted} (${r.cutOnly} trimmed, ${r.revertedWhole} reverted)  rewrote ${(r.attempted! * 100).toFixed(0)}%→${(r.rewritten! * 100).toFixed(0)}%  covered=${(r.covered! * 100).toFixed(0)}%  (${claimNote})`);
        if (r.thin!.length) console.log(`   THIN: ${r.thin!.join(', ')}`);
        if (r.moved!.length) console.log(`   MOVED: ${r.moved!.join(', ')}`);
      } catch (err) {
        console.log(`${who}\n   DID NOT RUN: ${(err as Error).message.slice(0, 140)}`);
        runs.push({ who, failed: (err as Error).message });
      }
    }
  }

  // ── what has to hold for everybody ────────────────────────────────────────

  const live = runs.filter((r) => !r.failed);

  /*
   * A check with nothing to check is not a pass.
   *
   * Every check below filters the completed runs, and a filter over an empty
   * list is empty — so a run where every tailor failed once reported ten
   * passes, and the list was the deliverable.
   */
  const ok = (b: boolean) => (!live.length ? 'n/a' : b ? 'PASS' : 'FAIL');
  const offenders = (f: (r: Run) => boolean) => live.filter(f).map((r) => r.who);
  const failures: string[] = [];
  const check = (n: number, name: string, verdict: string, note = '') => {
    if (verdict === 'FAIL') failures.push(String(n));
    console.log(`${String(n).padStart(2)}. ${verdict.padEnd(5)} ${name}${note ? `\n            ${note}` : ''}`);
  };

  console.log(`\n\n══ acceptance, ${live.length} of ${runs.length} tailors completed ══\n`);
  for (const r of runs.filter((x) => x.failed)) {
    console.log(`   DID NOT RUN  ${r.who}\n                ${String(r.failed).slice(0, 110)}\n`);
  }
  if (!live.length) console.log('   Nothing ran, so nothing below is a pass.\n');

  /*
   * A partial run is a failed run, and says so before anything else.
   *
   * The first full baseline completed fifteen of sixteen and printed eight
   * passes under it. Every check here is a filter over what completed, so a
   * combination that never ran cannot fail anything — the missing one was
   * the profile with more skills lines than the cap, which is to say the one
   * most likely to break check 7. Reporting that as a pass is the same fault
   * as the empty-list pass guarded against below, one level up.
   */
  check(0, `All ${runs.length} combinations completed`, live.length === runs.length ? 'PASS' : 'FAIL',
    live.length === runs.length ? '' : `${runs.length - live.length} did not run — nothing below covers them`);

  const over = offenders((r) => r.pages !== null && r.pages! > r.target!);
  const silent = offenders((r) => r.pages !== null && r.pages! > r.target! && !r.warnings!.some((w) => /page/i.test(w)));
  check(1, 'Within the page limit, or the reason is given', ok(!silent.length),
    [over.length ? `over: ${over.join(', ')}` : '', silent.length ? `silently over: ${silent.join(', ')}` : ''].filter(Boolean).join('; '));

  const twice = offenders((r) => new Set(r.dropped!).size !== r.dropped!.length);
  check(2, 'Nothing is dropped twice', ok(!twice.length), twice.join(', '));

  const repeated = offenders((r) => new Set(r.jobs!).size !== r.jobs!.length || new Set(r.projects!).size !== r.projects!.length);
  check(3, 'Nothing is on the page twice', ok(!repeated.length), repeated.join(', '));

  const unreported = offenders((r) => r.dropped!.length > 0 && !r.log!.some((l) => /Dropped \d+ /.test(l)));
  check(4, 'Every drop is reported in the log', ok(!unreported.length), unreported.join(', '));

  check(5, 'Every entry keeps two or more bullets', ok(!live.some((r) => r.thin!.length)),
    live.filter((r) => r.thin!.length).map((r) => `${r.who} (${r.thin!.join(',')})`).join('; '));

  const rewritten = live.filter((r) => r.moved!.length).map((r) => `${r.who}: ${r.moved!.join(', ')}`);
  check(6, 'Dates, employers and locations are never rewritten', ok(!rewritten.length), rewritten.join('; '));

  const overCap = offenders((r) => r.skills!.length > MAX_SKILL_LINES);
  const dupItem = offenders((r) => {
    const lower = r.items!.map((t) => t.toLowerCase());
    return new Set(lower).size !== lower.length;
  });
  /*
   * "Theirs" is their whole record, not their skills section.
   *
   * The guard lets a tailor surface a skill the structure evidences anywhere
   * — a project whose tech line says FastAPI has FastAPI, whether or not the
   * skills section repeats it — and that is right: it is reporting, not
   * inventing. Comparing against the skills list alone failed a run for
   * surfacing a tool off the person's own project.
   */
  const notTheirs = live.flatMap((r) => {
    const record = wholeRecord(r.person!.profile);
    /*
     * Matched the way the app matches, not by exact string.
     *
     * A run failed for "Optimization" against a profile written
     * "Optimisation" — one word, two spellings, and the check was stricter
     * than the guard it is meant to be auditing. patternFor already folds
     * -ise/-ize and a separator only one side has.
     */
    return r.items!
      .filter((t) => !waysOfWriting(t).some((way) => patternFor(way).test(record)))
      .map((t) => `"${t}" on ${r.who}`);
  });
  check(7, `Skills ≤${MAX_SKILL_LINES} lines, nothing twice, nothing they never claimed`,
    ok(!overCap.length && !dupItem.length && !notTheirs.length),
    [overCap.length ? `over the cap: ${overCap.join(', ')}` : '',
     dupItem.length ? `listed twice: ${dupItem.join(', ')}` : '',
     notTheirs.length ? `not theirs: ${notTheirs.slice(0, 6).join('; ')}` : ''].filter(Boolean).join('; '));

  /*
   * Two postings for one person should not produce one resume. A tailor that
   * returns the same selection whatever the job is not tailoring.
   */
  /*
   * Counted over the people who were ASKED, not the people who answered.
   *
   * This filtered to people with two completed runs and then reported "7 of
   * 7" on a run where one person had completed one — a pass computed by
   * excluding the evidence against it.
   */
  const asked = people.filter((p) => p.postings.length >= 2);
  const varied = asked.map((p) => {
    const mine = live.filter((r) => r.person?.name === p.name);
    const differed = mine.length >= 2 && new Set(mine.map((r) => r.items!.join('|'))).size > 1;
    /*
     * How much room there was to differ, so a pass and a near-impossibility
     * are not reported as the same thing.
     *
     * Somebody with one skills line and four terms cannot select
     * differently for two postings in any meaningful way — the fitter cannot
     * drop a line below the floor and there is almost nothing to reorder.
     * Somebody over the cap MUST choose, and choosing the same twice for two
     * different jobs is a real failure.
     */
    const terms = (p.profile.skills ?? []).flatMap((g) => splitTerms(g.items ?? '')).length;
    const lines = (p.profile.skills ?? []).length;
    const room = lines > MAX_SKILL_LINES ? 'must choose' : terms >= 12 ? 'plenty' : 'little';
    return { name: p.name, differed, room, terms, lines };
  });
  const realFailures = varied.filter((v) => !v.differed && v.room !== 'little');
  check(8, 'One person\'s two postings tailor differently',
    asked.length ? ok(!realFailures.length) : 'n/a',
    asked.length
      ? `${varied.filter((v) => v.differed).length} of ${asked.length} differed. ` +
        varied.map((v) => `${v.name}[${v.lines}L/${v.terms}t ${v.room}]=${v.differed ? 'differs' : 'SAME'}`).join('  ')
      : 'needs both postings per person');

  /*
   * Split, with the old total still printed beside it.
   *
   * The single number counted flags raised, and once a flag could be
   * satisfied by cutting one clause it stopped describing the harm: a resume
   * that lost three tailored sentences and one that lost three adverbs
   * scored the same. The whole-bullet count is the one that hurts. The old
   * total stays so a run before this change and a run after it can still be
   * put side by side.
   */
  const flagged = live.reduce((n, r) => n + (r.reverted ?? 0), 0);
  const whole = live.reduce((n, r) => n + (r.revertedWhole ?? 0), 0);
  const trimmed = live.reduce((n, r) => n + (r.cutOnly ?? 0), 0);
  const per = (n: number) => (n / Math.max(1, live.length)).toFixed(1);
  check(9, 'Whole-bullet reverts stay under two a resume',
    live.length ? ok(whole / live.length < 2) : 'n/a',
    `${per(whole)} whole-bullet reverts and ${per(trimmed)} clause trims per resume ` +
    `— ${flagged} flags across ${live.length} resumes (${per(flagged)} each, the old single number)`);

  /*
   * Read beside check 9, never instead of it. Driving reverts down by
   * rewriting less is not an improvement, and these are how that shows.
   */
  const avg = (f: (r: Run) => number) => (live.length ? live.reduce((n, r) => n + f(r), 0) / live.length : 0);
  /*
   * A monitor, not a gate.
   *
   * The threshold here was a guess made before anybody knew what normal
   * looked like — ≥50%, set while building the metric, and never met. The
   * share of bullets rewritten is also the wrong thing to hold a build to:
   * selection and ordering are tailoring too, and a gate on rewriting rewards
   * writing more, which is the direction that invents things. Reported on
   * every run because the number is worth watching; never failed on.
   */
  const shipped = avg((r) => r.rewritten!);
  const attempted = avg((r) => r.attempted!);
  check(11, 'Bullets rewritten (monitor, never fails)', live.length ? 'note' : 'n/a',
    `${(shipped * 100).toFixed(0)}% of printed bullets differ from the profile's wording ` +
    `(the model rewrote ${(attempted * 100).toFixed(0)}%)`);

  /*
   * The gate is the gap: what the checks take back from an evidenced rewrite.
   *
   * This is the number the revert work was aimed at and the one that is
   * robust run to run, because it is a difference measured WITHIN a run —
   * how much the model wrote varies by several points between passes, and
   * subtracting it cancels that out.
   *
   * Measured over three passes of sixteen combinations: 20, 22 and 23 points
   * before the span-level reverts, and 9, 13 and 10 after. The gate sits at
   * 15 — above the observed range by enough that one drifting pass does not
   * flake it, and far enough below the old floor of 20 that a regression to
   * whole-bullet reverting cannot pass.
   */
  const GAP_CEILING = 0.15;
  const gap = Math.max(0, attempted - shipped);
  check(13, `The checks take back no more than ${(GAP_CEILING * 100).toFixed(0)} points of tailoring`,
    live.length ? ok(gap <= GAP_CEILING) : 'n/a',
    `${(gap * 100).toFixed(0)} points taken back (was 20–23 before span-level reverts, 9–13 after)`);
  check(12, 'Posting-relevant skills reach the page', live.length ? ok(avg((r) => r.covered!) >= 0.8) : 'n/a',
    `${(avg((r) => r.covered!) * 100).toFixed(0)}% of the skills they have that this posting names`);

  const idle = offenders((r) => r.dropped!.length === 0 && r.log!.length === 0);
  check(10, 'The fitter was exercised by most of the matrix',
    live.length ? ok(idle.length <= live.length / 2) : 'n/a',
    idle.length ? `did nothing on: ${idle.join(', ')}` : '');

  if (failures.length) {
    console.log(`\n${failures.length} check(s) failed: ${failures.join(', ')}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
