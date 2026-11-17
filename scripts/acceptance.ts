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
import { renderResumeLatex } from '../app/lib/latexEngine';
import { compileWithMeta } from '../app/server/pdf';
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
  moved?: string[];
  person?: Person;
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
  console.log(`${people.length} profile(s), ${tailors} tailor(s), real compiles\n`);

  for (const person of people) {
    const rules = person.rules.map((r) => ({ id: r.id, text: r.text, check: (r.check as RuleCheck) ?? null }));
    const limit = pageLimit(rules);
    const pins = pinsFromRules(person.rules, person.profile);

    for (const posting of person.postings) {
      const who = `${person.name} / ${posting.role}`;
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
          measure: async (candidate) => (await compileWithMeta(renderResumeLatex(candidate))).pages,
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
          moved,
        });

        const r = runs[runs.length - 1];
        console.log(`${who}\n   ${r.pages}/${r.target}pp  ${r.jobs!.length}j/${r.projects!.length}p/${r.skills!.length}sk  reverted=${r.reverted} (${claimNote})`);
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
  const check = (n: number, name: string, verdict: string, note = '') =>
    console.log(`${String(n).padStart(2)}. ${verdict.padEnd(5)} ${name}${note ? `\n            ${note}` : ''}`);

  console.log(`\n\n══ acceptance, ${live.length} of ${runs.length} tailors completed ══\n`);
  for (const r of runs.filter((x) => x.failed)) {
    console.log(`   DID NOT RUN  ${r.who}\n                ${String(r.failed).slice(0, 110)}\n`);
  }
  if (!live.length) console.log('   Nothing ran, so nothing below is a pass.\n');

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
  const notTheirs = live.flatMap((r) => {
    const theirs = new Set((r.person!.profile.skills ?? []).flatMap((g) => splitTerms(g.items ?? '')).map((t) => t.toLowerCase()));
    return r.items!.filter((t) => !theirs.has(t.toLowerCase())).map((t) => `"${t}" on ${r.who}`);
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
  const varied = PEOPLE.map((p) => {
    const mine = live.filter((r) => r.person?.name === p.name);
    return mine.length < 2 ? null : new Set(mine.map((r) => r.items!.join('|'))).size > 1;
  }).filter((v): v is boolean => v !== null);
  check(8, 'One person\'s two postings tailor differently',
    varied.length ? ok(varied.every(Boolean)) : 'n/a',
    varied.length ? `${varied.filter(Boolean).length} of ${varied.length} people` : 'needs both postings per person');

  const reverts = live.reduce((n, r) => n + (r.reverted ?? 0), 0);
  check(9, 'Revert churn stays under two bullets a resume',
    live.length ? ok(reverts / live.length < 2) : 'n/a',
    `${reverts} reverted across ${live.length} resumes (${(reverts / Math.max(1, live.length)).toFixed(1)} each)`);

  const idle = offenders((r) => r.dropped!.length === 0 && r.log!.length === 0);
  check(10, 'The fitter was exercised by most of the matrix',
    live.length ? ok(idle.length <= live.length / 2) : 'n/a',
    idle.length ? `did nothing on: ${idle.join(', ')}` : '');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
