/**
 * How many applications are free, and when that number comes back.
 *
 * Credits were spent and never restored: creditsResetAt existed in the schema
 * and nothing read or wrote it, so after five applications an account was
 * permanently stuck — while the error it was shown promised a monthly reset
 * that did not exist.
 */

/**
 * Free applications a day.
 *
 * Ten a month, which is what this was, is a worse offer than the free thing
 * it competes with. The question people actually ask is why they should use
 * this instead of ChatGPT, and "ten a month" is not an answer — somebody
 * job-hunting properly gets through ten in a slow week.
 *
 * Fifty is past what anyone does. Applying hard is twenty or thirty in a day,
 * so the number is high enough to say there is no practical limit and mean it,
 * while still being a limit — a runaway costs one day rather than a month.
 *
 * Measured against real spend rather than guessed: a full application, counting
 * the posting, the tailor and a couple of edits, costs about thirteen cents.
 * Fifty is roughly $6.50 for somebody who empties it, against total spend of
 * $5.30 across every account in the app's first twenty-five days. The ceilings
 * in server/limits.ts are what stand behind this if that ever stops being true.
 */
export const DAILY_CREDITS = 50;

/**
 * Midnight tonight, UTC.
 *
 * UTC rather than the person's own midnight, because nothing stores their
 * timezone and a reset that depends on where they are is a reset nobody can
 * predict from the server. What it costs is that the moment lands mid-evening
 * in the Americas — so the count is never described as coming back "tomorrow",
 * which would be wrong for half the world. `hoursUntil` gives the honest
 * version instead.
 */
export function nextReset(from: Date = new Date()): Date {
  return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + 1, 0, 0, 0, 0));
}

/** A day, in milliseconds. Nothing legitimate sits further out than this. */
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** Whether this account's day has rolled over. */
export function isDue(resetAt: Date | null | undefined, now: Date = new Date()): boolean {
  // Never set means an account from before any of this existed. Treated as due,
  // so it starts its first day rather than sitting on whatever it had left.
  if (!resetAt) return true;
  if (resetAt.getTime() <= now.getTime()) return true;

  /*
   * A date further out than a day was written by the monthly scheme.
   *
   * Everybody carrying one would otherwise sit on their old allowance until
   * the first of the month — the person who prompted this change is on zero
   * with a date in October, so the new number would have reached him in four
   * days. Self-healing rather than a migration: the row is rewritten the next
   * time anybody touches it, and an app that fixes its own old rows does not
   * need somebody to remember to run something.
   */
  return resetAt.getTime() - now.getTime() > ONE_DAY_MS;
}

/**
 * How long until the count comes back, in whole hours.
 *
 * Said this way because it is true wherever somebody is reading it. A date is
 * only meaningful once you know which midnight, and the answer to that is the
 * server's, not theirs.
 */
export function hoursUntil(resetAt: Date, now: Date = new Date()): number {
  return Math.max(1, Math.ceil((resetAt.getTime() - now.getTime()) / 3_600_000));
}

/** How the remaining count reads. */
export function creditsLabel(credits: number): string {
  if (credits <= 0) return 'No applications left';
  if (credits === 1) return '1 application left';
  return `${credits} of ${DAILY_CREDITS} free left`;
}
