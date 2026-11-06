import assert from 'node:assert/strict';
import test from 'node:test';
import { frozenLine, onlyWhereAsked, readScope } from './scope';
import type { ResumeStructure } from './types';

/** The resume from the Nov 4 run, shortened. */
const RESUME: ResumeStructure = {
  name: 'Chukwudi Alex',
  contact: { email: 'a@example.com' },
  education: [
    { school: 'Ontario Tech University', location: 'Oshawa, ON', degree: 'BEng', dates: 'Sep 2023 – 2028', bullets: ['Relevant Coursework: Data Structures, Web Programming'] },
  ],
  experience: [
    { title: 'Founder', org: 'Kudi Kitchen', location: 'Oshawa, ON', dates: 'Mar 2025 – Present', bullets: ['Increased checkout completion by 15–25%', 'Own every stage of the product'] },
    { title: 'Wealth Manager', org: 'Aegon', location: 'Oshawa, ON', dates: 'May 2025 – Aug 2026', bullets: ['Grew client portfolios by 12–18%', 'Maintained 95% retention'] },
    { title: 'Software Engineer', org: 'Droady', location: 'San Francisco, CA', dates: 'Nov 2025 – May 2026', bullets: ['Shipped the physique rating feature', 'Deployed the service with Docker'] },
  ],
  projects: [
    { name: 'Resumi', tech: 'Next.js', dates: 'Jun 2026 – Present', bullets: ['Built a resume tailoring app', 'Containerised the compiler with Docker'] },
    { name: 'FraudWatch', tech: 'Java', dates: 'Aug 2026', bullets: ['Backend lead on a 3-person team', 'Set up an automated CI pipeline'] },
  ],
  skills: [
    { category: 'Languages', items: 'TypeScript, Python, SQL' },
    { category: 'Tools & Practices', items: 'Git, Docker, Vercel' },
  ],
};

const edit = (over: Partial<ResumeStructure>): ResumeStructure => ({ ...RESUME, ...over });
const reword = (text: string) => `${text} — rewritten`;

// ── what a sentence is about ───────────────────────────────────────────────

test('an entry by name', () => {
  const scope = readScope('shorten the Aegon bullets', RESUME);
  assert.equal(scope.whole, false);
  assert.equal(scope.touchesEntry('experience', 'Aegon'), true);
  assert.equal(scope.touchesEntry('experience', 'Droady'), false);
  assert.equal(scope.touches('skills'), false);
});

test('a whole section by its noun', () => {
  const scope = readScope('make the projects shorter', RESUME);
  assert.equal(scope.touchesEntry('projects', 'Resumi'), true);
  assert.equal(scope.touchesEntry('projects', 'FraudWatch'), true);
  assert.equal(scope.touchesEntry('experience', 'Aegon'), false);
});

test('a skill, with nothing calling it one', () => {
  const scope = readScope('remove Docker', RESUME);
  assert.equal(scope.touches('skills'), true, 'the skills line is in scope');
});

test('and every entry that mentions it', () => {
  // The half that naming alone gets wrong: scoping "remove Docker" to the
  // skills line would leave the word on the page in the two places somebody
  // actually reads it.
  const scope = readScope('remove Docker', RESUME);
  assert.equal(scope.touchesEntry('experience', 'Droady'), true, 'its bullet says Docker');
  assert.equal(scope.touchesEntry('projects', 'Resumi'), true, 'so does this one');
  assert.equal(scope.touchesEntry('experience', 'Aegon'), false, 'this one does not');
  assert.equal(scope.touchesEntry('projects', 'FraudWatch'), false);
});

test('a sentence naming nothing findable is about the whole page', () => {
  for (const said of ['make it more concise', 'fix the typos', 'tighten the wording']) {
    assert.equal(readScope(said, RESUME).whole, true, said);
  }
});

test('the override forces the whole page', () => {
  assert.equal(readScope('shorten the Aegon bullets', RESUME, true).whole, true);
});

test('an empty instruction is unscoped rather than everything frozen', () => {
  assert.equal(readScope('', RESUME).whole, true);
});

// ── holding it to that ─────────────────────────────────────────────────────

test('a bullet rewritten outside the scope goes back', () => {
  const scope = readScope('shorten the Aegon bullets', RESUME);
  const edited = edit({
    experience: [
      RESUME.experience[0],
      { ...RESUME.experience[1], bullets: ['Grew portfolios 12–18%'] },
      { ...RESUME.experience[2], bullets: [reword('Shipped the physique rating feature'), 'Deployed the service with Docker'] },
    ],
  });
  const { structure, frozen } = onlyWhereAsked(RESUME, edited, scope);

  assert.deepEqual(structure.experience[1].bullets, ['Grew portfolios 12–18%'], 'Aegon changed, as asked');
  assert.deepEqual(structure.experience[2].bullets, RESUME.experience[2].bullets, 'Droady is byte for byte');
  assert.deepEqual(frozen, ['Droady']);
});

test('an entry deleted without being named comes back', () => {
  // The change this is most worth stopping.
  const scope = readScope('shorten the Aegon bullets', RESUME);
  const edited = edit({ experience: [RESUME.experience[0], RESUME.experience[1]] });
  const { structure, frozen } = onlyWhereAsked(RESUME, edited, scope);
  assert.equal(structure.experience.length, 3);
  assert.deepEqual(structure.experience[2], RESUME.experience[2]);
  assert.deepEqual(frozen, ['Droady']);
});

test('an entry the sentence named and the guard removed stays removed', () => {
  /*
   * The Scotiabank swap, which came back with both halves of it.
   *
   * "Replace the Kudi Kitchen project with the Resumi project" reached here
   * with the guard having already allowed the removal — it logged "Kudi
   * Kitchen: removed, as you asked" — and this pass put the project straight
   * back, silently, with nothing in `frozen` to say so. The person got a
   * resume carrying both projects and five bullets cut elsewhere to fit them.
   *
   * Whether a removal was asked for is the guard's decision, not this one's.
   */
  const scope = readScope('Replace the FraudWatch project with the MealApp project', RESUME);
  assert.equal(scope.touchesEntry('projects', 'FraudWatch'), true, 'the sentence named it');
  const edited = edit({ projects: [RESUME.projects[0]] });
  const { structure, frozen } = onlyWhereAsked(RESUME, edited, scope);
  assert.deepEqual(
    (structure.projects as { name: string }[]).map((p) => p.name),
    ['Resumi'],
    'FraudWatch is gone, as the sentence asked and the guard allowed',
  );
  assert.deepEqual(frozen, [], 'and nothing was held, so nothing is reported');
});

test('an entry deleted inside a named SECTION also stays removed', () => {
  // The section noun puts every entry in it in scope, so the same rule applies
  // to "drop FraudWatch from my projects" as to naming it outright.
  const scope = readScope('drop FraudWatch from my projects', RESUME);
  const edited = edit({ projects: [RESUME.projects[0]] });
  const { structure } = onlyWhereAsked(RESUME, edited, scope);
  assert.equal((structure.projects as unknown[]).length, 1);
});

test('a date changed outside the scope goes back too', () => {
  const scope = readScope('shorten the Aegon bullets', RESUME);
  const edited = edit({
    experience: [
      RESUME.experience[0],
      RESUME.experience[1],
      { ...RESUME.experience[2], dates: 'Nov 2025 – Present' },
    ],
  });
  const { structure } = onlyWhereAsked(RESUME, edited, scope);
  assert.equal(structure.experience[2].dates, 'Nov 2025 – May 2026', 'whole entries are restored, not fields');
});

test('skills rewritten when nothing named them go back', () => {
  const scope = readScope('shorten the Aegon bullets', RESUME);
  const edited = edit({ skills: [{ category: 'Languages', items: 'TypeScript' }] });
  const { structure, frozen } = onlyWhereAsked(RESUME, edited, scope);
  assert.deepEqual(structure.skills, RESUME.skills);
  assert.ok(frozen.includes('your skills'));
});

test('skills change when they were named', () => {
  const scope = readScope('remove Docker', RESUME);
  const edited = edit({ skills: [{ category: 'Languages', items: 'TypeScript, Python, SQL' }, { category: 'Tools & Practices', items: 'Git, Vercel' }] });
  const { structure, frozen } = onlyWhereAsked(RESUME, edited, scope);
  assert.equal(/Docker/.test(JSON.stringify(structure.skills)), false);
  assert.deepEqual(frozen, []);
});

test('an unscoped edit is passed through untouched', () => {
  const scope = readScope('make it more concise', RESUME);
  const edited = edit({ skills: [], experience: [] });
  const { structure, frozen } = onlyWhereAsked(RESUME, edited, scope);
  assert.deepEqual(structure, edited, 'nothing is held when nothing was named');
  assert.deepEqual(frozen, []);
});

test('nothing frozen when the edit stayed where it was asked', () => {
  const scope = readScope('shorten the Aegon bullets', RESUME);
  const edited = edit({
    experience: [RESUME.experience[0], { ...RESUME.experience[1], bullets: ['Shorter'] }, RESUME.experience[2]],
  });
  assert.deepEqual(onlyWhereAsked(RESUME, edited, scope).frozen, []);
});

test('an entry added outside the scope does not survive', () => {
  const scope = readScope('shorten the Aegon bullets', RESUME);
  const edited = edit({
    projects: [...RESUME.projects, { name: 'Invented', tech: 'Go', dates: '2026', bullets: ['Nobody asked for this'] }],
  });
  const { structure, frozen } = onlyWhereAsked(RESUME, edited, scope);
  assert.equal(structure.projects.length, 2);
  assert.ok(frozen.includes('Invented'));
});

test('education is held unless it was named', () => {
  const scope = readScope('shorten the Aegon bullets', RESUME);
  const edited = edit({ education: [{ ...RESUME.education[0], bullets: ['Relevant Coursework: Data Structures'] }] });
  const { structure } = onlyWhereAsked(RESUME, edited, scope);
  assert.deepEqual(structure.education, RESUME.education);
  assert.equal(readScope('add Linear Algebra to my coursework', RESUME).touchesEntry('education', 'Ontario Tech University'), true);
});

// ── saying so ──────────────────────────────────────────────────────────────

test('the sentence names what changed and what was held', () => {
  const line = frozenLine(['Droady'], ['Aegon']);
  assert.match(line, /changed Aegon only/);
  assert.match(line, /Droady was also rewritten/);
  assert.match(line, /whole resume/);
});

test('several of each read as lists', () => {
  const line = frozenLine(['Droady', 'your skills'], ['Aegon', 'Kudi Kitchen']);
  assert.match(line, /Aegon and Kudi Kitchen only/);
  assert.match(line, /Droady and your skills were also rewritten/);
});

test('the verb agrees with the subject, not with the count', () => {
  // "your skills was also rewritten" sat on every scoped edit for weeks.
  const skills = frozenLine(['your skills'], ['Aegon']);
  assert.match(skills, /Your skills were also rewritten/, 'plural subject, plural verb, and a capital after the stop');
  assert.match(skills, /those are back as they were/);

  const entry = frozenLine(['Droady'], ['Aegon']);
  assert.match(entry, /Droady was also rewritten/);
  assert.match(entry, /that is back as it was/);
});

test('the frozen list starts a sentence, so it starts with a capital', () => {
  assert.ok(!/only\. [a-z]/.test(frozenLine(['your summary'], ['Aegon'])));
});
