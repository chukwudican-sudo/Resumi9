/**
 * Whether there is still time to do one more optional thing.
 *
 * Everything after the model call is optional in the same way: measuring the
 * resume, cutting it to length, measuring it again. None of them are worth
 * losing the resume over — the person has already waited half a minute and
 * already paid a credit — so each one asks first, and a "no" means the resume
 * saves without it rather than the request dying.
 *
 * The reserve is the whole point. Asking "is there time for a compile" and then
 * spending every remaining millisecond on it leaves nothing to write the row
 * with, and the platform kills the function outside any catch: no refund, no
 * message, no resume. So a step only runs when it fits AND the save still fits
 * after it.
 */

/**
 * Time kept back for `saveResume` and the response.
 *
 * One insert and a JSON reply over the transaction pooler. Three seconds is
 * generous for that on purpose: this is the number that decides whether a
 * finished resume reaches the database at all.
 */
export const SAVE_RESERVE_MS = 3_000;

/**
 * What one compile costs, near enough to budget against.
 *
 * Measured at 1.0-1.3s locally on the real profile. The deployed service adds a
 * network hop and a cold machine can be slower, so the figure budgeted is
 * roughly double what a warm local run takes — being early costs a measurement
 * nobody needed, being late costs the resume.
 */
export const COMPILE_ESTIMATE_MS = 3_000;

/**
 * Whether `costMs` of work fits before the deadline, with the save still safe.
 *
 * `now` is a parameter so the loop that calls this can be tested with a clock
 * that does not move.
 */
export function affords(deadline: number, costMs: number, now: number = Date.now()): boolean {
  return deadline - now >= costMs + SAVE_RESERVE_MS;
}
