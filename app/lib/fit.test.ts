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
  // The case measured on the real profile: a heading cost that trimming can
  // never recover. Three projects locally, because two is the floor and a
  // section at its floor has nothing to give.
  const threeProjects: ResumeStructure = {
    ...RESUME,
    projects: [...RESUME.projects, { name: 'Rate Limit Lab', tech: 'Python', dates: 'Mar 2026', bullets: ['rate one', 'rate two'] }],
  };

  const result = await fitToPages(threeProjects, {
    target: 1,
    cuts: [
      drop('projects', 'MealApp', 'Feb 2025'),
      cut('project four'),
      cut('job four'),
      cut('job three'),
      cut('kudi four'),
    ],
    // 25 lines. Every trim the floor allows reaches 19 — still two pages at 18
    // a page — so the entry has to go for this to fit at all.
    measure: byLines(18).measure,
    affords: always,
  });

  assert.equal(result.pages, 1);
  assert.deepEqual(result.structure.projects.map((p) => p.name), ['FraudWatch', 'Rate Limit Lab']);
  assert.equal(bulletsOf(result.structure).includes('meal one'), false, 'its bullets go with it');
  assert.match(result.log[0], /^Dropped 1 project to fit one page: MealApp\./);
});

test('a resume is never cut below two jobs', async () => {
  /*
   * One was the floor, and one is what a real resume came back with: four jobs
   * in, three dropped to reach a page. The person's words for it — "just one
   * experience is crazy, it makes me look like I don't have any experience in
   * a workplace in life" — are the argument. A recruiter sees ONE JOB before
   * reading which job it was.
   *
   * The ranking cannot know that. It scores entries against a posting and says
   * nothing about how the page reads. Relevance picks which go; this picks how
   * few may be left.
   */
  const fourJobs: ResumeStructure = {
    ...RESUME,
    experience: Array.from({ length: 4 }, (_, i) => ({
      title: `Role ${i + 1}`,
      org: `Employer ${i + 1}`,
      location: 'Oshawa, ON',
      dates: '2024 – 2025',
      bullets: ['one', 'two'],
    })),
    projects: [],
  };

  // Every job offered, weakest last, and a page so small nothing can satisfy it.
  const result = await fitToPages(fourJobs, {
    target: 1,
    cuts: fourJobs.experience.map((e) => drop('experience', e.org, e.dates)),
    measure: byLines(4).measure,
    affords: always,
  });

  assert.ok(
    result.structure.experience.length >= 2,
    `left ${result.structure.experience.length} job(s) — two is the floor`,
  );
});

test('somebody with one job keeps it, and the floor invents nothing', async () => {
  const oneJob: ResumeStructure = {
    ...RESUME,
    experience: [{ ...RESUME.experience[0] }],
    projects: [],
  };

  const result = await fitToPages(oneJob, {
    target: 1,
    cuts: [drop('experience', oneJob.experience[0].org, oneJob.experience[0].dates)],
    measure: byLines(3).measure,
    affords: always,
  });

  assert.equal(result.structure.experience.length, 1, 'the floor stops cutting, it does not pad');
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
  // 21 lines; the six trims the floor allows reach 15, which fits at 15 a page.
  let allowed = 3;
  const meter = byLines(15);
  const result = await fitToPages(RESUME, {
    target: 1,
    // Bullets only: what is under test is the budget running out mid-search,
    // and the fixture's two projects are already at the floor.
    cuts: [cut('job four'), cut('kudi four'), cut('project four'), cut('job three'), cut('kudi three'), cut('project three')],
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

test('a ranking that runs short is said out loud, not covered up', async () => {
  // Past the end of the ranking the app chooses with no idea what the posting
  // wants. That is how one job and five projects happened. It still happens
  // when the model under-ranks — it is just no longer silent.
  const said: string[] = [];
  const realError = console.error;
  console.error = (...parts: unknown[]) => said.push(parts.join(' '));
  try {
    await fitToPages(RESUME, {
      target: 1,
      // One cut offered on a resume that needs several.
      cuts: [cut('job four')],
      measure: byLines(15).measure,
      affords: always,
    });
  } finally {
    console.error = realError;
  }

  assert.equal(said.length, 1, 'exactly one line, not one per cut');
  assert.match(said[0], /ranking covered 1 of the \d+ cuts needed/);
});

test('a ranking that covers the job stays quiet', async () => {
  const said: string[] = [];
  const realError = console.error;
  console.error = (...parts: unknown[]) => said.push(parts.join(' '));
  try {
    await fitToPages(RESUME, {
      target: 1,
      cuts: [cut('kudi four'), cut('project four'), cut('job four'), cut('job three')],
      measure: byLines(19).measure,
      affords: always,
    });
  } finally {
    console.error = realError;
  }

  assert.deepEqual(said, [], 'the posting decided every cut, so there is nothing to report');
});

test('a resume is never cut below two projects either', async () => {
  /*
   * A Projects heading with one entry under it has the problem Experience had
   * with one job: it reads as an afterthought rather than a section. For a
   * student it is worse — projects are where somebody shows they build things
   * unasked, and one of them suggests they do not.
   *
   * Written as a floor rather than a target shape on purpose. "Aim for three
   * jobs and two projects" would override the ranking with a layout and drop
   * a better entry for a worse one whenever a posting favours the jobs.
   */
  const many: ResumeStructure = {
    ...RESUME,
    experience: Array.from({ length: 4 }, (_, i) => ({
      title: `Role ${i + 1}`, org: `Employer ${i + 1}`, location: 'Oshawa, ON', dates: '2024 – 2025', bullets: ['one', 'two'],
    })),
    projects: Array.from({ length: 5 }, (_, i) => ({
      name: `Project ${i + 1}`, tech: 'TypeScript', dates: '2025', bullets: ['one', 'two'],
    })),
  };

  // Every entry offered, and a page too small for any of it to satisfy.
  const result = await fitToPages(many, {
    target: 1,
    cuts: [
      ...many.projects.map((p) => drop('projects', p.name, p.dates)),
      ...many.experience.map((e) => drop('experience', e.org, e.dates)),
    ],
    measure: byLines(4).measure,
    affords: always,
  });

  assert.ok(result.structure.projects.length >= 2, `left ${result.structure.projects.length} project(s) — two is the floor`);
  assert.ok(result.structure.experience.length >= 2, `left ${result.structure.experience.length} job(s)`);
});

test('somebody with one project keeps it, and the floor invents nothing', async () => {
  const onlyOne: ResumeStructure = {
    ...RESUME,
    projects: [{ name: 'The only one', tech: 'Python', dates: '2025', bullets: ['one', 'two'] }],
  };

  const result = await fitToPages(onlyOne, {
    target: 1,
    cuts: [drop('projects', 'The only one', '2025')],
    measure: byLines(3).measure,
    affords: always,
  });

  assert.equal(result.structure.projects.length, 1, 'the floor stops cutting, it does not pad');
});

// ── skills lines ───────────────────────────────────────────────────────────
//
// Measured on a real profile: four jobs and two projects run to two pages with
// five skill lines and fit on one with four. A line of comma-separated tools
// costs a JOB — and the fitter could not touch it, so it dropped the job
// instead, on all eleven resumes of one apply run.
//
// These need their own meter. `byLines` counts entry headings and bullets,
// which is all the rest of this file cares about; a skills line is a line on
// the page too, and a measurement that ignores it cannot show a skills cut
// doing anything.

const andSkills = (perPage: number) => async (structure: ResumeStructure) => {
  const entries = [...structure.experience, ...structure.projects].reduce(
    (n, entry) => n + 2 + (entry.bullets ?? []).length,
    0,
  );
  return Math.max(1, Math.ceil((entries + (structure.skills ?? []).length) / perPage));
};

const linesOf = (categories: string[]) =>
  categories.map((category) => ({ category, items: `${category} one, ${category} two` }));

const FIVE: ResumeStructure = {
  ...RESUME,
  skills: [
    { category: 'Languages', items: 'Python, TypeScript' },
    { category: 'Frontend', items: 'React, Tailwind' },
    { category: 'AI & Data', items: 'LLM API Integration, Prompt Engineering' },
    { category: 'Office', items: 'Excel, PowerPoint' },
    { category: 'Tools', items: 'Git, Docker' },
  ],
};

/*
 * Twenty-six lines: twenty-one of entries and five of skills. Trimming every
 * bullet down to the floor reaches twenty, one over, so one page is only
 * reachable if a skills line can go — which is the whole question.
 */
test('a skills line goes before any entry does', async () => {
  const result = await fitToPages(FIVE, {
    target: 1,
    cuts: [],
    posting: 'We are looking for a Python engineer with React experience.',
    measure: andSkills(19),
    affords: always,
  });

  assert.equal(result.pages, 1);
  assert.equal(result.structure.experience.length, 2, 'both jobs stay');
  assert.equal(result.structure.projects.length, 2, 'and both projects');
  assert.equal((result.structure.skills ?? []).length, 4, 'a skills line gave instead');
});

test('the line the employer never mentions is the one that goes', async () => {
  const result = await fitToPages(FIVE, {
    target: 1,
    cuts: [],
    posting: 'Python, TypeScript, React, Tailwind, LLM API Integration, Prompt Engineering, Git, Docker.',
    measure: andSkills(19),
    affords: always,
  });
  const kept = (result.structure.skills ?? []).map((g) => g.category);
  assert.deepEqual(kept, ['Languages', 'Frontend', 'AI & Data', 'Tools'], 'Office named nothing they asked for');
});

test('a line is judged on its own items, not on a keyword list', async () => {
  /*
   * The mistake this replaced, caught before it shipped. One Applied AI
   * Engineer posting extracted to python, fastapi, aws, sagemaker, eks, ecr,
   * s3, kinesis, terraform — infrastructure names, all of them — so scoring
   * the line against that list scored AI & Data at zero, and the fitter took
   * the AI line off an AI job first. The posting's own words say AI twice in
   * the first sentence.
   */
  const result = await fitToPages(FIVE, {
    target: 1,
    cuts: [],
    posting:
      'You will work on LLM API Integration and Prompt Engineering for our AI products. Stack: AWS, SageMaker, Terraform.',
    measure: andSkills(19),
    affords: always,
  });
  assert.ok(
    (result.structure.skills ?? []).some((g) => g.category === 'AI & Data'),
    `the AI line survives an AI posting; kept ${(result.structure.skills ?? []).map((g) => g.category).join(', ')}`,
  );
});

test('skills never fall below three lines', async () => {
  // Eight lines, twenty-nine lines in all. Eighteen is every bullet and every
  // sheddable skills line exactly — so the floor is what stops it, not the fit.
  const eight: ResumeStructure = { ...RESUME, skills: linesOf(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) };
  const result = await fitToPages(eight, {
    target: 1,
    cuts: [],
    posting: 'Nothing here matches anything on the resume.',
    measure: andSkills(18),
    affords: always,
  });

  assert.equal(result.pages, 1);
  assert.equal((result.structure.skills ?? []).length, 3, 'five went, three stayed');
  assert.equal(result.structure.experience.length, 2, 'and no entry was touched');
});

test('a resume already at three skills lines keeps all three', async () => {
  const lean: ResumeStructure = { ...RESUME, skills: linesOf(['a', 'b', 'c']) };
  const result = await fitToPages(lean, {
    target: 1,
    cuts: [],
    posting: 'Nothing matches.',
    measure: andSkills(19),
    affords: always,
  });
  assert.equal((result.structure.skills ?? []).length, 3, 'the floor stops cutting, it does not pad');
});

test('dropped skills lines are named in the log', async () => {
  const result = await fitToPages(FIVE, {
    target: 1,
    cuts: [],
    posting: 'Python and React only.',
    measure: andSkills(19),
    affords: always,
  });
  assert.ok(
    result.log.some((l) => /skills line/.test(l) && /Office|Tools/.test(l)),
    `log was ${JSON.stringify(result.log)}`,
  );
});

// ── pins ───────────────────────────────────────────────────────────────────
//
// What the person said to keep. Everything this file cuts it chose itself, so
// before pins a job could be dropped, asked for back in the change box, and
// dropped again by the next fit — the second time after they had said not to.

const PINNED: ResumeStructure = {
  ...RESUME,
  skills: [
    { category: 'Languages', items: 'Java, TypeScript' },
    { category: 'Frontend', items: 'React, Figma' },
    { category: 'AI & Data', items: 'Prompt Engineering' },
    { category: 'Office', items: 'Excel, PowerPoint' },
    { category: 'Tools', items: 'Git, Docker' },
  ],
};

test('a pinned job is not dropped, and something else goes instead', async () => {
  const result = await fitToPages(PINNED, {
    target: 1,
    // Kudi Kitchen is the last job, so it is what the fallback would take.
    cuts: [drop('experience', 'Kudi Kitchen', 'Jan 2024 – Aug 2024')],
    pinned: [{ place: 'experience', text: 'Kudi Kitchen', label: 'Kudi Kitchen' }],
    posting: 'Nothing matches.',
    measure: andSkills(19),
    affords: always,
  });

  assert.ok(
    result.structure.experience.some((e) => e.org === 'Kudi Kitchen'),
    'the job they asked to keep is still there',
  );
  assert.equal(result.pages, 1, 'and it still fits, because a skills line went');
});

test('a pinned skills line is not the one that goes', async () => {
  const result = await fitToPages(PINNED, {
    target: 1,
    cuts: [],
    // Office answers nothing in the posting, so it is first in line to go.
    pinned: [{ place: 'skills', text: 'Office', label: 'the Office line' }],
    posting: 'Java and React.',
    measure: andSkills(19),
    affords: always,
  });
  const kept = (result.structure.skills ?? []).map((g) => g.category);
  assert.ok(kept.includes('Office'), `Office was pinned; kept ${kept.join(', ')}`);
});

test('a pinned tool keeps the line it sits on', async () => {
  const result = await fitToPages(PINNED, {
    target: 1,
    cuts: [],
    pinned: [{ place: 'skills', text: 'Docker', label: 'Docker' }],
    posting: 'Java, TypeScript, React, Figma, Prompt Engineering.',
    measure: andSkills(19),
    affords: always,
  });
  assert.ok(
    (result.structure.skills ?? []).some((g) => /Docker/.test(g.items)),
    'the line holding the pinned tool survives',
  );
});

test('a pinned bullet is not trimmed', async () => {
  const result = await fitToPages(PINNED, {
    target: 1,
    cuts: [cut('job four')],
    pinned: [{ place: 'bullet', text: 'job four', label: 'that bullet' }],
    posting: 'Nothing matches.',
    measure: andSkills(19),
    affords: always,
  });
  assert.ok(bulletsOf(result.structure).includes('job four'), 'the pinned sentence is still on the page');
});

test('when the pin cannot fit, the page rule gives and says so', async () => {
  // Every job pinned, so nothing an entry cut could reach is available, and
  // the meter is set so that trimming and skills together are not enough.
  const result = await fitToPages(PINNED, {
    target: 1,
    cuts: [],
    pinned: [
      { place: 'experience', text: 'Droady', label: 'Droady' },
      { place: 'experience', text: 'Kudi Kitchen', label: 'Kudi Kitchen' },
      { place: 'projects', text: 'FraudWatch', label: 'FraudWatch' },
      { place: 'projects', text: 'MealApp', label: 'MealApp' },
    ],
    posting: 'Nothing matches.',
    measure: andSkills(8),
    affords: always,
  });

  assert.equal(result.structure.experience.length, 2, 'nothing pinned was dropped');
  assert.equal(result.structure.projects.length, 2);
  assert.equal(result.log.length, 0, 'and nothing claims to have been cut');
  assert.match(result.warnings[0] ?? '', /You asked to keep/);
  assert.match(result.warnings[0] ?? '', /the page rule is the one that gives/);
});

test('a pin for something already gone is ignored', async () => {
  /*
   * Pins are kept with the application and the resume is rebuilt from the
   * profile every time, so a pin outlives what it named: a bullet since
   * reworded, a skill taken out of the profile, a job deleted. Treated as
   * breakable, it would report the page rule as unmeetable on every later
   * tailor over a sentence nothing could satisfy.
   */
  const result = await fitToPages(PINNED, {
    target: 1,
    cuts: [],
    pinned: [{ place: 'experience', text: 'A job they deleted', label: 'A job they deleted' }],
    posting: 'Java and React.',
    measure: andSkills(19),
    affords: always,
  });
  assert.equal(result.pages, 1);
  assert.equal(result.warnings.length, 0, 'no warning about a pin nothing could keep');
  assert.ok(result.log.length > 0, 'and the fit went ahead as usual');
});

test('no pins at all behaves exactly as before', async () => {
  const withNone = await fitToPages(PINNED, {
    target: 1, cuts: [], posting: 'Java and React.', measure: andSkills(19), affords: always,
  });
  const withEmpty = await fitToPages(PINNED, {
    target: 1, cuts: [], pinned: [], posting: 'Java and React.', measure: andSkills(19), affords: always,
  });
  assert.deepEqual(withEmpty.log, withNone.log);
  assert.deepEqual((withEmpty.structure.skills ?? []).map((g) => g.category), (withNone.structure.skills ?? []).map((g) => g.category));
});
