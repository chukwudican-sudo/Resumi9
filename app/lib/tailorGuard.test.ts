import assert from 'node:assert/strict';
import test from 'node:test';
import { readInstruction } from './asked';
import { normaliseTailored, surfaceRepairs, validateTailored, withoutUndoneClaims } from './tailorGuard';
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

test('reordering the entries is not a deletion, and does not survive either', () => {
  /*
   * Two separate claims, and the second one changed.
   *
   * A reorder is not a deletion and never raises a repair — that is what this
   * test was written for. It also asserted that the new order survived, which
   * was incidental and turned out to be wrong: measured over eleven resumes
   * from one run, three printed a project still marked "Present" below one
   * that finished in August, and several put MealApp above Resumi where the
   * profile has Resumi first. Dates running downwards is a convention a
   * reader checks, and the profile's order already follows it — inPrintOrder
   * sorts on real date parts, where the model sees a display string.
   */
  const tailored = clone();
  tailored.experience = [tailored.experience[2], tailored.experience[0], tailored.experience[1]];
  const { repairs, structure } = validateTailored(SOURCE, tailored);
  assert.deepEqual(repairs, [], 'nothing was deleted, so nothing is repaired');
  assert.deepEqual(orgs(structure), ['Droady', 'Aegon', 'WesternBell'], 'printed in the profile’s order');
});

test('a project the tailor moved up goes back where it belongs', () => {
  const tailored = clone();
  tailored.projects = [tailored.projects[1], tailored.projects[0]];
  const { structure } = validateTailored(SOURCE, tailored);
  assert.deepEqual(structure.projects.map((p) => p.name), ['MealApp', 'FraudWatch']);
});

test('a stray keeps its place rather than being swept to the end', () => {
  // It earns its own warning; moving it as well makes that harder to read.
  const tailored = clone();
  tailored.projects = [
    tailored.projects[0],
    { name: 'Not in the profile', tech: 'Go', dates: '2026', bullets: ['x'] },
    tailored.projects[1],
  ];
  const { structure } = validateTailored(SOURCE, tailored);
  assert.deepEqual(structure.projects.map((p) => p.name), ['MealApp', 'Not in the profile', 'FraudWatch']);
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

test('certifications that came back untouched are not reported as restored', () => {
  /*
   * The false positive this file's header warns about, and it shipped.
   *
   * `keepList` takes its parameter as `returned` — renamed so it would not
   * shadow the `from` label outside — and the body was left reading `from`.
   * That is a string, never undefined, and a list made from a string is empty,
   * so every item counted as missing. EVERY tailor, for everybody holding a
   * certification or an award, ended with a line saying theirs had been dropped
   * and put back when nothing had touched them.
   *
   * Nothing caught it because the only test here dropped an item and checked it
   * came back — which the broken version did, by restoring everything.
   */
  const withCerts = {
    ...SOURCE,
    certifications: ['AWS Certified Cloud Practitioner', 'CFA Level I'],
    awards: ['Dean\'s List'],
  };
  const tailored = validateTailored(withCerts, { ...withCerts });

  assert.deepEqual(tailored.structure.certifications, ['AWS Certified Cloud Practitioner', 'CFA Level I']);
  assert.deepEqual(tailored.structure.awards, ["Dean's List"]);
  assert.deepEqual(tailored.repairs, [], 'nothing was dropped, so nothing is claimed');
});

test('a list the tailor never mentioned is kept without comment', () => {
  // Optional fields, and an omission was never proof of a loss.
  const withCerts = { ...SOURCE, certifications: ['CFA Level I'] };
  const { certifications, ...silent } = withCerts;
  const tailored = validateTailored(withCerts, silent as typeof withCerts);

  assert.deepEqual(tailored.structure.certifications, ['CFA Level I']);
  assert.deepEqual(tailored.repairs, []);
});

test('a reordered list is kept in the order the tailor chose', () => {
  const withCerts = { ...SOURCE, certifications: ['AWS Certified Cloud Practitioner', 'CFA Level I'] };
  const tailored = validateTailored(withCerts, {
    ...withCerts,
    certifications: ['CFA Level I', 'AWS Certified Cloud Practitioner'],
  });

  assert.deepEqual(tailored.structure.certifications, ['CFA Level I', 'AWS Certified Cloud Practitioner']);
  assert.deepEqual(tailored.repairs, [], 'reordering is the tailor\'s to decide');
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
  assert.match(tailored.structure.skills[0].items, /Git\/GitHub/, 'the merge of two sourced terms stands');
  assert.equal(tailored.structure.skills.length, 1);
  /*
   * "Data Pipelines/ETL" is the other half of the same case and goes the
   * other way: Data Pipelines is theirs and ETL is in neither their skills
   * nor their bullets, so the item keeps the half they claimed. Nothing
   * checked additions when this test was written.
   */
  assert.match(tailored.structure.skills[0].items, /Data Pipelines(?!\/ETL)/);
  assert.equal(/ETL/.test(tailored.structure.skills[0].items), false);
  assert.ok(tailored.repairs.some((r) => /ETL/.test(r.message)));
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

// ── what the person asked for ──────────────────────────────────────────────
//
// The guard was built against a model that drops things on its own. Told to
// remove the Aegon job, it put the job straight back and blamed the tailoring
// for the loss — on a screen quoting the instruction directly above it.

const asking = (words: string) => readInstruction(words, SOURCE);
const edit = (words: string) => ({ sourceLabel: 'the previous version', asked: asking(words) });

test('a job the person asked to remove stays removed', () => {
  const tailored = clone();
  tailored.experience = tailored.experience.filter((e) => e.org !== 'Aegon');

  const { structure, repairs } = validateTailored(SOURCE, tailored, edit('remove the Aegon job'));
  assert.deepEqual(orgs(structure), ['Droady', 'WesternBell']);

  const { warnings, log } = surfaceRepairs(repairs);
  assert.deepEqual(warnings, [], 'doing what was asked is not something to check before sending');
  assert.ok(log.some((line) => /Aegon.*removed, as you asked/.test(line)), log.join(' | '));
});

test('the same drop, with nothing asked, is still put back', () => {
  const tailored = clone();
  tailored.experience = tailored.experience.filter((e) => e.org !== 'Aegon');
  const { structure } = validateTailored(SOURCE, tailored, edit('shorten the Aegon bullets'));
  assert.deepEqual(orgs(structure), ['Droady', 'Aegon', 'WesternBell']);
});

test('a removal worded two ways is put back, and says what would have worked', () => {
  // A backstop now: "cut the Aegon job" is put to the person as a question
  // before anything runs. This is the path for a removal nobody queried.
  const tailored = clone();
  tailored.experience = tailored.experience.filter((e) => e.org !== 'Aegon');

  const { structure, repairs } = validateTailored(SOURCE, tailored, edit('cut the Aegon job'));
  assert.deepEqual(orgs(structure), ['Droady', 'Aegon', 'WesternBell']);

  const { warnings } = surfaceRepairs(repairs);
  assert.ok(
    warnings.some((w) => /not clearly enough to act on/.test(w) && /Remove the Aegon job/.test(w)),
    warnings.join(' | '),
  );
});

test('a skill the person asked to lose stays lost', () => {
  const tailored = clone();
  tailored.skills = [
    { category: 'Languages', items: 'TypeScript, SQL' },
    { category: 'Tools', items: 'Microsoft Excel, Ms PowerPoint' },
  ];
  const { structure, repairs } = validateTailored(SOURCE, tailored, edit('take Java out of my skills'));
  assert.doesNotMatch(JSON.stringify(structure.skills), /Java/);
  assert.ok(repairs.some((r) => r.kind === 'asked' && /Java/.test(r.logLine)));
});

test('a summary is written when asked for, and still dropped when not', () => {
  const withOne = clone();
  withOne.summary = 'Engineer who ships.';

  const asked = validateTailored(SOURCE, withOne, edit('add a summary at the top'));
  assert.equal(asked.structure.summary, 'Engineer who ships.');

  const unasked = validateTailored(SOURCE, withOne, edit('shorten the Aegon bullets'));
  assert.equal(unasked.structure.summary, undefined, 'a tailored copy grows no section of its own');
});

test('a date moves on the entry that was named, and nowhere else', () => {
  const tailored = clone();
  tailored.experience[0].dates = 'Nov 2025 – Aug 2026';
  tailored.experience[1].dates = 'May 2025 – Dec 2099';

  const { structure } = validateTailored(SOURCE, tailored, edit('change my Droady end date to Aug 2026'));
  assert.equal(structure.experience[0].dates, 'Nov 2025 – Aug 2026');
  assert.equal(structure.experience[1].dates, 'May 2025 – Aug 2026', 'Aegon was not asked about');
});

test('a one-job resume plus "remove that job" is not a failed edit', () => {
  // It pairs nothing and the source had an entry, which used to read as a
  // broken edit and return an error — refusing the request, then blaming the
  // model for it.
  const single: ResumeStructure = { ...SOURCE, experience: [SOURCE.experience[1]], projects: [], education: [] };
  const { unusable, structure } = validateTailored(single, { ...single, experience: [] }, {
    sourceLabel: 'the previous version',
    asked: readInstruction('remove the Aegon job', single),
  });
  assert.equal(unusable, false);
  assert.deepEqual(orgs(structure), []);
});

test('an emptied education entry keeps its bullets, like the other two', () => {
  // It did not, and that is what cost a real coursework line when every bullet
  // on the resume was deleted at once.
  const tailored = clone();
  tailored.education[0].bullets = [];
  const { structure } = validateTailored(SOURCE, tailored);
  assert.deepEqual(structure.education[0].bullets, ['Relevant coursework: Data Structures']);
});

test('education lets go when the person asked for a removal', () => {
  // Blanket protection is the mistake that stopped "remove the Aegon job"
  // working. "Remove the coursework line" names no entry, so nothing finer
  // would catch it.
  const tailored = clone();
  tailored.education[0].bullets = [];
  const { structure } = validateTailored(SOURCE, tailored, edit('remove the coursework line'));
  assert.deepEqual(structure.education[0].bullets, []);
});

test('the model cannot claim it removed something the guard put back', () => {
  // One screen said "Removed the Aegon entry as instructed" on the left while
  // the right said it had been put back. Both sentences, one of them false.
  const kept = withoutUndoneClaims(
    [
      'Removed the Aegon (Wealth Manager) entry from Experience as instructed; no other content changed.',
      'Reordered the projects to lead with FraudWatch.',
    ],
    ['Aegon'],
  );
  assert.deepEqual(kept, ['Reordered the projects to lead with FraudWatch.']);
});

test('a line about something that really went is left alone', () => {
  const kept = withoutUndoneClaims(['Removed the Aegon entry as instructed.'], ['WesternBell']);
  assert.equal(kept.length, 1);
});

test('nothing restored means nothing dropped from the log', () => {
  const lines = ['Removed the Aegon entry.', 'Tightened two bullets.'];
  assert.deepEqual(withoutUndoneClaims(lines, []), lines);
});

// ── a renamed skills line ──────────────────────────────────────────────────
//
// From the Nov 4 run: the Qualcomm ML resume printed "AI & ML" near the top
// and then, after Tools & Practices at the very bottom, an orphan line
// reading "AI & Data: AI-Assisted Development Tools". One category, printed
// twice, because the repair created a line with the old name for the terms it
// thought were missing.

test('a renamed line gets its put-back terms, not a second line', () => {
  const tailored = clone();
  // What the tailor did: renamed the line and dropped one of its items.
  tailored.skills = [
    { category: 'Languages', items: 'TypeScript, Java, SQL' },
    { category: 'Tooling for ML', items: 'Microsoft Excel' },
  ];
  const { structure, repairs } = validateTailored(SOURCE, tailored);

  assert.equal(structure.skills.length, 2, `one line per category; got ${structure.skills.map((g) => g.category).join(' | ')}`);
  const renamed = structure.skills.find((g) => g.category === 'Tooling for ML')!;
  assert.match(renamed.items, /PowerPoint/, 'the term went home to the renamed line');
  assert.ok(repairs.some((r) => /put back/i.test(r.logLine ?? r.message)));
});

test('a line that really is gone still gets one', () => {
  const tailored = clone();
  // Nothing of the Tools line survives anywhere, so there is nowhere to put
  // its terms and a new line is the honest answer.
  tailored.skills = [{ category: 'Languages', items: 'TypeScript, Java, SQL' }];
  const { structure } = validateTailored(SOURCE, tailored);
  assert.equal(structure.skills.length, 2);
  assert.match(structure.skills[1].items, /Excel/);
});

test('the same term is never printed twice', () => {
  const tailored = clone();
  tailored.skills = [
    { category: 'Languages', items: 'TypeScript, Java, SQL, TypeScript' },
    { category: 'Tools', items: 'Microsoft Excel, Ms PowerPoint, Java' },
  ];
  const { structure } = validateTailored(SOURCE, tailored);
  assert.deepEqual(structure.skills[0].items.split(', '), ['TypeScript', 'Java', 'SQL']);
  assert.equal(/Java/.test(structure.skills[1].items), false, 'the second Java goes, the first stays');
});

test('a line left with nothing after deduping is not printed empty', () => {
  const tailored = clone();
  tailored.skills = [
    { category: 'Languages', items: 'TypeScript, Java, SQL, Microsoft Excel, Ms PowerPoint' },
    { category: 'Tools', items: 'Microsoft Excel, Ms PowerPoint' },
  ];
  const { structure } = validateTailored(SOURCE, tailored);
  assert.equal(structure.skills.length, 1, 'the duplicate line is gone, not blank');
});

// ── a skill they have never claimed ────────────────────────────────────────
//
// The skills repair was one-directional for its whole life: it put back what
// the tailoring dropped and said nothing about what the tailoring ADDED. A
// model returning a "Cloud & DevOps" line holding Kubernetes, Terraform and
// AWS SageMaker — none of them anywhere in the profile — came through with
// zero repairs.

test('a skill the profile does not mention is taken off', () => {
  const tailored = clone();
  tailored.skills = [
    { category: 'Languages', items: 'TypeScript, Java, SQL' },
    { category: 'Cloud & DevOps', items: 'Kubernetes, Terraform' },
  ];
  const { structure, repairs } = validateTailored(SOURCE, tailored);
  assert.equal(/Kubernetes|Terraform/.test(JSON.stringify(structure.skills)), false);
  assert.ok(repairs.some((r) => /does not mention/.test(r.message)));
});

test('a skill named in their own bullets is theirs to list', () => {
  // The vocabulary is the whole record, not the skills line: something they
  // did and wrote down is something they can claim as a skill.
  const source = clone();
  source.experience[0].bullets = ['Integrated an AI model', 'Deployed the service with Terraform'];
  const tailored = JSON.parse(JSON.stringify(source)) as ResumeStructure;
  tailored.skills = [{ category: 'Infrastructure', items: 'Terraform' }];
  const { structure, repairs } = validateTailored(source, tailored);
  assert.match(JSON.stringify(structure.skills), /Terraform/);
  assert.equal(repairs.some((r) => /does not mention/.test(r.message)), false);
});

test('a compound of two sourced terms is not an invention', () => {
  // "Git/GitHub" merges two terms the profile has. Refusing it would make
  // regrouping — which the tailor is allowed to do — impossible.
  const source = clone();
  source.skills = [{ category: 'Tools', items: 'Git, GitHub, Microsoft Excel' }];
  const tailored = JSON.parse(JSON.stringify(source)) as ResumeStructure;
  tailored.skills = [{ category: 'Tools', items: 'Git/GitHub, Microsoft Excel' }];
  const { structure } = validateTailored(source, tailored);
  assert.match(structure.skills[0].items, /Git\/GitHub/);
});

test('a category the profile does not have is still the tailor’s to choose', () => {
  // A heading is not a claim. Only the items are checked.
  const tailored = clone();
  tailored.skills = [{ category: 'Languages & Data', items: 'TypeScript, Java, SQL' }];
  const { structure } = validateTailored(SOURCE, tailored);
  assert.equal(structure.skills[0].category, 'Languages & Data');
});

test('facts the person answered count as their record', () => {
  const tailored = clone();
  tailored.skills = [
    { category: 'Languages', items: 'TypeScript, Java, SQL' },
    { category: 'Design', items: 'Figma' },
    { category: 'Tools', items: 'Microsoft Excel, Ms PowerPoint' },
  ];
  const withFacts = validateTailored(SOURCE, tailored, {
    alsoSaid: 'Did user research and wireframing/prototyping in Figma for MealApp',
  });
  assert.match(JSON.stringify(withFacts.structure.skills), /Figma/);

  const without = validateTailored(SOURCE, JSON.parse(JSON.stringify(tailored)));
  assert.equal(/Figma/.test(JSON.stringify(without.structure.skills)), false, 'nothing in the record says Figma');
});

// ── a skill the tailor left out on purpose ────────────────────────────────
//
// Every omission used to be reversed. On a trading-floor posting that meant
// forcing "Prompt Engineering, Large Language Models (LLMs), Claude, AI
// Agents" back onto a resume the tailor had deliberately cleared of them, and
// it is the same mechanism that kept re-adding Excel and PowerPoint to
// technical roles.

const WIDE: ResumeStructure = {
  ...SOURCE,
  skills: [
    { category: 'Languages', items: 'TypeScript, Java, SQL, Python' },
    { category: 'AI & Data', items: 'Prompt Engineering, Claude, AI Agents, Data Pipelines' },
    { category: 'Tools', items: 'Git, Docker, Microsoft Excel, Ms PowerPoint' },
  ],
};
/** What a tailor returns for a job that wants backend engineering. */
const FOCUSED = {
  ...WIDE,
  skills: [
    { category: 'Languages', items: 'TypeScript, Java, SQL, Python' },
    { category: 'Tools', items: 'Git, Docker' },
  ],
};
const BACKEND_POSTING = 'Backend engineer. TypeScript, SQL, Docker, Git. Python a plus.';

test('an omission the posting does not ask for stands', () => {
  const guarded = validateTailored(WIDE, FOCUSED, { posting: BACKEND_POSTING });
  const written = JSON.stringify(guarded.structure.skills);
  for (const gone of ['Prompt Engineering', 'Claude', 'AI Agents', 'Microsoft Excel', 'Ms PowerPoint']) {
    assert.equal(written.includes(gone), false, `${gone} was not asked for and should stay off`);
  }
});

test('and is reported as a choice, not as a repair', () => {
  const guarded = validateTailored(WIDE, FOCUSED, { posting: BACKEND_POSTING });
  const log = guarded.repairs.map((r) => r.logLine).join('\n');
  assert.match(log, /left out \d+ terms this posting does not ask for/);
  assert.match(log, /They stay in your profile/);
  assert.ok(!/put back/.test(log), 'nothing was put back, so nothing says it was');
  // And never as something to check before sending: it is not a problem.
  assert.deepEqual(surfaceRepairs(guarded.repairs).warnings, []);
});

test('an omission the posting DOES ask for comes back', () => {
  const dropped = { ...WIDE, skills: [{ category: 'Languages', items: 'TypeScript, Java' }] };
  const guarded = validateTailored(WIDE, dropped, { posting: 'We need SQL and Docker.' });
  const written = JSON.stringify(guarded.structure.skills);
  assert.ok(written.includes('SQL'), 'the posting asked for it');
  assert.ok(written.includes('Docker'), 'the posting asked for it');
});

test('an edit still treats every omission as damage', () => {
  // No posting is passed on the edit path: an edit is a surgical change, not
  // a selection pass, so a skill vanishing from one is not a choice.
  const guarded = validateTailored(WIDE, FOCUSED, { sourceLabel: 'the previous version' });
  const written = JSON.stringify(guarded.structure.skills);
  for (const back of ['Prompt Engineering', 'Claude', 'Microsoft Excel']) {
    assert.ok(written.includes(back), `${back} should be put back on an edit`);
  }
});

test('a tailoring that kept almost nothing is a failure, not a selection', () => {
  const collapsed = { ...WIDE, skills: [{ category: 'Languages', items: 'TypeScript' }] };
  const guarded = validateTailored(WIDE, collapsed, { posting: 'Nothing in common.' });
  const written = JSON.stringify(guarded.structure.skills);
  assert.ok(written.includes('Prompt Engineering'), 'one term out of twelve is a malfunction');
  assert.match(guarded.repairs.map((r) => r.logLine).join('\n'), /put back/);
});

// ── a gloss is not a different skill ──────────────────────────────────────

test('dropping a parenthetical does not count as dropping the skill', () => {
  const source = { ...SOURCE, skills: [{ category: 'Tools', items: 'GitHub Actions (CI/CD), Docker' }] };
  const tailored = { ...source, skills: [{ category: 'Tools', items: 'GitHub Actions, Docker' }] };
  const guarded = validateTailored(source, tailored, { posting: 'CI/CD and Docker.' });
  const items = (guarded.structure.skills[0] as { items: string }).items;
  assert.equal(items.split(',').filter((t) => /GitHub Actions/.test(t)).length, 1, 'listed once, not twice');
});

test('the fuller spelling is the one printed', () => {
  const source = { ...SOURCE, skills: [{ category: 'Tools', items: 'GitHub Actions (CI/CD)' }] };
  const tailored = { ...source, skills: [{ category: 'Tools', items: 'GitHub Actions, GitHub Actions (CI/CD)' }] };
  const guarded = validateTailored(source, tailored, { posting: 'CI/CD.' });
  assert.equal((guarded.structure.skills[0] as { items: string }).items, 'GitHub Actions (CI/CD)');
});

test('a comma inside brackets does not split a term in half', () => {
  const source = { ...SOURCE, skills: [{ category: 'Cloud', items: 'Cloud Platforms (Vercel, Cloudflare), Docker' }] };
  const guarded = validateTailored(source, source, { posting: 'Vercel.' });
  assert.equal(
    (guarded.structure.skills[0] as { items: string }).items,
    'Cloud Platforms (Vercel, Cloudflare), Docker',
    'two terms, not three',
  );
});

test('a skill the person asked for is not stripped as invented', () => {
  /*
   * "add Kubernetes to my skills" went to the model, came back with
   * Kubernetes on the page, and the guard took it straight off: the record
   * it checks against was the profile and the answered facts, never the
   * sentence the person had just typed. The app refusing a request on the
   * grounds that it had not heard it before.
   */
  const tailored = {
    ...SOURCE,
    skills: [...SOURCE.skills, { category: 'Infrastructure', items: 'Kubernetes' }],
  };
  const without = validateTailored(SOURCE, tailored, { sourceLabel: 'the previous version' });
  assert.ok(!JSON.stringify(without.structure.skills).includes('Kubernetes'), 'unasked, it is still an invention');

  const asAsked = validateTailored(SOURCE, tailored, {
    sourceLabel: 'the previous version',
    alsoSaid: 'add Kubernetes to my skills',
  });
  assert.ok(JSON.stringify(asAsked.structure.skills).includes('Kubernetes'), 'they said it, so it is theirs');
});
