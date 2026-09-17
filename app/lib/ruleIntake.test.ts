import assert from 'node:assert/strict';
import test from 'node:test';
import { toCheck, type ToolResult } from './ruleIntake';

/**
 * The model's flat answer, narrowed to a check.
 *
 * Only the narrowing is tested here — the model call itself is not, and cannot
 * usefully be. What matters is that a sensible reading becomes a check, and
 * that a reading which would misfire on every resume becomes nothing.
 */
const reading = (over: Partial<ToolResult>): ToolResult => ({
  checkKind: 'none',
  terms: [],
  limit: 0,
  conflictsWith: 0,
  conflictReason: '',
  ...over,
});

test('"keep it to one page" becomes a one-page limit', () => {
  // The rule that switches on cutting. It used to have nowhere to go, and was
  // saved as guidance that nothing ever acted on.
  assert.deepEqual(toCheck(reading({ checkKind: 'max_pages', limit: 1 })), { kind: 'max_pages', limit: 1 });
});

test('a two-page limit is read as two', () => {
  assert.deepEqual(toCheck(reading({ checkKind: 'max_pages', limit: 2 })), { kind: 'max_pages', limit: 2 });
});

test('a page limit of zero is refused rather than failing every resume', () => {
  assert.equal(toCheck(reading({ checkKind: 'max_pages', limit: 0 })), null);
});

test('a page limit in the dozens is a misreading, not a rule', () => {
  // A bullet length of 110 characters, filed under the wrong kind, would
  // otherwise become a limit nobody could ever break.
  assert.equal(toCheck(reading({ checkKind: 'max_pages', limit: 110 })), null);
});

test('a fractional page limit is rounded to whole pages', () => {
  assert.deepEqual(toCheck(reading({ checkKind: 'max_pages', limit: 1.4 })), { kind: 'max_pages', limit: 1 });
});

test('the kinds that already existed read exactly as before', () => {
  assert.deepEqual(toCheck(reading({ checkKind: 'forbidden_text', terms: [' UOIT '] })), {
    kind: 'forbidden_text',
    terms: ['UOIT'],
  });
  assert.deepEqual(toCheck(reading({ checkKind: 'max_bullet_chars', limit: 110 })), {
    kind: 'max_bullet_chars',
    limit: 110,
  });
  assert.equal(toCheck(reading({ checkKind: 'max_bullet_chars', limit: 12 })), null);
  assert.equal(toCheck(reading({ checkKind: 'none' })), null);
});
