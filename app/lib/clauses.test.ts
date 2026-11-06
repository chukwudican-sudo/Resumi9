import test from 'node:test';
import assert from 'node:assert/strict';
import { clauses, clausesSaying } from './clauses';

test('the sentence that caused the bad pin', () => {
  assert.deepEqual(
    clauses('Remove the Kudi Kitchen entry from Technical Projects only. Keep the Kudi Kitchen job in Experience.'),
    ['Remove the Kudi Kitchen entry from Technical Projects only.', 'Keep the Kudi Kitchen job in Experience.'],
  );
});

test('"and" joining two requests splits', () => {
  assert.deepEqual(
    clauses('Drop the second Kudi Kitchen job bullet and use the space to show Western Bell International'),
    ['Drop the second Kudi Kitchen job bullet', 'use the space to show Western Bell International'],
  );
});

test('"and" joining a list does not', () => {
  // The split that would lose half an instruction.
  assert.deepEqual(clauses('keep Aegon and Droady'), ['keep Aegon and Droady']);
  assert.deepEqual(clauses('shorten the Aegon and WesternBell bullets'), ['shorten the Aegon and WesternBell bullets']);
});

test('semicolons and newlines separate', () => {
  assert.deepEqual(clauses('remove Kudi; keep Aegon'), ['remove Kudi', 'keep Aegon']);
  assert.deepEqual(clauses('remove Kudi\nkeep Aegon'), ['remove Kudi', 'keep Aegon']);
});

test('a plain instruction is one clause', () => {
  assert.deepEqual(clauses('shorten the Aegon bullets'), ['shorten the Aegon bullets']);
});

test('a decimal or an abbreviation does not end a sentence', () => {
  // "Ltd." is the one that matters: it is in a real employer name.
  assert.deepEqual(
    clauses('Add the WesternBell International Ltd. job'),
    ['Add the WesternBell International Ltd. job'],
    'a suffix full stop is followed by no space, so it is not a break',
  );
});

test('nothing in, nothing out', () => {
  assert.deepEqual(clauses(''), []);
  assert.deepEqual(clauses('   '), []);
});

test('clausesSaying narrows to the half that carries the verb', () => {
  const text = 'Remove the Kudi Kitchen entry from Technical Projects only. Keep the Kudi Kitchen job in Experience.';
  assert.deepEqual(clausesSaying(text, /\bkeep\b/i), ['Keep the Kudi Kitchen job in Experience.']);
  assert.deepEqual(clausesSaying(text, /\bremove\b/i), ['Remove the Kudi Kitchen entry from Technical Projects only.']);
});

test('clausesSaying falls back to everything when the verb is nowhere', () => {
  // So a reader that adopts this behaves exactly as it did before.
  assert.deepEqual(clausesSaying('shorten the Aegon bullets', /\bkeep\b/i), ['shorten the Aegon bullets']);
});
