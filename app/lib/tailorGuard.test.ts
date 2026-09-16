import assert from 'node:assert/strict';
import test from 'node:test';
import { normaliseTailored, surfaceRepairs, validateTailored } from './tailorGuard';
import type { ResumeStructure } from './types';

/**
 * The case this exists for.
 *
 * A real tailored resume came back missing the Aegon role. The model's own
 * change log had sixteen entries and mentioned Aegon in none of them; its
 * warnings were empty. Three self-report channels, all silent, which is why the
 * check is arithmetic rather than another instruction.
 *
 * Half these tests are the opposite worry: a guard that sees deletions where
 * there were none puts duplicate jobs on somebody's resume, so the
 * false-positive floor matters as much as the catch.
 */

const SOURCE: ResumeStructure = {
  name: 'Chukwudi Alex',
  contact: { email: 'a@example.com', phone: '905-555-0142' },
  education: [
    { school: 'Ontario Tech University', location: 'Oshawa, ON', degree: 'BEng Software Engineering', dates: 'Sep 2023 – 2028', bullets: ['Relevant coursework: Data Structures'] },
  ],
  experience: [
    { title: 'AI Engineer', org: 'Droady', location: 'San Francisco, CA', dates: 'Nov 2025 – May 2026', bullets: ['Integrated an AI model', 'Worked on billing'] },
    { title: 'Wealth Manager', org: 'Aegon', location: 'Oshawa, ON', dates: 'May 2025 – Aug 2026', bullets: ['Managed portfolios', 'Kept 95% retention'] },
    { title: 'Operations Specialist', org: 'WesternBell', location: 'Port Harcourt, Nigeria', dates: 'Jun 2024 – Jan 2025', bullets: ['Built the website'] },
  ],
  projects: [
    { name: 'MealApp', tech: 'React Native', dates: 'May 2026 – Present', bullets: ['Designed a 17 table schema'], url: 'github.com/x/meal' },
    { name: 'FraudWatch', tech: 'Java', dates: 'Aug 2026', bullets: ['Led the backend'] },
  ],
  skills: [
    { category: 'Languages', items: 'TypeScript, Java, SQL' },
    { category: 'Tools', items: 'Microsoft Excel, Ms PowerPoint' },
  ],
  sections: [
    { key: 'education', label: 'Education' },
    { key: 'experience', label: 'Work Experience' },
    { key: 'projects', label: 'Technical Projects' },
    { key: 'skills', label: 'Technical Skills' },
  ],
};

const clone = (): ResumeStructure => JSON.parse(JSON.stringify(SOURCE));
const orgs = (r: ResumeStructure) => r.experience.map((e) => e.org);

// ── the floor: none of this is a deletion ──────────────────────────────────

test('rewriting every bullet is not a deletion', () => {
  const tailored = clone();
  for (const job of tailored.experience) job.bullets = job.bullets.map((b) => `${b}, rewritten for the posting`);
  const { repairs, structure } = validateTailored(SOURCE, tailored);
  assert.deepEqual(repairs, []);
  assert.deepEqual(structure.experience.map((e) => e.bullets), tailored.experience.map((e) => e.bullets));
});

test('reordering the sections is not a deletion', () => {
  const tailored = clone();
  tailored.experience = [tailored.experience[2], tailored.experience[0], tailored.experience[1]];
  const { repairs, structure } = validateTailored(SOURCE, tailored);
  assert.deepEqual(repairs, []);
  assert.deepEqual(orgs(structure), ['WesternBell', 'Droady', 'Aegon'], 'the reordering must survive');
});

test('a rewritten job title is not a deletion', () => {
  // The real one. Tailoring is allowed to do this, which is exactly why the
  // title cannot be used as identity.
  const tailored = clone();
  tailored.experience[1].title = 'Wealth Manager (Client Services & Financial Planning)';
  const { repairs, structure } = validateTailored(SOURCE, tailored);
  assert.deepEqual(repairs, []);
  assert.equal(structure.experience[1].title, 'Wealth Manager (Client Services & Financial Planning)');
});

test('a reformatted date is the same date', () => {
  const tailored = clone();
  tailored.experience[0].dates = 'November 2025 - May 2026';
  const { repairs, structure } = validateTailored(SOURCE, tailored);
  assert.deepEqual(repairs, [], 'reformatting is not changing');
  assert.equal(structure.experience[0].dates, 'Nov 2025 – May 2026', "the profile's spelling wins");
});

test('trimming some bullets is what tailoring is for', () => {
  const tailored = clone();
  tailored.experience[0].bullets = ['Integrated an AI model'];
  const { repairs, structure } = validateTailored(SOURCE, tailored);
  assert.deepEqual(repairs, []);
  assert.equal(structure.experience[0].bullets.length, 1);
});

test('two roles at one employer both survive a reorder', () => {
  const source = clone();
  source.experience = [
    { title: 'Senior Analyst', org: 'Aegon', location: 'Oshawa, ON', dates: 'Jan 2025 – Aug 2026', bullets: ['Led the desk'] },
    { title: 'Analyst', org: 'Aegon', location: 'Oshawa, ON', dates: 'May 2023 – Dec 2024', bullets: ['Ran the reports'] },
  ];
  const tailored = JSON.parse(JSON.stringify(source)) as ResumeStructure;
  tailored.experience.reverse();
  const { repairs, structure } = validateTailored(source, tailored);
  assert.deepEqual(repairs, []);
  assert.equal(structure.experience.length, 2, 'a promotion is two jobs, not one');
});

// ── the catch ──────────────────────────────────────────────────────────────

test('a dropped job comes back beside the neighbour it had', () => {
  const tailored = clone();
  tailored.experience.splice(1, 1); // Aegon
  const { repairs, structure } = validateTailored(SOURCE, tailored);

  assert.deepEqual(orgs(structure), ['Droady', 'Aegon', 'WesternBell'], 'not appended to the end');
  const entry = repairs.filter((r) => r.kind === 'entry');
  assert.equal(entry.length, 1);
  assert.match(entry[0].message, /dropped your Wealth Manager at Aegon/);
  assert.match(entry[0].message, /will not sound like the entries around it/);
  // Verbatim: the guard never invents a third version of somebody's history.
  assert.deepEqual(structure.experience[1].bullets, ['Managed portfolios', 'Kept 95% retention']);
});

test('a dropped first entry comes back first', () => {
  const tailored = clone();
  tailored.experience.shift();
  const { structure } = validateTailored(SOURCE, tailored);
  assert.deepEqual(orgs(structure), ['Droady', 'Aegon', 'WesternBell']);
});

test('two consecutive deletions come back in their own order', () => {
  const tailored = clone();
  tailored.experience.splice(0, 2);
  const { structure, repairs } = validateTailored(SOURCE, tailored);
  assert.deepEqual(orgs(structure), ['Droady', 'Aegon', 'WesternBell']);
  assert.equal(repairs.filter((r) => r.kind === 'entry').length, 2);
});

test('an emptied experience section comes back whole', () => {
  const tailored = clone();
  tailored.experience = [];
  const { structure } = validateTailored(SOURCE, tailored);
  assert.deepEqual(orgs(structure), ['Droady', 'Aegon', 'WesternBell']);
});

test('the right one of two roles at one employer is restored', () => {
  // Without consuming matches these collapse onto each other and the deletion
  // is never seen — the shape of a promotion, and the shape of the bug.
  const source = clone();
  source.experience = [
    { title: 'Senior Analyst', org: 'Aegon', location: 'Oshawa, ON', dates: 'Jan 2025 – Aug 2026', bullets: ['Led the desk'] },
    { title: 'Analyst', org: 'Aegon', location: 'Oshawa, ON', dates: 'May 2023 – Dec 2024', bullets: ['Ran the reports'] },
  ];
  const tailored = JSON.parse(JSON.stringify(source)) as ResumeStructure;
  tailored.experience.splice(1, 1);
  const { structure, repairs } = validateTailored(source, tailored);
  assert.equal(structure.experience.length, 2);
  assert.deepEqual(structure.experience.map((e) => e.title), ['Senior Analyst', 'Analyst']);
  assert.equal(repairs.filter((r) => r.kind === 'entry').length, 1);
});

test('a dropped project comes back, a renamed one does not duplicate', () => {
  const dropped = clone();
  dropped.projects.splice(0, 1);
  assert.deepEqual(validateTailored(SOURCE, dropped).structure.projects.map((p) => p.name), ['MealApp', 'FraudWatch']);

  const renamed = clone();
  renamed.projects[0].name = 'MealApp — offline-first nutrition tracker';
  const out = validateTailored(SOURCE, renamed);
  assert.deepEqual(out.repairs, []);
  assert.equal(out.structure.projects.length, 2);
});

// ── reversion ──────────────────────────────────────────────────────────────

test('a changed date is put back, and said out loud', () => {
  const tailored = clone();
  tailored.experience[1].dates = 'May 2024 – Aug 2026';
  const { repairs, structure } = validateTailored(SOURCE, tailored);
  assert.equal(structure.experience.length, 3, 'reverted, not duplicated');
  assert.equal(structure.experience[1].dates, 'May 2025 – Aug 2026');
  const field = repairs.filter((r) => r.kind === 'field');
  assert.equal(field.length, 1);
  assert.match(field[0].message, /May 2025 – Aug 2026/);
});

test('a tidied employer name is put back', () => {
  const tailored = clone();
  tailored.experience[1].org = 'Aegon Asset Management';
  const { repairs, structure } = validateTailored(SOURCE, tailored);
  assert.equal(structure.experience.length, 3);
  assert.equal(structure.experience[1].org, 'Aegon');
  assert.ok(repairs.some((r) => /employer name/.test(r.message)));
});

test('an internship cannot be promoted into a job', () => {
  const source = clone();
  source.experience[0].title = 'Software Engineering Intern';
  const tailored = JSON.parse(JSON.stringify(source)) as ResumeStructure;
  tailored.experience[0].title = 'Software Engineer';
  const { repairs, structure } = validateTailored(source, tailored);
  assert.equal(structure.experience[0].title, 'Software Engineering Intern');
  assert.ok(repairs.some((r) => /reads more senior/.test(r.message)));
});

test('the name and contact details are never the tailoring to decide', () => {
  const tailored = clone();
  tailored.name = 'Alex C.';
  tailored.contact = { email: 'different@example.com' };
  const { structure, repairs } = validateTailored(SOURCE, tailored);
  assert.equal(structure.name, 'Chukwudi Alex');
  assert.equal(structure.contact.email, 'a@example.com');
  // Silent: there is nothing here for the person to check.
  assert.deepEqual(repairs, []);
});

// ── contents ───────────────────────────────────────────────────────────────

test('an entry stripped of every bullet keeps the ones it had', () => {
  const tailored = clone();
  tailored.experience[2].bullets = [];
  const { repairs, structure } = validateTailored(SOURCE, tailored);
  assert.deepEqual(structure.experience[2].bullets, ['Built the website']);
  assert.ok(repairs.some((r) => r.kind === 'bullets'));
});

test('dropped skills come back, appended to the last group', () => {
  const tailored = clone();
  tailored.skills = [{ category: 'Languages', items: 'TypeScript, Java, SQL' }];
  const { repairs, structure } = validateTailored(SOURCE, tailored);
  const all = structure.skills.flatMap((g) => g.items.split(',').map((t) => t.trim()));
  assert.ok(all.includes('Microsoft Excel'));
  assert.ok(all.includes('Ms PowerPoint'));
  const skill = repairs.filter((r) => r.kind === 'skill');
  assert.equal(skill.length, 1);
  // Worth recording, not worth stopping over.
  const surfaced = surfaceRepairs(repairs);
  assert.equal(surfaced.warnings.length, 0);
  assert.equal(surfaced.log.length, 1);
});

test('the section names polish chose survive tailoring', () => {
  // The tailor's schema has no field for these and forbids extra ones, so the
  // model cannot return them however well it behaves. Every tailored resume was
  // losing them: "WORK EXPERIENCE" on the master, "EXPERIENCE" on the copy.
  const tailored = clone();
  delete tailored.sections;
  const { structure, repairs } = validateTailored(SOURCE, tailored);
  assert.deepEqual(structure.sections, SOURCE.sections);
  assert.deepEqual(repairs, [], 'carried across quietly — the model was never able to send them');
});

test('a dropped summary comes back', () => {
  const source = clone();
  source.summary = 'Software engineering student building AI products.';
  const tailored = JSON.parse(JSON.stringify(source)) as ResumeStructure;
  delete tailored.summary;
  const { structure, repairs } = validateTailored(source, tailored);
  assert.equal(structure.summary, source.summary);
  assert.ok(repairs.some((r) => /summary/i.test(r.message)));
});

// ── hostile input ──────────────────────────────────────────────────────────

test('nothing back at all returns the profile rather than throwing', () => {
  for (const bad of [null, undefined, {}, 'nope', 42]) {
    const { structure } = validateTailored(SOURCE, bad);
    assert.deepEqual(orgs(structure), ['Droady', 'Aegon', 'WesternBell'], `input: ${String(bad)}`);
    assert.equal(structure.name, 'Chukwudi Alex');
  }
});

test('malformed sections do not throw', () => {
  const { structure } = validateTailored(SOURCE, {
    experience: 'none',
    projects: { name: 'not an array' },
    education: [null],
    skills: [{ category: 1, items: null }],
  });
  assert.equal(structure.experience.length, 3);
  assert.equal(structure.projects.length, 2);
});

test('an entry the profile has never heard of is reported and kept', () => {
  // Restoring only ever adds something removable; deleting on a bad match
  // destroys real work. So the guard never deletes.
  const tailored = clone();
  tailored.experience.push({ title: 'Product Lead', org: 'Nowhere Inc', location: '', dates: '2021 – 2022', bullets: ['Invented'] });
  const { repairs, structure } = validateTailored(SOURCE, tailored);
  assert.equal(structure.experience.length, 4, 'kept');
  const extra = repairs.filter((r) => r.kind === 'extra');
  assert.equal(extra.length, 1);
  assert.match(extra[0].message, /not in your profile/);
});

test('a warning leads the log rather than trailing it', () => {
  const tailored = clone();
  tailored.experience.splice(1, 1);
  const { repairs } = validateTailored(SOURCE, tailored);
  const { warnings, log } = surfaceRepairs(repairs);
  assert.ok(warnings.length >= 1);
  assert.ok(log.length >= 1);
  for (const line of warnings) assert.ok(line.trim().endsWith('.'), `not a sentence: ${line}`);
});

// ── Nothing appears that was not already there ─────────────────────────────

test('a tailor cannot invent certifications for somebody who has none', () => {
  // keepList handed back whatever the model sent when there was no source list
  // to compare against, and the tailor's schema still carries the field. That
  // is a fabricated credential on a real resume — the one failure this guard
  // exists to prevent. Entries-shaped certifications leave the flat field
  // empty, so it stopped being a corner case and became everybody who has any.
  const tailored = validateTailored(SOURCE, {
    ...SOURCE,
    certifications: ['AWS Certified Solutions Architect – Professional'],
    awards: ['Employee of the Year'],
  });
  assert.equal(tailored.structure.certifications, undefined, 'nothing invented');
  assert.equal(tailored.structure.awards, undefined);
});

test('a tailor cannot add a summary to a resume that has none', () => {
  const tailored = validateTailored(
    { ...SOURCE, summary: undefined },
    { ...SOURCE, summary: 'A results-driven professional with a passion for excellence.' },
  );
  assert.equal(tailored.structure.summary, undefined, 'the person decides what sections they have');
});

test('a summary the person does have is still restored when dropped', () => {
  const withSummary = { ...SOURCE, summary: 'Ships software.' };
  const tailored = validateTailored(withSummary, { ...withSummary, summary: '' });
  assert.equal(tailored.structure.summary, 'Ships software.');
});

test('certifications the person does have are kept, and a dropped one comes back', () => {
  const withCerts = { ...SOURCE, certifications: ['AWS Certified Cloud Practitioner', 'CFA Level I'] };
  const tailored = validateTailored(withCerts, {
    ...withCerts,
    certifications: ['AWS Certified Cloud Practitioner'],
  });
  assert.deepEqual(tailored.structure.certifications, [
    'AWS Certified Cloud Practitioner',
    'CFA Level I',
  ]);
});

// ── a resume that never arrived ────────────────────────────────────────────
//
// A forced tool call guarantees a tool call, not the shape inside it. One real
// tailor wrote 3,315 output tokens and none of it could be read here: every
// entry was "restored", the untouched profile was saved as a tailored resume,
// and a credit was spent on it.

test('a structure that arrives as a JSON string is read, not discarded', () => {
  const tailored = validateTailored(SOURCE, JSON.stringify(clone()));
  assert.equal(tailored.unusable, false);
  assert.deepEqual(orgs(tailored.structure), ['Droady', 'Aegon', 'WesternBell']);
  assert.deepEqual(tailored.repairs, []);
});

test('nothing readable at all is unusable, not a resume', () => {
  for (const nothing of ['not json at all', null, undefined, {}, 42, '{"experience":']) {
    const tailored = validateTailored(SOURCE, nothing);
    assert.equal(tailored.unusable, true, `should be unusable: ${String(nothing)}`);
  }
});

test('an ordinary tailor is never unusable', () => {
  const out = clone();
  out.experience[0].bullets = ['Rewritten for the job'];
  assert.equal(validateTailored(SOURCE, out).unusable, false);
});

test('one dropped entry is a repair, not a failure', () => {
  // The distinction the flag exists for: restoring some of a resume is the
  // safety net working; restoring all of it means there was no resume.
  const out = clone();
  out.experience.splice(1, 1);
  const tailored = validateTailored(SOURCE, out);
  assert.equal(tailored.unusable, false);
  assert.equal(tailored.repairs.filter((r) => r.kind === 'entry').length, 1);
});

test('an empty profile is not a failed tailor', () => {
  const empty = { ...SOURCE, education: [], experience: [], projects: [] };
  assert.equal(validateTailored(empty, { ...empty }).unusable, false);
});

// ── skills: a regroup is not a deletion ────────────────────────────────────

test('terms combined into one item still count as present', () => {
  // "Git/GitHub" for "Git, GitHub" was read as two dropped skills, and the
  // repair appended them to whichever group came last — which is how Git and
  // Vercel ended up filed under "AI & Data" on a real resume.
  const source = { ...SOURCE, skills: [{ category: 'Tools', items: 'Git, GitHub, Data Pipelines' }] };
  const tailored = validateTailored(source, {
    ...source,
    skills: [{ category: 'Tools', items: 'Git/GitHub, Data Pipelines/ETL' }],
  });
  assert.deepEqual(tailored.repairs.filter((r) => r.kind === 'skill'), []);
  assert.equal(tailored.structure.skills.length, 1);
});

test('a skill that really is gone comes back to its own group, not the last one', () => {
  const tailored = validateTailored(SOURCE, {
    ...clone(),
    skills: [
      { category: 'Tools', items: 'Microsoft Excel' },
      { category: 'Languages', items: 'TypeScript, Java, SQL' },
    ],
  });
  const tools = tailored.structure.skills.find((g) => g.category === 'Tools');
  const languages = tailored.structure.skills.find((g) => g.category === 'Languages');
  assert.match(tools!.items, /Ms PowerPoint/);
  assert.doesNotMatch(languages!.items, /PowerPoint/);
  assert.equal(tailored.repairs.filter((r) => r.kind === 'skill').length, 1);
});

test('a short skill is not found inside a longer word', () => {
  // "Go" must not be satisfied by "Google Cloud", or a dropped language is
  // never reported.
  const source = { ...SOURCE, skills: [{ category: 'Languages', items: 'Go, TypeScript' }] };
  const tailored = validateTailored(source, {
    ...source,
    skills: [{ category: 'Languages', items: 'Google Cloud, TypeScript' }],
  });
  const skill = tailored.repairs.find((r) => r.kind === 'skill');
  assert.match(skill!.logLine, /Go/);
});

// ── saying where a restore came from ───────────────────────────────────────

test('an edit restores from the previous version, and says so', () => {
  // The source for an instruction edit is the resume on screen, not the
  // profile. "Restored from your profile, unedited" was untrue on every edit,
  // and visibly so: the restored entry carried the previous tailoring's words.
  const tailored = validateTailored(SOURCE, { ...clone(), experience: [] }, {
    sourceLabel: 'the previous version',
  });
  const restored = tailored.repairs.filter((r) => r.kind === 'entry');
  assert.equal(restored.length, 3);
  for (const repair of restored) {
    assert.match(repair.logLine, /the previous version/);
    assert.doesNotMatch(repair.logLine, /your profile/);
  }
});

test('a tailor still restores from your profile by default', () => {
  const tailored = validateTailored(SOURCE, { ...clone(), projects: [] });
  assert.match(tailored.repairs.find((r) => r.kind === 'entry')!.logLine, /your profile/);
});
