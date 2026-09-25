import test from 'node:test';
import assert from 'node:assert/strict';
import { readMove, moveLine } from './sectionMove';
import { withSectionMoved } from './sections';
import { planSections } from './sections';
import type { ResumeStructure } from './types';

const source = {
  name: 'Chukwudi Alex',
  contact: { email: 'a@b.com' },
  summary: 'A short summary.',
  experience: [
    { title: 'Software Engineer', org: 'Droady', location: '', dates: '', bullets: ['shipped a thing'] },
  ],
  education: [{ school: 'Ontario Tech', degree: 'BSc', location: '', dates: '', bullets: ['Coursework: x'] }],
  projects: [{ name: 'FraudWatch', tech: '', dates: '', bullets: ['built a thing'] }],
  skills: [{ category: 'Languages', items: 'Python, C++' }],
  certifications: [],
  awards: [],
  sections: [],
} as unknown as ResumeStructure;

const read = (words: string, answer = '') => readMove(words, source, answer);
const moved = (words: string) => {
  const r = read(words);
  assert.ok(r && 'move' in r, `expected a move from ${JSON.stringify(words)}`);
  return r.move;
};

// ── the sentence that started this ─────────────────────────────────────────

test('"move it after education, below it" asks what to move', () => {
  const r = read('move it after education, below it.');
  assert.ok(r && 'ask' in r);
  assert.match(r.ask, /Move what below Education\?/);
});

test('the same sentence with the answer supplied does the move', () => {
  const r = readMove('move it after education, below it.', source, 'the summary');
  assert.ok(r && 'move' in r);
  assert.equal(r.move.key, 'summary');
  assert.equal(r.move.where, 'after');
  assert.equal(r.move.target, 'education');
});

// ── the ways people say it ─────────────────────────────────────────────────

test('below, under and after all mean after', () => {
  for (const word of ['below', 'under', 'underneath', 'beneath', 'after']) {
    const m = moved(`move the summary ${word} education`);
    assert.equal(m.where, 'after', word);
    assert.equal(m.target, 'education', word);
  }
});

test('above, over and before all mean before', () => {
  for (const word of ['above', 'over', 'before', 'ahead of', 'on top of']) {
    const m = moved(`put skills ${word} experience`);
    assert.equal(m.where, 'before', word);
    assert.equal(m.target, 'experience', word);
  }
});

test('the top and the bottom', () => {
  assert.equal(moved('put skills first').where, 'start');
  assert.equal(moved('move education to the top').where, 'start');
  assert.equal(moved('skills at the very bottom').where, 'end');
  assert.equal(moved('put projects last').where, 'end');
});

test('no verb at all still reads', () => {
  assert.equal(moved('education first').key, 'education');
  assert.equal(moved('summary below education').key, 'summary');
});

test('the word section is optional either side', () => {
  const m = moved('move the skills section above the experience section');
  assert.equal(m.key, 'skills');
  assert.equal(m.target, 'experience');
});

test('words people say rather than print', () => {
  assert.equal(moved('put my jobs above school').key, 'experience');
  assert.equal(moved('put my jobs above school').target, 'education');
  assert.equal(moved('move my bio to the top').key, 'summary');
});

// ── what must NEVER read as a section move ─────────────────────────────────
//
// Same English shape, entirely different request. Resolution is the only thing
// standing between these and a reordered resume.

test('a bullet move is not a section move', () => {
  assert.equal(read('move the Stripe bullet below the AI one'), null);
  assert.equal(read('move the second bullet above the first'), null);
  assert.equal(read('put the FraudWatch bullet last'), null);
});

test('an entry is not a section', () => {
  assert.equal(read('move Droady above Kudi Kitchen'), null);
  assert.equal(read('put the FraudWatch project first'), null);
});

test('a section that is not theirs does not resolve', () => {
  assert.equal(read('move the summary below my references'), null);
});

test('ordinary edits are left alone', () => {
  assert.equal(read('shorten the Aegon bullets'), null);
  assert.equal(read('remove the Aegon job'), null);
  assert.equal(read('add that I used C# at Droady'), null);
  assert.equal(read('make it simpler'), null);
  assert.equal(read('keep it to one page'), null);
});

test('moving a section below itself is not a move', () => {
  assert.equal(read('put skills below skills'), null);
});

// ── skipping the model ─────────────────────────────────────────────────────

test('a sentence that is only a move needs no model', () => {
  assert.equal(moved('move the summary below education').only, true);
  assert.equal(moved('please put skills first').only, true);
  assert.equal(moved('can you move the summary below education, thanks').only, true);
});

test('a sentence carrying anything else still goes to the model', () => {
  assert.equal(moved('move the summary below education and shorten the Droady bullets').only, false);
  assert.equal(moved('put skills first and add Python').only, false);
});

test('an answered question always goes to the model', () => {
  // The exchange is worth a full pass: the answer may carry more than a name.
  const r = readMove('move it below education', source, 'the summary');
  assert.ok(r && 'move' in r);
  assert.equal(r.move.only, false);
});

// ── applying it ────────────────────────────────────────────────────────────

const order = (words: string) => {
  const m = moved(words);
  const out = withSectionMoved(planSections(source), m.key, m.where, m.target);
  assert.ok(out, `expected the move to apply for ${JSON.stringify(words)}`);
  return out.map((s) => s.key);
};

test('the summary moves even though it is in no stored list', () => {
  // Nothing is stored on this resume at all — the order is entirely inferred,
  // which is the case that made the original instruction a no-op.
  assert.deepEqual(source.sections, []);
  assert.deepEqual(order('move the summary below education'), [
    'education',
    'summary',
    'experience',
    'projects',
    'skills',
    'certifications',
    'awards',
  ]);
});

test('to the top and to the bottom', () => {
  assert.equal(order('put skills first')[0], 'skills');
  assert.equal(order('put education last').at(-1), 'education');
});

test('the whole order is written down, not just the moved one', () => {
  // Two places deciding order is how a deliberately placed section drifts back.
  const out = withSectionMoved(planSections(source), 'summary', 'after', 'education');
  assert.ok(out);
  assert.equal(out.length, planSections(source).length);
  assert.ok(out.every((s) => s.key && s.label && s.shape));
});

test('a move that changes nothing is refused', () => {
  // The summary is already first; moving it to the top is not a change.
  assert.equal(withSectionMoved(planSections(source), 'summary', 'start', null), null);
});

test('a section that is not there cannot move', () => {
  assert.equal(withSectionMoved(planSections(source), 'volunteering', 'start', null), null);
});

test('a target that is not there refuses rather than guesses', () => {
  assert.equal(withSectionMoved(planSections(source), 'summary', 'after', 'volunteering'), null);
});

// ── how it reads afterwards ────────────────────────────────────────────────

test('the change log says what happened in plain words', () => {
  assert.equal(moveLine(moved('move the summary below education')), 'Summary moved below Education.');
  assert.equal(moveLine(moved('put skills first')), 'Technical Skills moved to the top.');
  assert.equal(moveLine(moved('put projects last')), 'Projects moved to the bottom.');
  assert.equal(moveLine(moved('put skills above experience')), 'Technical Skills moved above Experience.');
});
