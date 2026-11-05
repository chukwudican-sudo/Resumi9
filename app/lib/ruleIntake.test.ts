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
  names: [],
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

// ── always_include ─────────────────────────────────────────────────────────
//
// The one check that changes what the app DOES rather than how it grades the
// result. It replaced a regex over rule text run at tailor time: fragile on
// free prose, invisible, and it turned sentences meant as guidance into
// constraints. Read once here instead, and shown beside the rule.

test('a named entry becomes a check', () => {
  const check = toCheck(reading({ checkKind: 'always_include', names: ['Aegon'] }));
  assert.deepEqual(check, { kind: 'always_include', names: ['Aegon'] });
});

test('several named things, as the person wrote them', () => {
  const check = toCheck(reading({ checkKind: 'always_include', names: ['Aegon', 'Droady', 'Figma'] }));
  assert.deepEqual(check, { kind: 'always_include', names: ['Aegon', 'Droady', 'Figma'] });
});

test('checkable but naming nothing is nothing', () => {
  // The model saying "checkable" and then not saying what to check. Stored,
  // it would produce a rule that can never fail.
  assert.equal(toCheck(reading({ checkKind: 'always_include', names: [] })), null);
  assert.equal(toCheck(reading({ checkKind: 'always_include', names: ['  ', ''] })), null);
});

test('a name too short to identify anything, and a sentence instead of a name', () => {
  assert.equal(toCheck(reading({ checkKind: 'always_include', names: ['AI'] })), null);
  assert.equal(
    toCheck(reading({
      checkKind: 'always_include',
      names: ['the job I had at the bank before I went back to university full time'],
    })),
    null,
  );
});

test('a handful at most', () => {
  const many = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];
  const check = toCheck(reading({ checkKind: 'always_include', names: many }));
  assert.equal(check?.kind === 'always_include' && check.names.length, 6);
});
