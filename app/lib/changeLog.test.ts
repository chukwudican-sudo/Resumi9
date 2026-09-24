import test from 'node:test';
import assert from 'node:assert/strict';
import { asLines, mendSplitLines, storedLines } from './changeLog';

// ── asLines ────────────────────────────────────────────────────────────────
//
// The bug this exists for: the model answered a request for a list with one
// sentence, and spreading a string spreads its letters.

test('a bare sentence is one line, not its letters', () => {
  assert.deepEqual(asLines('Removed the Aegon job.'), ['Removed the Aegon job.']);
});

test('a proper list is left alone', () => {
  assert.deepEqual(asLines(['One.', 'Two.']), ['One.', 'Two.']);
});

test('nothing at all is an empty list', () => {
  assert.deepEqual(asLines(undefined), []);
  assert.deepEqual(asLines(null), []);
  assert.deepEqual(asLines([]), []);
  assert.deepEqual(asLines(''), []);
});

test('blank entries are dropped, not printed', () => {
  assert.deepEqual(asLines(['One.', '', '   ', 'Two.']), ['One.', 'Two.']);
});

test('a sentence written with line breaks becomes several lines', () => {
  assert.deepEqual(asLines('First.\nSecond.'), ['First.', 'Second.']);
});

test('a warning stored as an object gives up its text', () => {
  // `{ text, retry }` shipped for one afternoon and those rows still exist.
  assert.deepEqual(asLines([{ text: 'Aegon was put back.', retry: 'remove it' }]), ['Aegon was put back.']);
});

test('an object with nothing to say is dropped rather than printed', () => {
  assert.deepEqual(asLines([{ retry: 'x' }, 'Real line.']), ['Real line.']);
});

test('a number is printed rather than spread', () => {
  assert.deepEqual(asLines(2), ['2']);
});

// ── mendSplitLines ─────────────────────────────────────────────────────────
//
// For the four versions already saved one letter per row.

test('a spread sentence is put back together', () => {
  const spread = [...'Removed the Aegon job.'];
  assert.deepEqual(mendSplitLines(['You asked: "x"', ...spread]), ['You asked: "x"', 'Removed the Aegon job.']);
});

test('the spaces come back in the right places', () => {
  assert.deepEqual(mendSplitLines([...'one two three']), ['one two three']);
});

test('real log lines are never joined', () => {
  const real = ['You asked: "remove the Aegon job"', 'Aegon: removed, as you asked.'];
  assert.deepEqual(mendSplitLines(real), real);
});

test('a short run of initials is left alone', () => {
  // Three is not enough to be sure, and a wrong join corrupts a real line.
  assert.deepEqual(mendSplitLines(['A', 'B', 'C']), ['A', 'B', 'C']);
});

test('two spread sentences either side of a real one', () => {
  const lines = ['Kept.', ...'first one', 'Middle.', ...'second one'];
  assert.deepEqual(mendSplitLines(lines), ['Kept.', 'first one', 'Middle.', 'second one']);
});

test('an empty list stays empty', () => {
  assert.deepEqual(mendSplitLines([]), []);
});

// ── storedLines ────────────────────────────────────────────────────────────
//
// Reading back a log exactly as four saved versions hold it.

test('a real saved log comes back as sentences, spaces and all', () => {
  const stored = ['You asked: "remove the Aegon job"', ...'Removed the Aegon job as requested.'];
  assert.deepEqual(storedLines(stored), [
    'You asked: "remove the Aegon job"',
    'Removed the Aegon job as requested.',
  ]);
});

test('the words do not run together', () => {
  // Dropping blank rows before mending deletes the spaces themselves, which is
  // how this first came back as "RemovedtheAegonjob".
  assert.equal(storedLines([...'one two three'])[0], 'one two three');
});

test('an undamaged log is unchanged', () => {
  const fine = ['You asked: "x"', 'Aegon: removed, as you asked.'];
  assert.deepEqual(storedLines(fine), fine);
});

test('a log that was never a list at all', () => {
  assert.deepEqual(storedLines('One sentence.'), ['One sentence.']);
  assert.deepEqual(storedLines(null), []);
});
