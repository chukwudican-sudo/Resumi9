import Anthropic from '@anthropic-ai/sdk';
import { recordUsage } from '../server/db/repository';
import { assertWithinLimits } from '../server/limits';
import { estimateCostUsd } from './pricing';
import { recoverToolInput } from './toolInput';
import type { TokenUsage } from './types';

/**
 * The single point through which every Anthropic call in the app passes.
 *
 * The reason this exists is not abstraction for its own sake — it is so that
 * quota enforcement, usage accounting, and the daily spend ceiling have exactly
 * one place to live. A future handler that forgets to meter itself is not
 * possible if the only way to reach Claude is through here.
 *
 * See docs/adr/0004-single-anthropic-choke-point.md.
 */

/** Effort levels the app uses, mapped per call kind below. */
export type Effort = 'low' | 'medium' | 'high';

/**
 * What kind of work a call represents. Recorded against every call so per-kind
 * cost can be reported, and so quotas can price an interview differently from a
 * generation.
 */
export type UsageKind =
  | 'extract'
  | 'extract_resume'
  | 'tailor'
  | 'instruct'
  | 'interview_turn'
  | 'compose'
  | 'polish'
  | 'proofread'
  | 'rule';

/**
 * The model every call in the app uses.
 *
 * Sonnet 5, and the move off Sonnet 4.6 was made for speed, measured on this
 * app's own tailor call with the same profile and posting: 46.8s at 52 output
 * tokens/sec on 4.6, 27.8s at 116 on 5, for the same tailored resume and the
 * same match score. Latency here is output tokens divided by tokens per second
 * — nothing else moves it — so the generation rate IS the wait.
 *
 * It is also slightly cheaper per resume despite counting ~36% more tokens for
 * the same text; see the tokenizer note in lib/pricing.ts, which is where the
 * arithmetic lives.
 */
const MODEL = 'claude-sonnet-5';

/**
 * What one whole REQUEST gets, shared across every call it makes.
 *
 * It lives here, beside the per-attempt timeouts, because keeping the two
 * numbers apart is what caused the bug this constant now prevents: the tailor
 * route budgeted 52s while this file gave the tailor a 45s per-attempt timeout,
 * so the shorter leash always won and the budget was dead code. The call took
 * 44-50s. It timed out on the median, and the error said "took longer than we
 * allow", which is how it read as a budget stop for a whole day.
 *
 * Sits a few seconds under `maxDuration = 60` so the budget runs out before the
 * platform kills the function — a kill happens outside any catch, so no refund
 * and no message.
 */
export const REQUEST_BUDGET_MS = 52_000;

/**
 * Per-kind model + budget. Keeps model choice out of the handlers.
 *
 * **maxTokens is not comparable to the numbers that were here before.** Sonnet
 * 5's tokenizer counts about 36% more tokens for identical text, so every
 * budget is ~1.4x its old value to buy the same amount of writing. Left alone,
 * the small ones would have started truncating tool calls mid-JSON — a broken
 * result rather than a slow one. Raising them costs nothing: max_tokens is not
 * counted against the output-tokens-per-minute rate limit, only tokens actually
 * generated are.
 *
 * **timeoutMs bounds ONE ATTEMPT, never the request.** Any kind whose route
 * passes a `deadline` must keep this at or above REQUEST_BUDGET_MS, or it
 * preempts the deadline and the budget stops meaning anything. Enforced by a
 * test in anthropic.test.ts rather than by memory.
 */
export const CALL_CONFIG: Record<
  UsageKind,
  { model: string; maxTokens: number; effort: Effort; timeoutMs: number; retries: number }
> = {
  extract: { model: MODEL, maxTokens: 5600, effort: 'low', timeoutMs: 40000, retries: 0 },
  extract_resume: { model: MODEL, maxTokens: 5600, effort: 'low', timeoutMs: 40000, retries: 0 },
  tailor: { model: MODEL, maxTokens: 11200, effort: 'medium', timeoutMs: 55000, retries: 0 },
  instruct: { model: MODEL, maxTokens: 11200, effort: 'medium', timeoutMs: 55000, retries: 0 },
  interview_turn: { model: MODEL, maxTokens: 2800, effort: 'low', timeoutMs: 25000, retries: 1 },
  compose: { model: MODEL, maxTokens: 11200, effort: 'medium', timeoutMs: 55000, retries: 0 },
  // Short input, short output, and it runs whenever a resume changes — so it is
  // budgeted as the cheap frequent call it is, not as a generation.
  polish: { model: MODEL, maxTokens: 2800, effort: 'low', timeoutMs: 25000, retries: 1 },
  // The smallest call in the app: one 280-character rule in, a handful of
  // fields out. It runs once when a rule is written and never again, which is
  // the whole economics of checking rules — pay once to learn what one means,
  // then verify it for nothing on every resume after.
  rule: { model: MODEL, maxTokens: 1200, effort: 'low', timeoutMs: 15000, retries: 1 },
  // Reads the whole resume and returns a short list, so the budget is for
  // input rather than output.
  proofread: { model: MODEL, maxTokens: 2100, effort: 'low', timeoutMs: 25000, retries: 1 },
};

/** Kinds whose route hands `callClaude` a deadline. See the timeoutMs note. */
export const DEADLINE_GOVERNED: UsageKind[] = ['tailor'];

export const HEALTH_CHECK_MODEL = CALL_CONFIG.tailor.model;

export interface CallClaudeOptions {
  /**
   * Who this call is for. Required, and required for a reason: it is what makes
   * metering unforgettable. A new handler cannot reach Claude without naming an
   * owner, so it cannot spend money anonymously.
   */
  userId: string;
  kind: UsageKind;
  system: string;
  content: unknown[];
  tool: Anthropic.Tool;
  /** Overrides the per-kind default. Rarely needed. */
  maxTokens?: number;
  effort?: Effort;
  /** Ties the spend to an interview, for per-session cost reporting. */
  sessionId?: string | null;
  /**
   * Per-user prompt text, sent after the cached block.
   *
   * Anything that differs between people belongs here rather than in `system`.
   * The cache key is a prefix match, so a name or a personal rule inside the
   * shared block would give every user their own copy of the whole prompt and
   * the hit rate would collapse to what one person can reuse alone.
   */
  systemSuffix?: string;
  /**
   * When this whole request has to be finished, as a wall-clock instant.
   *
   * The SDK's `timeout` bounds ONE ATTEMPT, not the call — its own note says so:
   * "request timeouts are retried by default, so in a worst-case scenario you
   * may wait much longer than this timeout". A route that must fit inside
   * `maxDuration` needs the other thing: a budget for everything it does,
   * shared across however many calls it makes.
   *
   * Passed down as an AbortSignal, which the SDK checks between attempts and
   * hands to fetch, so it stops a request mid-flight and during a retry sleep.
   * It surfaces as APIUserAbortError — distinguishable from a timeout, so the
   * two can say different things to the person waiting.
   */
  deadline?: number;
}

export interface CallClaudeResult<T> {
  toolInput: T;
  usage: TokenUsage;
}

/** Thrown when Claude returns no tool_use block despite a forced tool_choice. */
export class NoToolUseError extends Error {
  constructor() {
    super('Model returned no tool_use block despite a forced tool_choice.');
    this.name = 'NoToolUseError';
  }
}

/** Thrown when the answer ran out of room part way through. */
export class TruncatedError extends Error {
  constructor() {
    super('Model hit max_tokens before finishing its tool call.');
    this.name = 'TruncatedError';
  }
}

/**
 * The tool call out of a response, or a clear failure.
 *
 * Pulled out of `callClaude` so it can be tested, and because it was silently
 * trusting two things. A response that stopped at `max_tokens` still carries a
 * `tool_use` block — a half-written one — and the old code handed it on as a
 * resume. And a `structure` field is not guaranteed to be an object: the model
 * can return the whole thing as a JSON string, which reads as an empty resume
 * to everything downstream. One tailor did exactly that, the guard restored
 * every entry from the profile, and it was saved as a success.
 */
export function readToolUse(response: any): Anthropic.ToolUseBlock {
  if (response?.stop_reason === 'max_tokens') throw new TruncatedError();
  const block = response?.content?.find((b: any) => b?.type === 'tool_use');
  if (!block) throw new NoToolUseError();
  return block as Anthropic.ToolUseBlock;
}

/**
 * Makes one forced-tool-use call and returns the tool input plus usage.
 *
 * Every mode in the app is single-turn and forces exactly one tool, so that
 * shape is baked in here rather than re-expressed at each call site.
 */
export async function callClaude<T>(opts: CallClaudeOptions): Promise<CallClaudeResult<T>> {
  const config = CALL_CONFIG[opts.kind];
  const model = config.model;

  // Before spending anything, not after.
  await assertWithinLimits(opts.userId, opts.kind);

  /**
   * Two clocks, doing different jobs, and the order between them matters.
   *
   * Bare, this takes the SDK defaults: a **ten-minute** timeout and two
   * automatic retries, inside routes declaring `maxDuration = 60`. A single 529
   * became three sequential attempts and the platform killed the function part
   * way through — the person got a platform error page rather than this app's
   * own capacity message.
   *
   * `timeout` bounds ONE ATTEMPT. The SDK says so itself, and its source
   * confirms it: the timer is armed around the `fetch` call and cleared when
   * fetch resolves, which is at response HEADERS. For these non-streaming calls
   * headers arrive with the body so that distinction is moot — but it stops
   * being moot the moment anything here streams, and only the deadline below
   * would still be guarding the body.
   *
   * `retries` is 0 for the heavy calls: the SDK retries a timeout
   * UNCONDITIONALLY — harder than a 429, which at least goes through
   * shouldRetry — and retrying a call that was too slow buys another call that
   * is too slow, for twice the wait.
   *
   * The deadline is the one that bounds the REQUEST, so a per-attempt timeout
   * below REQUEST_BUDGET_MS silently takes the deadline's job. See the note on
   * CALL_CONFIG; a test holds the invariant.
   */
  const client = new Anthropic({ timeout: config.timeoutMs, maxRetries: config.retries });

  // What is left of the request's budget, if the caller set one. Nothing here
  // may outlive it — that is the whole point of a deadline over a timeout.
  const remaining = opts.deadline ? opts.deadline - Date.now() : null;
  if (remaining !== null && remaining <= 0) throw new Anthropic.APIUserAbortError();
  const signal = remaining !== null ? AbortSignal.timeout(remaining) : undefined;

  // The system prompt is the stable part of every request, so it carries the
  // cache breakpoint. Anything volatile must stay in the user content or the
  // prefix changes each turn and nothing is ever reused. Below the model's
  // minimum cacheable length this is simply ignored, so it is safe to always
  // send. Watch usage.cacheReadTokens: a persistent zero across turns means
  // something volatile has leaked into the system prompt.
  const system = [
    { type: 'text' as const, text: opts.system, cache_control: { type: 'ephemeral' as const } },
    ...(opts.systemSuffix
      ? [{ type: 'text' as const, text: opts.systemSuffix }]
      : []),
  ];

  // `output_config` is not in the SDK's published request type yet, hence the
  // cast. Confined to this one place instead of every call site.
  const response: any = await client.messages.create({
    model,
    max_tokens: opts.maxTokens ?? config.maxTokens,
    output_config: { effort: opts.effort ?? config.effort },
    system,
    tools: [opts.tool],
    tool_choice: { type: 'tool', name: opts.tool.name },
    messages: [{ role: 'user', content: opts.content }],
  } as any, signal ? { signal } : undefined);

  const toolUse = readToolUse(response);

  /*
   * Here, and not in any one route, because every call in the app has the same
   * exposure. The answer that failed five tailors in a row arrived with all six
   * of its fields jammed into the first one; an edit, a polish or a posting read
   * can do exactly the same, and each would fail in its own way downstream.
   * Logged, because a recovery nobody can count is a misbehaviour nobody sees.
   */
  const { input, repaired } = recoverToolInput(toolUse.input, opts.tool);
  if (repaired.length) {
    console.error(`[Resumi9] ${opts.kind}: answer arrived in the wrong shape; recovered ${repaired.join(', ')}.`);
  }

  const raw = response.usage ?? {};
  const inputTokens = raw.input_tokens ?? 0;
  const outputTokens = raw.output_tokens ?? 0;
  const cacheReadTokens = raw.cache_read_input_tokens ?? 0;
  const cacheWriteTokens = raw.cache_creation_input_tokens ?? 0;

  const usage: TokenUsage = {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    costUsd: estimateCostUsd(model, { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }),
  };

  // Recorded even though the caller may throw on what comes back: the tokens
  // were spent regardless, and a ceiling that only counts successful calls is
  // blind to exactly the failure loop it exists to stop.
  await recordUsage(opts.userId, {
    kind: opts.kind,
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    costUsd: usage.costUsd,
    sessionId: opts.sessionId ?? null,
  });

  return { toolInput: input as T, usage };
}
