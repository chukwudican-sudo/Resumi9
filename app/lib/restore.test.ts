import test from 'node:test';
import assert from 'node:assert/strict';
import { readRestore, restoreLine, withRestored } from './restore';
import type { DroppedEntry } from './fit';

const job = (name: string, index: number): DroppedEntry => ({
  section: 'experience',
  index,
  name,
  entry: { title: 'Engineer', org: name, location: 'Oshawa, ON', dates: '2024 – 2025', bullets: ['did a thing'] },
});
const project = (name: string, index: number): DroppedEntry => ({
  section: 'projects',
  index,
  name,
  entry: { name, tech: 'TypeScript', dates: '2025', bullets: ['built a thing'] },
});

const DROPPED: DroppedEntry[] = [job('Droady', 0), job('Aegon', 2), job('WesternBell', 3), project('Rate Limit Lab', 5)];

const read = (words: string, dropped = DROPPED, answer = '') => readRestore(words, dropped, answer);
const got = (words: string, dropped = DROPPED, answer = '') => {
  const r = read(words, dropped, answer);
  assert.ok(r && 'restore' in r, `expected a restore from ${JSON.stringify(words)}`);
  return r.restore.entries.map((e) => e.name);
};

// ── the sentence that started it ───────────────────────────────────────────

test('asking for one by name', () => {
  assert.deepEqual(got('add Droady back'), ['Droady']);
  assert.deepEqual(got('put my Aegon job back'), ['Aegon']);
  assert.deepEqual(got('bring back WesternBell'), ['WesternBell']);
  assert.deepEqual(got('restore the Rate Limit Lab project'), ['Rate Limit Lab']);
});

test('asking for a whole kind', () => {
  assert.deepEqual(got('bring my jobs back'), ['Droady', 'Aegon', 'WesternBell']);
  assert.deepEqual(got('put the projects back'), ['Rate Limit Lab']);
  assert.deepEqual(got('i want all my experiences back'), ['Droady', 'Aegon', 'WesternBell']);
});

test('asking for everything', () => {
  assert.deepEqual(got('put them all back'), ['Droady', 'Aegon', 'WesternBell', 'Rate Limit Lab']);
  assert.deepEqual(got('bring back everything you removed'), ['Droady', 'Aegon', 'WesternBell', 'Rate Limit Lab']);
});

test('a name beats a kind in the same sentence', () => {
  // "job" is in here too, and it must not turn this into all three.
  assert.deepEqual(got('add the Droady job back'), ['Droady']);
});

test('they come back in the order they sat on the page', () => {
  assert.deepEqual(got('bring back WesternBell and Droady'), ['Droady', 'WesternBell']);
});

// ── asking rather than guessing ────────────────────────────────────────────

test('"put it back" with several to choose from asks which', () => {
  const r = read('put it back');
  assert.ok(r && 'ask' in r);
  assert.match(r.ask, /Which one/);
  assert.match(r.ask, /Droady/);
});

test('"put it back" with one thing missing needs no question', () => {
  assert.deepEqual(got('put it back', [job('Droady', 0)]), ['Droady']);
});

test('the answer to that question names it', () => {
  assert.deepEqual(got('put it back', DROPPED, 'Aegon'), ['Aegon']);
  assert.deepEqual(got('put it back', DROPPED, 'all of them').length, 4);
});

// ── what must NEVER read as a restore ──────────────────────────────────────

test('ordinary edits are left alone', () => {
  assert.equal(read('shorten the Droady bullets'), null);
  assert.equal(read('remove the Aegon job'), null);
  assert.equal(read('move the summary below education'), null);
  assert.equal(read('add that I used C# at Droady'), null);
  assert.equal(read('make it simpler'), null);
});

test('a sentence about going back is not a restore', () => {
  // "back" alone is not enough; something has to be being asked for.
  assert.equal(read('the dates should go back to 2024'), null);
});

test('nothing was dropped, so nothing can come back', () => {
  assert.equal(read('put Droady back', []), null);
});

test('a name that was never dropped does not match', () => {
  assert.equal(read('bring back Kudi Kitchen'), null);
});

// ── skipping the model ─────────────────────────────────────────────────────

test('a sentence that is only a restore needs no model', () => {
  const r = read('please add Droady back');
  assert.ok(r && 'restore' in r);
  assert.equal(r.restore.only, true);
});

test('a sentence carrying anything else still goes to the model', () => {
  const r = read('add Droady back and shorten the MealApp bullets');
  assert.ok(r && 'restore' in r);
  assert.equal(r.restore.only, false);
});

// ── putting them back ──────────────────────────────────────────────────────

const RESUME = {
  experience: [{ org: 'Kudi Kitchen', bullets: ['ran it'] }],
  projects: [{ name: 'MealApp', bullets: ['built it'] }],
};

test('an entry goes back where it was', () => {
  const out = withRestored(RESUME, [job('Droady', 0)]);
  assert.deepEqual(out.experience.map((e: any) => e.org), ['Droady', 'Kudi Kitchen']);
});

test('several go back without shifting each other out of place', () => {
  const out = withRestored(RESUME, [job('Droady', 0), job('WesternBell', 2)]);
  assert.deepEqual(out.experience.map((e: any) => e.org), ['Droady', 'Kudi Kitchen', 'WesternBell']);
});

test('a position past the end is appended, not refused', () => {
  // The page has changed since it was taken off. A job at the bottom is worth
  // more than a job nowhere.
  const out = withRestored(RESUME, [job('Aegon', 9)]);
  assert.deepEqual(out.experience.map((e: any) => e.org), ['Kudi Kitchen', 'Aegon']);
});

test('the other section is untouched', () => {
  const out = withRestored(RESUME, [job('Droady', 0)]);
  assert.deepEqual(out.projects, RESUME.projects);
});

test('the entry comes back exactly as it was kept', () => {
  const dropped = job('Droady', 0);
  const out = withRestored(RESUME, [dropped]);
  assert.equal(out.experience[0], dropped.entry, 'the same object, not a rewritten copy');
});

// ── how it reads ───────────────────────────────────────────────────────────

test('the change log says what came back', () => {
  assert.equal(
    restoreLine([job('Droady', 0)]),
    'Put Droady back, as it was before the page limit took it off.',
  );
  assert.equal(
    restoreLine([job('Droady', 0), job('Aegon', 2)]),
    'Put Droady and Aegon back, as they were before the page limit took them off.',
  );
});
