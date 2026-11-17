import test from 'node:test';
import assert from 'node:assert/strict';
import { PEOPLE, type Person } from './fixtures/people';
import { fitToPages, MAX_SKILL_LINES } from './fit';
import { validateTailored } from './tailorGuard';
import { pageTarget, type RuleCheck } from './rules';
import { pinsFromRules } from './pins';
import { splitTerms } from './names';
import type { CutTarget } from './provenance';
import type { ResumeStructure } from './types';

/**
 * What has to hold for every person, not just the one the app was built with.
 *
 * The acceptance suite this complements runs the real model against real
 * postings, and it was written around a single account: it asserts a
 * particular employer survives a particular posting, that one degree reads
 * "Apr 2028", that a named course appears. Those checks cannot fail for
 * anybody else, because nobody else is in them — and a regression that only
 * shows on a two-page senior resume, or a profile with no projects, passes
 * everything and ships. One did: a project was offered to the cutter twice
 * and came off the page twice, and the suite was green.
 *
 * So this runs the deterministic half of the pipeline — the guard and the
 * fitter, which is where almost all of the app's own judgement lives — across
 * eight profile shapes and sixteen postings, and asserts only things that are
 * true for everybody. No name, no employer, no course, no date appears in an
 * assertion.
 *
 * **The model is not called.** It is stood in for by `asTailored` below, which
 * does what a well-behaved tailor does and nothing a misbehaving one does.
 * That is the point: these are the app's invariants, and they must hold
 * whatever came back. The live run against real postings is still
 * `scripts/acceptance.ts`, which needs an API key and a minute of wall clock.
 */

/**
 * Pages, counted rather than compiled — a driver, not a model of the template.
 *
 * Said plainly because the first version of this pretended otherwise. A real
 * compile is about a second and the fitter measures many candidates per run,
 * so compiling this matrix is minutes; tectonic is also not a given in CI. The
 * number below is therefore chosen to make these profiles overflow, not to
 * predict where the real template breaks a page — measured against tectonic,
 * all eight of them genuinely fit on one page, and a suite that lets the
 * fitter sit idle asserts nothing while reporting passes.
 *
 * What that costs is real and worth naming: these tests cannot catch a
 * pagination bug. What they catch is everything the fitter DOES once it is
 * cutting — which is where its judgement lives, and where the regression that
 * prompted this suite was. Real pagination is checked by the live run in
 * scripts/acceptance.ts, against tectonic.
 */
const LINES_PER_PAGE = 30;
const measurePages = async (s: ResumeStructure): Promise<number> => {
  const entries = [...(s.experience ?? []), ...(s.projects ?? []), ...(s.education ?? [])];
  const lines =
    4 + // name and contact block
    entries.reduce((n, e) => n + 2 + (e.bullets ?? []).length, 0) +
    (s.skills ?? []).length +
    3; // section headings
  return Math.max(1, Math.ceil(lines / LINES_PER_PAGE));
};

/**
 * A tailored resume, as a well-behaved model would return it.
 *
 * Reordered and reworded within each entry — which is what tailoring is —
 * and nothing else: no entry added or removed, no date, employer or location
 * touched. Anything the app does to this is the app's own doing, which is
 * what makes a failure here readable.
 */
function asTailored(profile: ResumeStructure, posting: string): ResumeStructure {
  const wanted = (text: string) =>
    splitTerms(text).filter((t) => t && new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(posting)).length;
  const lead = <T extends { bullets?: string[] }>(items: T[], score: (x: T) => number) =>
    [...items].sort((a, b) => score(b) - score(a));

  return {
    ...profile,
    experience: lead(profile.experience ?? [], (e) => wanted(`${e.title}, ${(e.bullets ?? []).join(', ')}`)),
    projects: lead(profile.projects ?? [], (p) => wanted(p.tech ?? '')),
    skills: (profile.skills ?? []).map((g) => ({ ...g })),
  };
}

/**
 * A cut ranking, as the model is asked to produce one.
 *
 * Not optional detail. The fitter takes two inputs — the model's ranking and
 * its own fallback order — and the bug this suite was built for lives in the
 * seam between them: an entry the ranking had already taken was offered again
 * by a later pass that walked the section by index. Run with `cuts: []` the
 * seam does not exist, the suite went green on the broken build, and a
 * regression test that cannot see its own regression is worse than none.
 *
 * Shaped like a real one: every entry and every bullet, least relevant first,
 * entries interleaved with bullets rather than listed after them.
 */
function rankedCuts(profile: ResumeStructure, posting: string): CutTarget[] {
  const hits = (text: string) =>
    splitTerms(text).filter((t) => t && new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(posting)).length;

  const scored: { score: number; targets: CutTarget[] }[] = [];
  for (const entry of profile.experience ?? []) {
    scored.push({
      score: hits(`${entry.title}, ${(entry.bullets ?? []).join(', ')}`),
      targets: [
        { kind: 'entry', section: 'experience', name: entry.org, dates: entry.dates },
        ...(entry.bullets ?? []).map((text) => ({ kind: 'bullet' as const, text })),
      ],
    });
  }
  for (const project of profile.projects ?? []) {
    scored.push({
      score: hits(`${project.tech ?? ''}, ${(project.bullets ?? []).join(', ')}`),
      targets: [
        { kind: 'entry', section: 'projects', name: project.name, dates: String(project.dates ?? '') },
        ...(project.bullets ?? []).map((text) => ({ kind: 'bullet' as const, text })),
      ],
    });
  }
  return scored.sort((a, b) => a.score - b.score).flatMap((s) => s.targets);
}

/** Every person crossed with every posting they carry. */
const matrix: { person: Person; role: string; posting: string }[] = PEOPLE.flatMap((person) =>
  person.postings.map((p) => ({ person, role: p.role, posting: p.text })),
);

/** The guard and the fitter, exactly as the tailor route calls them. */
async function run(person: Person, posting: string) {
  const rules = person.rules.map((r) => ({ id: r.id, text: r.text, check: (r.check as RuleCheck) ?? null }));
  const guarded = validateTailored(person.profile, asTailored(person.profile, posting), {
    posting,
  });
  const fitted = await fitToPages(guarded.structure, {
    target: pageTarget(rules),
    cuts: rankedCuts(guarded.structure, posting),
    posting,
    pinned: pinsFromRules(person.rules, guarded.structure),
    measure: measurePages,
    affords: () => true,
  });
  return { guarded, fitted, target: pageTarget(rules) };
}

const named = (section: 'experience' | 'projects' | 'education', e: unknown): string =>
  ((e as Record<string, string>)?.[section === 'experience' ? 'org' : section === 'projects' ? 'name' : 'school'] ?? '');

for (const { person, role, posting } of matrix) {
  const where = `${person.name} / ${role}`;

  test(`${where}: nothing is dropped twice`, async () => {
    /*
     * The regression this suite exists for. `mayDrop` asked about the floor
     * and not about the entry in front of it, so a project the model's own
     * ranking had already taken was offered to a later pass and taken again:
     * one index twice in the cut list, "Kudi Kitchen, Kudi Kitchen" in the
     * change log, and a phantom in the record the restore path reads.
     */
    const { fitted } = await run(person, posting);
    const keys = fitted.dropped.map((d) => `${d.section}:${d.index}`);
    assert.deepEqual([...new Set(keys)], keys, `dropped twice: ${keys.join(', ')}`);
    const names = fitted.dropped.map((d) => d.name);
    assert.deepEqual([...new Set(names)], names, `dropped twice by name: ${names.join(', ')}`);
  });

  test(`${where}: nothing is on the page twice`, async () => {
    const { fitted } = await run(person, posting);
    for (const section of ['experience', 'projects', 'education'] as const) {
      const names = ((fitted.structure[section] as unknown[]) ?? []).map((e) => named(section, e));
      assert.deepEqual([...new Set(names)], names, `${section} repeats: ${names.join(', ')}`);
    }
  });

  test(`${where}: the page rule is met, or the reason is given`, async () => {
    const { fitted, target } = await run(person, posting);
    if (fitted.pages !== null && fitted.pages > target) {
      assert.ok(
        fitted.warnings.some((w) => /page/i.test(w)),
        'over the limit and said nothing about it',
      );
    }
  });

  test(`${where}: every entry that went is reported`, async () => {
    const { fitted } = await run(person, posting);
    const log = fitted.log.join(' \n ');
    for (const gone of fitted.dropped) {
      assert.ok(
        new RegExp(String(gone.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(log),
        `${gone.name} came off the page and no log line says so`,
      );
    }
  });

  test(`${where}: no heading is left over nothing`, async () => {
    const { fitted } = await run(person, posting);
    for (const section of ['experience', 'projects'] as const) {
      for (const entry of (fitted.structure[section] as { bullets?: string[] }[]) ?? []) {
        assert.ok((entry.bullets ?? []).length > 0, `an entry in ${section} kept no bullets`);
      }
    }
  });

  test(`${where}: dates, employers and locations are never rewritten`, async () => {
    const { fitted } = await run(person, posting);
    for (const before of person.profile.experience ?? []) {
      const after = (fitted.structure.experience ?? []).find((e) => e.org === before.org);
      if (!after) continue;
      assert.equal(after.dates, before.dates, `${before.org}: dates moved`);
      assert.equal(after.location, before.location, `${before.org}: location moved`);
    }
    for (const before of person.profile.education ?? []) {
      const after = (fitted.structure.education ?? []).find((e) => e.school === before.school);
      if (after) assert.equal(after.dates, before.dates, `${before.school}: dates moved`);
    }
  });

  test(`${where}: education is never cut`, async () => {
    const { fitted } = await run(person, posting);
    assert.equal(
      (fitted.structure.education ?? []).length,
      (person.profile.education ?? []).length,
      'a degree came off the page',
    );
  });

  test(`${where}: skills stay within the cap and list nothing twice`, async () => {
    const { fitted } = await run(person, posting);
    const groups = fitted.structure.skills ?? [];
    assert.ok(groups.length <= MAX_SKILL_LINES, `${groups.length} skills lines`);
    const categories = groups.map((g) => (g.category ?? '').toLowerCase());
    assert.deepEqual([...new Set(categories)], categories, 'a category is printed twice');
    const items = groups.flatMap((g) => splitTerms(g.items ?? '')).map((t) => t.toLowerCase());
    assert.deepEqual([...new Set(items)], items, `a skill is listed twice: ${items.join(', ')}`);
  });

  test(`${where}: no skill appears that the person never claimed`, async () => {
    const { fitted } = await run(person, posting);
    const theirs = (person.profile.skills ?? []).flatMap((g) => splitTerms(g.items ?? '')).map((t) => t.toLowerCase());
    for (const term of (fitted.structure.skills ?? []).flatMap((g) => splitTerms(g.items ?? ''))) {
      assert.ok(theirs.includes(term.toLowerCase()), `"${term}" is not in their profile`);
    }
  });

  test(`${where}: a section keeps its floor or everything it had`, async () => {
    const { fitted } = await run(person, posting);
    for (const section of ['experience', 'projects'] as const) {
      const before = ((person.profile[section] as unknown[]) ?? []).length;
      const after = ((fitted.structure[section] as unknown[]) ?? []).length;
      if (before === 0) {
        assert.equal(after, 0, `${section} grew out of nothing`);
        continue;
      }
      assert.ok(after >= 1, `${section} was emptied`);
      assert.ok(after <= before, `${section} grew`);
    }
  });
}

test('an entry the ranking already took is not offered to the cutter again', async () => {
  /*
   * The regression this suite exists for, set up at the exact seam.
   *
   * `mayDrop` asked about the floor and about what would be left, and never
   * about the entry in front of it — safe only while every caller filtered by
   * what was already gone. One stopped doing that, so an entry the model's
   * ranking had taken could be offered a second time by a pass that walks the
   * section by index. The cut list then held one index twice, the change log
   * read "Dropped 4 projects … Kudi Kitchen, Kudi Kitchen …", and the
   * dropped-entry record grew a phantom the restore path would offer back.
   *
   * Both offers have to be SPENT for it to show, and the second sits behind
   * every bullet and every skills line in the list. So this leaves nothing
   * cheaper in between: every entry is already at the two-bullet floor and
   * the skills section is already at its minimum, which makes entry drops the
   * only currency and puts the two offers next to each other.
   *
   * The ranking names only the duplicated project, which is what a model does
   * when it considers that the weakest thing on the page.
   */
  const two = ['Did a measurable thing', 'Did a second measurable thing'];
  const twice: ResumeStructure = {
    name: 'Fixture Person',
    contact: { email: 'f@example.com' },
    education: [{ school: 'A University', location: 'Toronto, ON', degree: 'BSc', dates: 'Sep 2020 – Apr 2024', bullets: [] }],
    experience: [
      { title: 'Founder', org: 'Twicetold', location: 'Toronto, ON', dates: 'Mar 2024 – Present', bullets: [...two] },
      { title: 'Analyst', org: 'Beta Works', location: 'Toronto, ON', dates: 'Jan 2023 – Feb 2024', bullets: [...two] },
      { title: 'Associate', org: 'Gamma Retail', location: 'Barrie, ON', dates: 'Jun 2022 – Dec 2022', bullets: [...two] },
      { title: 'Assistant', org: 'Delta Group', location: 'Oshawa, ON', dates: 'Jan 2022 – May 2022', bullets: [...two] },
    ],
    projects: [
      { name: 'Twicetold', tech: 'Shopify, HTML', dates: '2024', bullets: [...two] },
      { name: 'Second', tech: 'Figma', dates: '2024', bullets: [...two] },
      { name: 'Third', tech: 'Excel', dates: '2023', bullets: [...two] },
      { name: 'Fourth', tech: 'Python', dates: '2023', bullets: [...two] },
    ],
    skills: [
      { category: 'One', items: 'Alpha, Beta' },
      { category: 'Two', items: 'Gamma, Delta' },
      { category: 'Three', items: 'Epsilon, Zeta' },
    ],
  };

  const body = (s: ResumeStructure) =>
    [...(s.experience ?? []), ...(s.projects ?? []), ...(s.education ?? [])]
      .reduce((n, e) => n + 2 + (e.bullets ?? []).length, 0) + (s.skills ?? []).length;

  const fitted = await fitToPages(twice, {
    target: 1,
    // Only the duplicated project, as the weakest thing on the page.
    cuts: [{ kind: 'entry', section: 'projects', name: 'Twicetold', dates: '2024' }],
    posting: 'Shopify and HTML, with some Figma.',
    pinned: [],
    // Tight enough that one entry is not enough and two are, so the search
    // reaches past the ranking into what the app offers itself.
    measure: async (s) => Math.max(1, Math.ceil(body(s) / 30)),
    affords: () => true,
  });

  const keys = fitted.dropped.map((d) => `${d.section}:${d.index}`);
  assert.deepEqual([...new Set(keys)], keys, `one entry taken twice: ${keys.join(', ')}`);
  assert.ok(fitted.dropped.length >= 2, `only ${fitted.dropped.length} dropped; the seam was never reached`);
});

test('the fitter actually runs on most of the matrix', async () => {
  /*
   * A check with nothing to check is not a pass.
   *
   * The first version of this suite was green on a build with a live
   * regression in it, because every fixture fitted on one page and the cutter
   * never ran — 161 assertions over a function that returned its input. This
   * fails if that happens again.
   */
  let cutting = 0;
  const idle: string[] = [];
  for (const { person, role, posting } of matrix) {
    const { fitted } = await run(person, posting);
    if (fitted.dropped.length || fitted.log.length) cutting += 1;
    else idle.push(`${person.name}/${role}`);
  }
  assert.ok(
    cutting >= Math.ceil(matrix.length * 0.6),
    `only ${cutting} of ${matrix.length} combinations exercise the fitter; idle: ${idle.join(', ')}`,
  );
});

test('a person whose rule allows the length they have is left alone', async () => {
  // The other half of the coverage: the fitter must do nothing when nothing
  // needs doing, and both halves have to be represented in the matrix.
  const roomy = PEOPLE.find((p) => p.name === 'sparse')!;
  const { fitted } = await run(roomy, roomy.postings[0].text);
  assert.deepEqual(fitted.dropped, [], 'a short resume lost something');
});

test('the fixture set covers the shapes the pipeline branches on', () => {
  // A guard on the fixtures themselves: it is easy to add a ninth profile that
  // is the same shape as the first eight and believe coverage went up.
  assert.ok(PEOPLE.length >= 6, 'at least six people');
  assert.ok(PEOPLE.some((p) => (p.profile.projects ?? []).length === 0), 'somebody with no projects');
  assert.ok(PEOPLE.some((p) => (p.profile.experience ?? []).length >= 6), 'somebody with a long history');
  assert.ok(PEOPLE.some((p) => (p.profile.experience ?? []).length === 1), 'somebody at the experience floor');
  assert.ok(PEOPLE.some((p) => (p.profile.skills ?? []).length > MAX_SKILL_LINES), 'somebody over the skills cap');
  assert.ok(
    PEOPLE.some((p) => p.rules.some((r) => (r.check as { limit?: number })?.limit === 2)),
    'somebody whose rule is two pages',
  );
  assert.ok(
    PEOPLE.some((p) =>
      (p.profile.projects ?? []).some((pr) => (p.profile.experience ?? []).some((e) => e.org === pr.name)),
    ),
    'somebody whose venture is both a job and a project',
  );
  assert.ok(
    PEOPLE.some((p) => (p.profile.experience ?? []).some((e) => /[^\x20-\x7E]/.test(`${e.org}${e.location}`))),
    'somebody with a non-ASCII employer or place',
  );
});
