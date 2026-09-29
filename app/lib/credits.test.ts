import assert from 'node:assert';
import test from 'node:test';
import { creditsLabel, DAILY_CREDITS, hoursUntil, isDue, nextReset } from './credits';

test('the reset lands on midnight tonight, UTC', () => {
  assert.equal(nextReset(new Date('2026-09-05T14:00:00Z')).toISOString(), '2026-09-06T00:00:00.000Z');
  assert.equal(nextReset(new Date('2026-09-05T00:00:00Z')).toISOString(), '2026-09-06T00:00:00.000Z');
  assert.equal(nextReset(new Date('2026-09-05T23:59:59Z')).toISOString(), '2026-09-06T00:00:00.000Z');
});

test('the last day of a month rolls into the next one', () => {
  assert.equal(nextReset(new Date('2026-09-30T09:00:00Z')).toISOString(), '2026-10-01T00:00:00.000Z');
  assert.equal(nextReset(new Date('2026-12-31T23:00:00Z')).toISOString(), '2027-01-01T00:00:00.000Z');
});

test('February is not special', () => {
  // Date.UTC does the arithmetic; this is here because the month-based version
  // it replaced had to think about it and this one must not start to.
  assert.equal(nextReset(new Date('2028-02-28T10:00:00Z')).toISOString(), '2028-02-29T00:00:00.000Z');
  assert.equal(nextReset(new Date('2026-02-28T10:00:00Z')).toISOString(), '2026-03-01T00:00:00.000Z');
});

test('a day is due once its moment has passed', () => {
  const now = new Date('2026-09-05T12:00:00Z');
  assert.equal(isDue(new Date('2026-09-06T00:00:00Z'), now), false, 'still today');
  assert.equal(isDue(new Date('2026-09-05T00:00:00Z'), now), true, 'yesterday');
  assert.equal(isDue(new Date('2026-09-05T12:00:00Z'), now), true, 'exactly now counts');
});

test('an account that predates any of this starts a fresh day', () => {
  // Everyone signed up before resets existed has no date on their row. Reading
  // that as "not due" would leave them stuck on whatever they had left, which
  // is the bug this whole thing exists to fix.
  assert.equal(isDue(null), true);
  assert.equal(isDue(undefined), true);
});

test('the wait is given in hours, because the reset is nobody’s midnight', () => {
  const now = new Date('2026-09-05T14:00:00Z');
  assert.equal(hoursUntil(new Date('2026-09-06T00:00:00Z'), now), 10);
  // Rounded up: "in 0 hours" is not a thing to tell somebody who has to wait.
  assert.equal(hoursUntil(new Date('2026-09-05T14:01:00Z'), now), 1);
  assert.equal(hoursUntil(new Date('2026-09-05T13:00:00Z'), now), 1, 'never negative, never zero');
});

test('the count reads plainly at every number', () => {
  assert.equal(creditsLabel(DAILY_CREDITS), '50 of 50 free left');
  assert.equal(creditsLabel(2), '2 of 50 free left');
  assert.equal(creditsLabel(1), '1 application left');
  assert.equal(creditsLabel(0), 'No applications left');
  assert.equal(creditsLabel(-1), 'No applications left', 'never reads as a negative');
});

test('a reset date from the monthly scheme is due immediately', () => {
  /*
   * Everybody's row still says the first of next month. Read literally that is
   * "not due", and the new daily allowance would reach them days later — the
   * person who asked for this was on zero with a date in October.
   *
   * Anything further out than a day cannot have been written by the daily
   * scheme, so it is treated as spent. The row corrects itself on the next
   * read, which beats remembering to run a migration.
   */
  const now = new Date('2026-09-28T18:00:00Z');
  assert.equal(isDue(new Date('2026-10-01T00:00:00Z'), now), true, 'a monthly date is stale');
  assert.equal(isDue(new Date('2026-09-29T00:00:00Z'), now), false, 'tonight is not');
  assert.equal(isDue(new Date('2026-09-29T17:00:00Z'), now), false, 'just under a day out is not');
});
