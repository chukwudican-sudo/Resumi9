import assert from 'node:assert/strict';
import test from 'node:test';
import { fitToPages } from './fit';
import type { CutTarget } from './provenance';
import type { ResumeStructure } from './types';

/**
 * Measurement is faked throughout, which is the point of passing it in.
 *
 * A real compile is a second and a half each and these cases need dozens, but
 * more than that: the interesting behaviour is what the loop does with the
 * numbers it gets back, including the ones a real compiler will not hand you on
 * demand — a measurement that fails, a resume that will not shrink however much
 * goes.
 */
const RESUME: ResumeStructure = {
  name: 'Chukwudi Alex',
  contact: { email: 'a@example.com' },
  education: [
    { school: 'Ontario Tech University', location: 'Oshawa, ON', degree: 'BEng', dates: 'Sep 2023 – 2028', bullets: ['Relevant coursework: Data Structures'] },
  ],
  experience: [
    { title: 'Software Engineer', org: 'Droady', location: 'San Francisco, CA', dates: 'Nov 2025 – May 2026', bullets: ['job one', 'job two', 'job three'] },
    { title: 'Server', org: 'Kudi Kitchen', location: 'Oshawa, ON', dates: 'Jan 2024 – Aug 2024', bullets: ['kudi one', 'kudi two'] },
  ],
  projects: [
    { name: 'FraudWatch', tech: 'Java', dates: 'Aug 2026', bullets: ['project one', 'project two'] },
    { name: 'MealApp', tech: 'React', dates: 'Feb 2025', bullets: ['meal one'] },
  ],
  skills: [{ category: 'Languages', items: 'Java, TypeScript' }],
};

const cut = (text: string): CutTarget => ({ kind: 'bullet', text });
const drop = (section: 'experience' | 'projects', name: string, dates: string): CutTarget => ({
  kind: 'entry',
  section,
  name,
  dates,
});

const bulletsOf = (structure: ResumeStructure) => [
  ...structure.experience.flatMap((e) => e.bullets),
  ...structure.projects.flatMap((p) => p.bullets),
];

/**
 * A page per N lines, where an entry costs two lines before any of its bullets.
 *
 * The heading cost is what makes this worth faking rather than counting
 * bullets: it is the whole reason trimming alone cannot reach one page on a
 * resume with ten entries, and therefore the reason entries can be dropped.
 */
const byLines = (perPage: number) => {
  const seen: number[] = [];
  return {
    seen,
    measure: async (structure: ResumeStructure) => {
      const lines = [...structure.experience, ...structure.projects].reduce(
        (n, entry) => n + 2 + (entry.bullets ?? []).length,
        0,
      );
      seen.push(lines);
      return Math.max(1, Math.ceil(lines / perPage));
    },
  };
};

const always = () => true;

test('a resume already within target is measured once and left alone', async () => {
  const meter = byLines(100);
  const result = await fitToPages(RESUME, {
    target: 2,
    cuts: [cut('job three')],
    measure: meter.measure,
    affords: always,
  });

  assert.equal(result.pages, 1);
  assert.equal(meter.seen.length, 1);
  assert.deepEqual(result.log, []);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(bulletsOf(result.structure), bulletsOf(RESUME));
});

test('an over-long resume loses the fewest bullets that reach the target', async () => {
  // 16 lines at 14 a page is two pages; dropping two bullets reaches 14.
  const result = await fitToPages(RESUME, {
    target: 1,
    cuts: [cut('meal one'), cut('kudi two'), cut('project two'), cut('job three')],
    measure: byLines(14).measure,
    affords: always,
  });

  assert.equal(result.pages, 1);
  // "meal one" is MealApp's only bullet, so it is skipped rather than cut.
  assert.deepEqual(result.structure.projects[1].bullets, ['meal one']);
  assert.match(result.log[0], /^Cut 2 bullets to fit one page/);
  assert.deepEqual(result.warnings, []);
});

test('a whole project is dropped when bullets alone cannot get there', async () => {
  // This is the case measured on the real profile: ten entries, a one-page
  // rule, and a heading cost that trimming can never recover.
  const result = await fitToPages(RESUME, {
    target: 1,
    cuts: [
      drop('projects', 'MealApp', 'Feb 2025'),
      cut('project two'),
      cut('job three'),
      cut('job two'),
      cut('kudi two'),
    ],
    measure: byLines(10).measure,
    affords: always,
  });

  assert.equal(result.pages, 1);
  assert.deepEqual(result.structure.projects.map((p) => p.name), ['FraudWatch']);
  assert.equal(bulletsOf(result.structure).includes('meal one'), false, 'its bullets go with it');
  assert.match(result.log[0], /^Dropped 1 project to fit one page: MealApp\./);
  assert.match(result.log[1], /^Cut \d+ bullets to fit one page/);
});

test('the last job is never dropped, however it is ranked', async () => {
  const result = await fitToPages(RESUME, {
    target: 2,
    cuts: [
      drop('experience', 'Droady', 'Nov 2025 – May 2026'),
      drop('experience', 'Kudi Kitchen', 'Jan 2024 – Aug 2024'),
    ],
    // 16 lines is three pages here, and dropping Droady's five reaches two.
    // Size this so the resume is genuinely OVER target: at 11 lines a page it
    // already fits, the loop returns before cutting anything, and the test
    // passes or fails on nothing at all.
    measure: byLines(7).measure,
    affords: always,
  });

  assert.equal(result.structure.experience.length, 1, 'a resume with no work history is not a shorter resume');
  assert.deepEqual(result.structure.experience.map((e) => e.org), ['Kudi Kitchen']);
  assert.match(result.log[0], /^Dropped 1 role to fit 2 pages: Droady\./);
});

test('an entry that is not on the resume is skipped', async () => {
  const result = await fitToPages(RESUME, {
    target: 1,
    cuts: [drop('projects', 'A project they deleted', '2019'), cut('project two'), cut('job three')],
    measure: byLines(14).measure,
    affords: always,
  });

  assert.equal(result.structure.projects.length, 2);
  assert.match(result.log[0], /^Cut 2 bullets/);
});

test('cuts that never reach the target are all put back, and said so', async () => {
  const result = await fitToPages(RESUME, {
    target: 1,
    cuts: [drop('projects', 'MealApp', 'Feb 2025'), cut('job three')],
    measure: async () => 2,
    affords: always,
  });

  assert.equal(result.pages, 2);
  assert.equal(result.structure.projects.length, 2, 'the full resume is what saves');
  assert.deepEqual(bulletsOf(result.structure), bulletsOf(RESUME));
  assert.deepEqual(result.log, []);
  assert.match(result.warnings[0], /runs to 2 pages and your rules ask for one page/);
  assert.match(result.warnings[0], /nothing was cut/);
});

test('an entry never loses its last bullet', async () => {
  // Every bullet is offered and no entry is. Each of the four must still have
  // one, or the resume grows a heading with nothing under it — which the guard
  // would have caught, except the guard has already run by now.
  const result = await fitToPages(RESUME, {
    target: 2,
    cuts: bulletsOf(RESUME).map(cut),
    measure: byLines(6).measure,
    affords: always,
  });

  for (const entry of [...result.structure.experience, ...result.structure.projects]) {
    assert.equal(entry.bullets.length, 1, `${JSON.stringify(entry.bullets)} should be one bullet`);
  }
});

test('the bullet an entry keeps is its most relevant one', async () => {
  // Falls out of spending the ranking in order rather than being enforced: the
  // cuts are least-relevant-first, so the one that survives the "never empty an
  // entry" rule is the last one the ranking would have reached.
  const result = await fitToPages(RESUME, {
    target: 2,
    cuts: [cut('job three'), cut('job two'), cut('job one')],
    // Only Droady's bullets are on offer, so two cuts is all there is. At 6
    // lines a page even those two cannot reach the target, the loop rightly
    // puts everything back, and nothing is learned about which one survives.
    measure: byLines(7).measure,
    affords: always,
  });

  assert.deepEqual(result.structure.experience[0].bullets, ['job one']);
});

test('education and skills are never cut, even when named', async () => {
  const result = await fitToPages(RESUME, {
    target: 1,
    cuts: [cut('Relevant coursework: Data Structures'), cut('project two'), cut('job three')],
    measure: byLines(14).measure,
    affords: always,
  });

  assert.deepEqual(result.structure.education[0].bullets, ['Relevant coursework: Data Structures']);
  assert.deepEqual(result.structure.skills, RESUME.skills);
});

test('a bullet that is no longer on the resume is skipped, not counted as a cut', async () => {
  // The ranking names what the model wrote. The honesty check may have put the
  // person's own sentence back in its place since.
  const result = await fitToPages(RESUME, {
    target: 1,
    cuts: [cut('a sentence that was reverted'), cut('project two'), cut('job three')],
    measure: byLines(14).measure,
    affords: always,
  });

  assert.equal(result.pages, 1);
  assert.match(result.log[0], /^Cut 2 bullets/);
});

test('nothing is measured or cut when the budget is already gone', async () => {
  let compiles = 0;
  const result = await fitToPages(RESUME, {
    target: 1,
    cuts: [cut('job three')],
    measure: async () => {
      compiles += 1;
      return 2;
    },
    affords: () => false,
  });

  assert.equal(compiles, 0);
  assert.equal(result.pages, null, 'not measured, rather than assumed to pass');
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(bulletsOf(result.structure), bulletsOf(RESUME));
});

test('budget running out mid-search still saves a version that fits', async () => {
  // Three measurements allowed: the original, the whole ranking, one probe.
  let allowed = 3;
  const meter = byLines(12);
  const result = await fitToPages(RESUME, {
    target: 1,
    cuts: [drop('projects', 'MealApp', 'Feb 2025'), cut('job three'), cut('kudi two'), cut('project two')],
    measure: async (s) => {
      allowed -= 1;
      return meter.measure(s);
    },
    affords: () => allowed > 0,
  });

  assert.ok(result.pages !== null && result.pages <= 1, 'what saves is what fits');
  assert.ok(result.log.length > 0);
});

test('a resume that cannot be measured at all is left exactly as it is', async () => {
  const result = await fitToPages(RESUME, {
    target: 1,
    cuts: [cut('job three')],
    measure: async () => null,
    affords: always,
  });

  assert.equal(result.pages, null);
  assert.deepEqual(bulletsOf(result.structure), bulletsOf(RESUME));
  assert.deepEqual(result.warnings, []);
});

test('an over-long resume with nothing safe to cut says so', async () => {
  const oneJob: ResumeStructure = {
    ...RESUME,
    experience: [{ ...RESUME.experience[0], bullets: ['the only one'] }],
    projects: [],
  };

  const result = await fitToPages(oneJob, {
    target: 1,
    cuts: [cut('the only one'), drop('experience', 'Droady', 'Nov 2025 – May 2026')],
    measure: async () => 2,
    affords: always,
  });

  assert.deepEqual(result.structure.experience[0].bullets, ['the only one']);
  assert.match(result.warnings[0], /nothing safe to cut/);
});
