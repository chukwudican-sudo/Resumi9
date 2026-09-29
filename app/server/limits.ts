import { getUsageWindow } from './db/repository';

/**
 * What stops one bad morning costing four figures.
 *
 * Three separate guards, because they fail for three different reasons:
 *
 *   - the **global ceiling** is the backstop. It does not care who is spending
 *     or why; it exists so that any bug, loop or script has a bounded blast
 *     radius. This is the one that matters at 3am.
 *   - the **per-user daily budget** stops one account from consuming the whole
 *     global ceiling and denying everybody else.
 *   - the **per-minute burst limit** catches a runaway client — a retry loop, a
 *     stuck effect — before it eats a day's budget in a minute.
 *
 * These are cost guards, not a security boundary. The check reads and the write
 * happens after the call returns, so a burst of genuinely simultaneous requests
 * can overshoot slightly before the count catches up. That is an acceptable
 * error for a spend limit and would not be for an authorization check.
 *
 * A ceiling in the application is the second line of defence. The first is a
 * monthly spend limit set on the Anthropic API key itself, which holds even if
 * this code is wrong.
 */

/**
 * Total across all users, rolling 24h. Override with RESUMI_DAILY_USD_CEILING.
 *
 * A hundred, raised from twenty-five, and it is worth being clear about what
 * it is for. It is not a budget. A full application — the posting, the tailor,
 * a couple of edits — costs about thirteen cents, and every account in the
 * app's first twenty-five days spent $5.30 between them, about twenty cents a
 * day. This is the number a runaway loop or a scripted account cannot get past
 * before somebody notices, and at a hundred a bad day costs a bad day.
 *
 * It is also the figure to revisit first if the app ever gets busy: the free
 * allowance below is generous on purpose, and ten accounts all emptying theirs
 * would reach this in an afternoon.
 */
const GLOBAL_DAILY_USD = Number(process.env.RESUMI_DAILY_USD_CEILING ?? 100);

/**
 * One account's share, rolling 24h. Override with RESUMI_USER_DAILY_USD.
 *
 * Ten dollars is roughly seventy-five applications, well past the fifty a day
 * the credits allow and far past what a person does — so it should only ever
 * be reached by something that is not a person. Two dollars, which is what it
 * was, sat BELOW the free allowance and would have refused somebody at their
 * fifteenth honest application with a message about capacity.
 */
const USER_DAILY_USD = Number(process.env.RESUMI_USER_DAILY_USD ?? 10);

/**
 * Calls per user per minute.
 *
 * An interview turn is one answer typed by a person, so 20 is far above human
 * pace and only trips on a loop. Generations are heavier and slower, so a lower
 * number is still invisible to anyone working normally.
 */
const BURST_PER_MINUTE: Record<string, number> = {
  interview_turn: 20,
  // Polish runs on edit rather than on demand, so a person editing quickly is
  // normal traffic, not abuse.
  polish: 20,
  proofread: 20,
  default: 8,
};

export class CapacityError extends Error {
  constructor(
    message: string,
    /** What the caller should tell the user. Never leaks budget figures. */
    readonly userMessage: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'CapacityError';
  }
}

export interface UsageWindow {
  spentLast24hUsd: number;
  userCallsLastMinute: number;
  userSpentLast24hUsd: number;
}

export interface Budget {
  globalDailyUsd: number;
  userDailyUsd: number;
  burstPerMinute: number;
}

/** What the limits are for one kind of call. */
export function budgetFor(kind: string): Budget {
  return {
    globalDailyUsd: GLOBAL_DAILY_USD,
    userDailyUsd: USER_DAILY_USD,
    burstPerMinute: BURST_PER_MINUTE[kind] ?? BURST_PER_MINUTE.default,
  };
}

/**
 * The decision, with no IO in it.
 *
 * Split from the query so the thresholds can be tested without a database.
 * Returns null to allow the call. Order matters: the global ceiling is checked
 * first, because when it has been reached the reason a given user is refused
 * has nothing to do with that user.
 */
export function checkLimits(usage: UsageWindow, budget: Budget): CapacityError | null {
  if (usage.spentLast24hUsd >= budget.globalDailyUsd) {
    return new CapacityError(
      `Global 24h spend ceiling reached: $${usage.spentLast24hUsd.toFixed(2)} of $${budget.globalDailyUsd}.`,
      'Resumi9 is at capacity right now. This is on us, not you — please try again later.',
      true,
    );
  }

  if (usage.userSpentLast24hUsd >= budget.userDailyUsd) {
    return new CapacityError(
      `Daily budget reached: $${usage.userSpentLast24hUsd.toFixed(2)} of $${budget.userDailyUsd}.`,
      "You've hit today's limit. It resets on a rolling 24-hour basis, so this frees up shortly.",
      true,
    );
  }

  if (usage.userCallsLastMinute >= budget.burstPerMinute) {
    return new CapacityError(
      `Burst limit reached: ${usage.userCallsLastMinute} calls in the last minute, limit ${budget.burstPerMinute}.`,
      'That was a lot at once. Give it a minute and try again.',
      true,
    );
  }

  return null;
}

/**
 * Throws if this call should not be made.
 *
 * Deliberately called from inside `callClaude` rather than from each route, so
 * that a handler added later is metered and capped without anyone remembering
 * to do it.
 */
export async function assertWithinLimits(userId: string, kind: string): Promise<void> {
  const refusal = checkLimits(await getUsageWindow(userId), budgetFor(kind));
  if (!refusal) return;
  // The figures go to the server log; the person is told only what they can act
  // on, which never includes what the budget is.
  console.error(`[Resumi9] Refused ${kind} for ${userId}: ${refusal.message}`);
  throw refusal;
}
