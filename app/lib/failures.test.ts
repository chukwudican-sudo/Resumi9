import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { faultOf, sanitise } from './failures';

// ── nothing of the person's reaches the log ───────────────────────────────

test('a quoted bullet is scrubbed out of an error message', () => {
  /*
   * The whole reason `reason` is not just `err.message`. A validation error
   * quotes the bullet, and a bullet is the person's work history.
   */
  const err = new Error(
    'Invalid bullet: "Cut transient-failure recovery time from 30-45 seconds to 1-2 seconds by redesigning an offline-sync retry scheduler"',
  );
  const out = sanitise(err);
  assert.ok(!/recovery time|retry scheduler|offline-sync/.test(out), out);
  assert.match(out, /^Error: Invalid bullet: "…"$/);
});

test('a Postgres error does not carry its parameters', () => {
  const err = new Error('Failed query: insert into resumes (structure) values ($1)\nparams: {"experience":[{"org":"Aegon"}]}');
  const out = sanitise(err);
  assert.ok(!/Aegon|experience|structure/.test(out), out);
});

test('a LaTeX log does not carry the line it choked on', () => {
  const err = new Error('LaTeX failed l.412 \\item Supported procurement, inventory tracking and logistics for 200+ cylinders');
  const out = sanitise(err);
  assert.ok(!/procurement|inventory|cylinders/.test(out), out);
});

test('a JSON blob is never passed through', () => {
  const err = new Error('Unexpected shape {"bullets":["Led a team of 20+ advisors at conventions"]}');
  const out = sanitise(err);
  assert.ok(!/advisors|conventions|Led a team/.test(out), out);
});

test('a long message is capped even when no rule matched it', () => {
  /*
   * The backstop. A message that embeds somebody's text without quoting it
   * survives every rule above, so the length limit is what stops a
   * paragraph of their resume reaching the table.
   */
  const err = new Error('x'.repeat(5000));
  const out = sanitise(err);
  assert.ok(out.length <= 220, `${out.length} characters`);
  assert.match(out, /…$/);
});

test('a short, harmless message survives intact', () => {
  assert.equal(sanitise(new TypeError('Cannot read properties of undefined')), 'TypeError: Cannot read properties of undefined');
});

test('a non-Error is still named', () => {
  assert.equal(sanitise('something went wrong'), 'string: something went wrong');
  assert.equal(sanitise(null), 'object');
});

// ── whose problem it is ───────────────────────────────────────────────────

test('fault is read off the error, not guessed', () => {
  assert.equal(faultOf(Object.assign(new Error('x'), { name: 'APIConnectionTimeoutError' }), 'model'), 'upstream');
  assert.equal(faultOf(new Error('Compiler busy'), 'compile'), 'upstream');
  assert.equal(faultOf(new Error('No credits left'), 'limits'), 'user');
  assert.equal(faultOf(new Error('nothing matched'), 'guard_unusable'), 'model');
  // Anything unclassified is ours, because an error nobody has looked at is
  // exactly the one that should not be flattered to "upstream".
  assert.equal(faultOf(new Error('weird'), 'save'), 'app');
});

// ── the pairing rule ──────────────────────────────────────────────────────

/**
 * Every path that refunds a credit must also close its attempt row, and
 * every close that reports a refund must sit beside a real one.
 *
 * Read off the source rather than exercised, because the two calls live in
 * route handlers that need a signed-in request, a model and a compiler. What
 * can be checked cheaply is that they always appear together — which is the
 * property that actually decays, as somebody adds a seventh error exit and
 * remembers only one of the two.
 */
const tailorRoute = fs.readFileSync(
  new URL('../api/applications/[id]/tailor/route.ts', import.meta.url),
  'utf8',
);

/** The statements of a function body, flattened enough to look along. */
const lines = tailorRoute.split('\n');

test('every refund is followed by a logged failure', () => {
  const refunds = lines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => /await refundCredit\(/.test(line));

  assert.ok(refunds.length >= 3, `expected the known refund sites, found ${refunds.length}`);

  for (const { i } of refunds) {
    // The log goes within a few lines: a console.error and a comment may sit
    // between them, a return must not.
    const after = lines.slice(i + 1, i + 6).join('\n');
    assert.match(
      after,
      /await failed\(|await endAttempt\(/,
      `refundCredit at line ${i + 1} is not followed by a failure log:\n${after}`,
    );
    assert.ok(
      !/^\s*return /m.test(lines.slice(i + 1, i + 3).join('\n')),
      `refundCredit at line ${i + 1} returns before logging`,
    );
  }
});

test('every logged refund sits beside a real one', () => {
  // The other direction: a row claiming `refunded: true` where no credit
  // went back would make the table lie in the one column somebody checks
  // before answering a complaint about billing.
  const claimed = lines
    .map((line, i) => ({ line, i }))
    // Greedy to the line's end: the arguments contain their own brackets,
    // and `[^)]*` stopped at the first one inside `new Error(...)`.
    .filter(({ line }) => /await failed\(.*,\s*true\s*\);/.test(line));

  assert.ok(claimed.length >= 3, `expected refund-claiming logs, found ${claimed.length}`);

  for (const { i } of claimed) {
    const before = lines.slice(Math.max(0, i - 6), i).join('\n');
    assert.match(
      before,
      /await refundCredit\(/,
      `a failure log at line ${i + 1} claims a refund with none above it:\n${before}`,
    );
  }
});

test('the catch-all refunds and logs, in that order', () => {
  // The path every unclassified failure takes. If these two ever separate,
  // a whole class of failure stops being counted at once.
  const at = lines.findIndex((l) => /^\s*\} catch \(error\) \{/.test(l));
  assert.ok(at > 0, 'the tailor route has a catch-all');
  const body = lines.slice(at, at + 14).join('\n');
  assert.match(body, /await refundCredit\(userId\);/);
  assert.match(body, /await failed\(at, error, true\);/);
  assert.ok(
    body.indexOf('refundCredit') < body.indexOf('await failed('),
    'the refund happens before the row records it',
  );
});
