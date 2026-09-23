import assert from 'node:assert/strict';
import test from 'node:test';
import { NOTHING_ASKED, readInstruction } from './asked';
import type { ResumeStructure } from './types';

/**
 * The refusals are the half that matters.
 *
 * A grant that fails to fire costs one free edit and a retry. A grant that fires
 * when it should not takes a job off a resume somebody is about to send, and the
 * app tells them it worked. Two of the cases below are instructions the app
 * itself suggests on buttons under the box.
 */
const RESUME: ResumeStructure = {
  name: 'Chukwudi Alex',
  contact: { email: 'a@example.com' },
  education: [
    { school: 'Ontario Tech University', location: 'Oshawa, ON', degree: 'BEng', dates: 'Sep 2023 – 2028', bullets: [] },
  ],
  experience: [
    { title: 'Software Engineer', org: 'Droady', location: 'San Francisco, CA', dates: 'Nov 2025 – May 2026', bullets: ['shipped a thing'] },
    { title: 'Wealth Manager', org: 'Aegon', location: 'Oshawa, ON', dates: 'May 2025 – Aug 2026', bullets: ['advised clients'] },
    { title: 'Operations', org: 'WesternBell International Ltd.', location: 'Port Harcourt, Nigeria', dates: 'Jun 2024 – Jan 2025', bullets: ['built the site'] },
  ],
  projects: [
    { name: 'MealApp', tech: 'React Native', dates: 'May 2026', bullets: ['a mobile app'] },
    { name: 'Python Rate Limiter', tech: 'Python', dates: 'Jul 2026', bullets: ['three algorithms'] },
  ],
  skills: [{ category: 'Languages', items: 'Java, TypeScript, Python' }],
};

const asked = (words: string) => readInstruction(words, RESUME);

// ── what it grants ─────────────────────────────────────────────────────────

test('naming a job with a removal word removes that job and no other', () => {
  const it = asked('remove the Aegon job');
  assert.equal(it.removes('experience', 'Aegon'), true);
  assert.equal(it.removes('experience', 'Droady'), false);
  assert.equal(it.removes('experience', 'WesternBell International Ltd.'), false);
});

test('an employer is found by the word people actually type', () => {
  // Nobody types "WesternBell International Ltd." into a one-line instruction.
  assert.equal(asked('delete the WesternBell role').removes('experience', 'WesternBell International Ltd.'), true);
});

test('the other removal words work too', () => {
  assert.equal(asked('get rid of the MealApp project').removes('projects', 'MealApp'), true);
  assert.equal(asked('drop the MealApp project').removes('projects', 'MealApp'), true);
  assert.equal(asked('take the MealApp project out').removes('projects', 'MealApp'), true);
});

test('a skill goes without the project of the same name going with it', () => {
  const it = asked('take Python out of my skills');
  assert.equal(it.removesSkill('Python'), true);
  assert.equal(it.removes('projects', 'Python Rate Limiter'), false);
});

test('and the project goes without the skill going with it', () => {
  const it = asked('drop the Python project');
  assert.equal(it.removes('projects', 'Python Rate Limiter'), true);
  assert.equal(it.removesSkill('Python'), false);
});

test('shouting, and punctuation people actually type', () => {
  assert.equal(asked('REMOVE THE AEGON JOB').removes('experience', 'Aegon'), true);
  assert.equal(asked('remove the Aegon job — it’s over').removes('experience', 'Aegon'), true);
});

test('the nearest name after the verb wins, not every name in the sentence', () => {
  const it = asked('get rid of the WesternBell job but keep Aegon');
  assert.equal(it.removes('experience', 'WesternBell International Ltd.'), true);
  assert.equal(it.removes('experience', 'Aegon'), false);
});

test('asking for a summary, and asking for it to go', () => {
  assert.equal(asked('add a summary at the top').wantsSummary, true);
  assert.equal(asked('remove the summary').dropsSummary, true);
  // "summary" is a part-word, so asking about one never licenses an entry.
  assert.equal(asked('remove the summary').removes('experience', 'Aegon'), false);
});

test('a date changes only when they said what it should be, and it came back that way', () => {
  const it = asked('change my Droady end date to Aug 2026');
  assert.equal(it.allowsDates('Droady', 'Nov 2025 – Aug 2026'), true);
  assert.equal(it.allowsDates('Droady', 'Nov 2025 – Dec 2027'), false, 'not what they asked for');
  assert.equal(it.allowsDates('Aegon', 'May 2025 – Aug 2026'), false, 'a different entry');
});

// ── what it refuses ────────────────────────────────────────────────────────

test('the app\'s own suggestion chips never delete anything', () => {
  // These two are printed on buttons under the box. A rule that deletes a job
  // for either of them ships a button that destroys an employment history.
  const shorten = asked('shorten the Aegon bullets');
  assert.equal(shorten.removes('experience', 'Aegon'), false);
  assert.equal(shorten.nearlyRemoves('Aegon'), false, 'not even worded as a removal');

  const second = asked('drop the second bullet');
  assert.equal(second.removes('experience', 'Droady'), false);
  assert.equal(second.removes('projects', 'MealApp'), false);
});

test('a removal aimed at a part of an entry never takes the entry', () => {
  assert.equal(asked('remove the second bullet from Droady').removes('experience', 'Droady'), false);
  assert.equal(asked('take out the part about Stripe at Droady').removes('experience', 'Droady'), false);
  assert.equal(asked('delete the date on the Aegon job').removes('experience', 'Aegon'), false);
});

test('a job that ended is not a job to delete', () => {
  const it = asked('no longer at WesternBell');
  assert.equal(it.removes('experience', 'WesternBell International Ltd.'), false);
  assert.equal(it.allowsDates('WesternBell International Ltd.', 'Jun 2024 – Present'), false, 'no date given');
});

test('being told not to, and being asked about it, are not permission', () => {
  assert.equal(asked("don't remove the Aegon job").removes('experience', 'Aegon'), false);
  assert.equal(asked('why did you remove the Aegon job?').removes('experience', 'Aegon'), false);
  assert.equal(asked('did you delete MealApp?').removes('projects', 'MealApp'), false);
});

test('two entries answering to the same words resolve to neither', () => {
  const twins: ResumeStructure = {
    ...RESUME,
    projects: [
      { name: 'MealApp', tech: 'React Native', dates: 'May 2026', bullets: ['x'] },
      { name: 'MealApp Pro', tech: 'Swift', dates: 'Jun 2026', bullets: ['y'] },
    ],
  };
  const it = readInstruction('remove the MealApp project', twins);
  assert.equal(it.removes('projects', 'MealApp'), false);
  assert.equal(it.removes('projects', 'MealApp Pro'), false);
  assert.equal(it.nearlyRemoves('MealApp'), true, 'and it says so, rather than going quiet');
});

test('a degree is not an edit-box removal', () => {
  assert.equal(asked('remove my Ontario Tech degree').removes('education', 'Ontario Tech University'), false);
});

test('a word that means both delete and shorten asks instead of acting', () => {
  const it = asked('cut the Aegon job');
  assert.equal(it.removes('experience', 'Aegon'), false);
  assert.equal(it.nearlyRemoves('Aegon'), true);
});

test('one grant never leaks into another', () => {
  const it = asked('remove the Aegon job');
  assert.equal(it.wantsSummary, false);
  assert.equal(it.dropsSummary, false);
  assert.equal(it.removesSkill('Python'), false, 'no skill was named');
  assert.equal(it.allowsDates('Aegon', 'May 2025 – Aug 2026'), false, 'no date was named');
});

test('an empty instruction is the same as no instruction', () => {
  const it = readInstruction('   ', RESUME);
  assert.equal(it.words, '');
  assert.equal(it.removes('experience', 'Aegon'), false);
  assert.equal(it.nearlyRemoves('Aegon'), false);
  assert.equal(it.removesSkill('Python'), false);
  assert.equal(it.wantsSummary, false);
  assert.equal(it.dropsSummary, false);
});

test('nothing asked grants nothing', () => {
  assert.equal(NOTHING_ASKED.words, '');
  assert.equal(NOTHING_ASKED.removes('experience', 'Aegon'), false);
  assert.equal(NOTHING_ASKED.nearlyRemoves('Aegon'), false);
  assert.equal(NOTHING_ASKED.removesSkill('Python'), false);
  assert.equal(NOTHING_ASKED.allowsDates('Aegon', 'May 2025 – Aug 2026'), false);
  assert.equal(NOTHING_ASKED.wantsSummary, false);
  assert.equal(NOTHING_ASKED.dropsSummary, false);
});

test('the instruction is kept verbatim, for the honesty check to read', () => {
  assert.equal(asked('  add that I used C# at Droady  ').words, 'add that I used C# at Droady');
});
