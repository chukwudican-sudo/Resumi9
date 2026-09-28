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
 *
 * Entries carry four bullets because trimming stops at two. Sized for the old
 * floor of one, every entry here sat at or under the new one and nothing could
 * be trimmed at all — so the tests passed on the wrong behaviour. MealApp keeps
 * its single bullet on purpose: the floor stops trimming, it does not pad.
 * Twenty-one lines in total, at two per heading.
 */
const RESUME: ResumeStructure = {
  name: 'Chukwudi Alex',
  contact: { email: 'a@example.com' },
  education: [
    { school: 'Ontario Tech University', location: 'Oshawa, ON', degree: 'BEng', dates: 'Sep 2023 – 2028', bullets: ['Relevant coursework: Data Structures'] },
  ],
  experience: [
    { title: 'Software Engineer', org: 'Droady', location: 'San Francisco, CA', dates: 'Nov 2025 – May 2026', bullets: ['job one', 'job two', 'job three', 'job four'] },
    { title: 'Server', org: 'Kudi Kitchen', location: 'Oshawa, ON', dates: 'Jan 2024 – Aug 2024', bullets: ['kudi one', 'kudi two', 'kudi three', 'kudi four'] },
  ],
  projects: [
    { name: 'FraudWatch', tech: 'Java', dates: 'Aug 2026', bullets: ['project one', 'project two', 'project three', 'project four'] },
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
  // 21 lines at 19 a page is two pages; dropping two bullets reaches 19.
  const result = await fitToPages(RESUME, {
    target: 1,
    cuts: [cut('meal one'), cut('kudi four'), cut('project four'), cut('job four')],
    measure: byLines(19).measure,
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
      cut('project four'),
      cut('job four'),
      cut('job three'),
      cut('kudi four'),
    ],
    // 21 lines. Every trim the floor allows reaches 15 — still two pages at 14
    // a page — so the entry has to go for this to fit at all.
    measure: byLines(14).measure,
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
    cuts: [drop('projects', 'A project they deleted', '2019'), cut('project four'), cut('job four')],
    measure: byLines(19).measure,
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
  assert.match(result.warnings[0], /will not fit/);
  assert.match(result.warnings[0], /Two pages, or take something off yourself/);
});

test('an entry is never trimmed below two bullets', async () => {
  // Every bullet is offered and no entry is. One bullet apiece fits more
  // resumes — measured, it was the only thing that fitted one real resume in
  // ten — but it leaves a page where nothing has any depth.
  //
  // 21 lines; the six trims the floor allows reach 15, which fits at 15 a page.
  const result = await fitToPages(RESUME, {
    target: 1,
    cuts: bulletsOf(RESUME).map(cut),
    measure: byLines(15).measure,
    affords: always,
  });

  assert.equal(result.pages, 1);
  // Which two survive is the ranking's business and is covered by the next
  // test; here every entry that started above the floor must land on it.
  for (const entry of [...result.structure.experience, result.structure.projects[0]]) {
    assert.equal(entry.bullets.length, 2, `${JSON.stringify(entry.bullets)} should be two bullets`);
  }
  assert.deepEqual(
    result.structure.projects[1].bullets,
    ['meal one'],
    'the floor stops trimming, it does not pad an entry that arrived with fewer',
  );
});

test('the bullets an entry keeps are its most relevant ones', async () => {
  // Falls out of spending the ranking in order rather than being enforced: the
  // cuts are least-relevant-first, so what survives the floor is what the
  // ranking would have reached last.
  const result = await fitToPages(RESUME, {
    target: 1,
    cuts: [cut('job four'), cut('job three'), cut('job two'), cut('job one')],
    // 21 lines; Droady's two allowed trims reach 19, which fits at 19 a page.
    measure: byLines(19).measure,
    affords: always,
  });

  assert.deepEqual(result.structure.experience[0].bullets, ['job one', 'job two']);
});

test('education and skills are never cut, even when named', async () => {
  const result = await fitToPages(RESUME, {
    target: 1,
    cuts: [cut('Relevant coursework: Data Structures'), cut('project four'), cut('job four')],
    measure: byLines(19).measure,
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
    cuts: [cut('a sentence that was reverted'), cut('project four'), cut('job four')],
    measure: byLines(19).measure,
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
    cuts: [drop('projects', 'MealApp', 'Feb 2025'), cut('job four'), cut('kudi four'), cut('project four')],
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

test('a resume of one job and one project is never cut into something broken', async () => {
  /*
   * The shape a first user is most likely to have, and the one the floors bind
   * on immediately: the single job may not go, and the single project may not
   * go either while it is the only thing holding its section up.
   *
   * Measured separately on a real compile, this shape needs roughly 38 bullets
   * across the two entries before it even reaches a second page — so in
   * practice it never arrives here at all. It is written down because "it
   * cannot happen" is exactly the assumption worth a test.
   */
  const minimal: ResumeStructure = {
    ...RESUME,
    experience: [{ ...RESUME.experience[0], bullets: ['job one', 'job two', 'job three', 'job four'] }],
    projects: [{ ...RESUME.projects[0], bullets: ['project one', 'project two', 'project three', 'project four'] }],
  };

  const result = await fitToPages(minimal, {
    target: 1,
    cuts: [
      drop('experience', 'Droady', 'Nov 2025 – May 2026'),
      drop('projects', 'FraudWatch', 'Aug 2026'),
      ...bulletsOf(minimal).map(cut),
    ],
    // Nothing the floors allow can reach one page here.
    measure: async () => 2,
    affords: always,
  });

  assert.equal(result.structure.experience.length, 1, 'the only job stays');
  assert.equal(result.structure.projects.length, 1, 'the only project stays');
  assert.deepEqual(bulletsOf(result.structure), bulletsOf(minimal), 'and nothing is trimmed off either');
  assert.deepEqual(result.log, []);
  assert.match(result.warnings[0], /will not fit/);
});

test('a section is never left as a heading over an entry with nothing under it', async () => {
  // The floor that had to be stated: trimming stops at two bullets, and the
  // last entry holding a section up may not be dropped — so there is no path
  // to a Projects heading printing one bare title line.
  const result = await fitToPages(RESUME, {
    target: 1,
    cuts: [
      drop('projects', 'MealApp', 'Feb 2025'),
      drop('projects', 'FraudWatch', 'Aug 2026'),
      ...bulletsOf(RESUME).map(cut),
    ],
    measure: byLines(9).measure,
    affords: always,
  });

  assert.ok(result.structure.projects.length >= 1, 'the section survives');
  assert.ok(
    result.structure.projects.some((p) => (p.bullets ?? []).length > 0),
    'and something under it still says what it was',
  );
});

test('one section is never emptied while the other keeps everything', async () => {
  /*
   * The bug a real resume surfaced. Four jobs and six projects came back with
   * ONE job and five projects, because the candidate list was built section by
   * section — every experience drop sat ahead of every project drop, and the
   * search takes a prefix. The person read their own resume and asked why the
   * app thought they had one job.
   */
  const lopsided: ResumeStructure = {
    ...RESUME,
    experience: Array.from({ length: 4 }, (_, i) => ({
      title: `Role ${i + 1}`,
      org: `Employer ${i + 1}`,
      location: 'Oshawa, ON',
      dates: '2024 – 2025',
      bullets: ['one', 'two'],
    })),
    projects: Array.from({ length: 6 }, (_, i) => ({
      name: `Project ${i + 1}`,
      tech: 'TypeScript',
      dates: '2025',
      bullets: ['one', 'two'],
    })),
  };

  // 40 lines; four entries have to go to reach 24.
  const result = await fitToPages(lopsided, {
    target: 1,
    cuts: [],
    measure: byLines(24).measure,
    affords: always,
  });

  assert.equal(result.pages, 1);
  assert.ok(
    result.structure.experience.length >= 3,
    `kept ${result.structure.experience.length} of 4 jobs — the fuller section should give first`,
  );
  assert.ok(result.structure.projects.length <= 3, 'and projects should be the ones shrinking');
});

test('the fuller section gives first, whichever one that is', async () => {
  // The mirror image: plenty of jobs, one project. The project must survive.
  const manyJobs: ResumeStructure = {
    ...RESUME,
    experience: Array.from({ length: 6 }, (_, i) => ({
      title: `Role ${i + 1}`,
      org: `Employer ${i + 1}`,
      location: 'Oshawa, ON',
      dates: '2024 – 2025',
      bullets: ['one', 'two'],
    })),
    projects: [{ name: 'The only project', tech: 'TypeScript', dates: '2025', bullets: ['one', 'two'] }],
  };

  const result = await fitToPages(manyJobs, {
    target: 1,
    cuts: [],
    measure: byLines(20).measure,
    affords: always,
  });

  assert.equal(result.pages, 1);
  assert.deepEqual(
    result.structure.projects.map((p) => p.name),
    ['The only project'],
    'the section with one entry is not the one raided',
  );
  assert.ok(result.structure.experience.length < 6, 'the fuller one gave');
});
