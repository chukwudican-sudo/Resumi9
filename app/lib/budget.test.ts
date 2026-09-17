import assert from 'node:assert/strict';
import test from 'node:test';
import { COMPILE_ESTIMATE_MS, SAVE_RESERVE_MS, affords } from './budget';

// A fixed instant, so these say something about the arithmetic rather than
// about how long the test took to run.
const NOW = 1_700_000_000_000;

test('a step runs when it fits with the save still safe', () => {
  const deadline = NOW + COMPILE_ESTIMATE_MS + SAVE_RESERVE_MS + 1;
  assert.equal(affords(deadline, COMPILE_ESTIMATE_MS, NOW), true);
});

test('exactly enough is enough', () => {
  const deadline = NOW + COMPILE_ESTIMATE_MS + SAVE_RESERVE_MS;
  assert.equal(affords(deadline, COMPILE_ESTIMATE_MS, NOW), true);
});

test('a step that would eat the save reserve is refused', () => {
  // Room for the compile and not for the row it exists to write. This is the
  // case that killed the function outside any catch: no refund, no message.
  const deadline = NOW + COMPILE_ESTIMATE_MS + SAVE_RESERVE_MS - 1;
  assert.equal(affords(deadline, COMPILE_ESTIMATE_MS, NOW), false);
});

test('a deadline already gone is refused rather than going negative', () => {
  assert.equal(affords(NOW - 10_000, COMPILE_ESTIMATE_MS, NOW), false);
});

test('a free step still has to leave the save its reserve', () => {
  assert.equal(affords(NOW + SAVE_RESERVE_MS, 0, NOW), true);
  assert.equal(affords(NOW + SAVE_RESERVE_MS - 1, 0, NOW), false);
});
