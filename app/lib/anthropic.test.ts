import assert from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import {
  CALL_CONFIG,
  DEADLINE_GOVERNED,
  MAX_DURATION_S,
  NoToolUseError,
  REQUEST_BUDGET_MS,
  TruncatedError,
  pauseBefore,
  readToolUse,
  serviceIsBusy,
  type UsageKind,
} from './anthropic';
import { estimateCostUsd } from './pricing';

/**
 * These hold two invariants that were both broken in production, silently, and
 * cost a day to find. Neither is expressible in the type system, so they are
 * held here instead of in a comment nobody reads at the moment it matters.
 */

test('an answer that ran out of room is a failure, not a resume', () => {
  // A response that stops at max_tokens still carries a tool_use block — a half
  // written one. Handed on, it becomes a resume missing whatever came after the
  // cut, and the guard then "restores" all of it with no idea why.
  assert.throws(
    () =>
      readToolUse({
        stop_reason: 'max_tokens',
        content: [{ type: 'tool_use', input: { structure: {} } }],
      }),
    TruncatedError,
  );
});

test('a forced tool call that produced no tool call says so', () => {
  assert.throws(() => readToolUse({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'hi' }] }), NoToolUseError);
  assert.throws(() => readToolUse({}), NoToolUseError);
  assert.throws(() => readToolUse(null), NoToolUseError);
});

test('an ordinary answer hands back the tool call', () => {
  const block = { type: 'tool_use', name: 'submit_tailored_resume', input: { structure: { experience: [] } } };
  assert.equal(readToolUse({ stop_reason: 'tool_use', content: [{ type: 'text', text: '' }, block] }), block);
});

test('no deadline-governed call may time out before the request budget does', () => {
  // The bug this replaces: the tailor route budgeted 52s while the tailor's own
  // per-attempt timeout was 45s. The SDK timeout fired first, every time, on a
  // call measured at 44-50s — so the budget never ran, and the timeout's error
  // text and the budget's were identical, which is why it read as the wrong one.
  for (const kind of DEADLINE_GOVERNED) {
    assert.ok(
      CALL_CONFIG[kind].timeoutMs >= REQUEST_BUDGET_MS,
      `${kind} has a ${CALL_CONFIG[kind].timeoutMs}ms per-attempt timeout under a ${REQUEST_BUDGET_MS}ms request budget, so the timeout would preempt the deadline`,
    );
  }
});

test('the SDK does no retrying of its own inside a deadline', () => {
  // The SDK retries a timeout unconditionally, and a retried slow call is
  // another slow call for twice the wait. That doubling is what turned a
  // 45-second budget into the two minutes somebody actually sat through.
  //
  // These calls ARE retried now — once, by callClaude, and only when Anthropic
  // itself said it was busy. `serviceIsBusy` is what keeps those apart, and the
  // retry is skipped for any kind where the SDK already does its own, so the
  // two can never stack.
  for (const kind of DEADLINE_GOVERNED) {
    assert.equal(CALL_CONFIG[kind].retries, 0, `${kind} must leave retrying to callClaude`);
  }
});

test('the request budget leaves the platform room to answer', () => {
  // A budget at or above the ceiling is not a budget: the platform kill happens
  // outside any catch, so no refund and no message. Ten seconds is what the
  // route still has to do after the model answers — guard, measure, save.
  assert.ok(
    REQUEST_BUDGET_MS <= MAX_DURATION_S * 1000 - 10_000,
    `a ${REQUEST_BUDGET_MS}ms budget under a ${MAX_DURATION_S}s ceiling leaves nothing to save the result with`,
  );
  // Measured: the model call alone takes 40-48s, and fitting a page needs two
  // or three compiles after it at six seconds of headroom each.
  assert.ok(REQUEST_BUDGET_MS >= 70_000, 'a budget this tight leaves no room to measure a page, let alone cut one');
});

test('the routes that budget declare the ceiling the budget assumes', () => {
  /*
   * Next.js reads `maxDuration` statically at build time, so it cannot be an
   * import — which is exactly how a budget and a ceiling drift apart. They did
   * once already: the tailor budgeted 52s while this file gave it a 45s
   * per-attempt timeout, and the shorter leash won silently for a day.
   */
  const routes = [
    'app/api/applications/[id]/tailor/route.ts',
    'app/api/applications/[id]/instruct/route.ts',
  ];
  for (const route of routes) {
    const source = readFileSync(new URL(`../../${route}`, import.meta.url), 'utf8');
    const declared = /export const maxDuration = (\d+);/.exec(source);
    assert.ok(declared, `${route} declares no maxDuration, so the platform default applies`);
    assert.equal(
      Number(declared[1]),
      MAX_DURATION_S,
      `${route} allows ${declared[1]}s while the budget is written for ${MAX_DURATION_S}s`,
    );
  }
});

test('every model the app calls has its own pricing entry', () => {
  // pricing.ts falls back to Sonnet 4.6 rates for an unknown model, which is
  // deliberately the dearer of the two — safe for the ceiling, wrong for the
  // books. Switching models without adding rates is a silent mispricing of
  // every call, so it is a test rather than a code review.
  const KNOWN: Record<string, number> = {
    // USD for one million input tokens, from claude.com/pricing.
    'claude-sonnet-5': 2,
    'claude-sonnet-4-6': 3,
  };
  for (const kind of Object.keys(CALL_CONFIG) as UsageKind[]) {
    const model = CALL_CONFIG[kind].model;
    const expected = KNOWN[model];
    assert.ok(expected !== undefined, `${model} is not in this test's rate table — add it here and in pricing.ts`);
    assert.equal(
      estimateCostUsd(model, { inputTokens: 1_000_000, outputTokens: 0 }),
      expected,
      `${model} is priced by the fallback, not by its own entry in pricing.ts`,
    );
  }
});

test('token budgets carry Sonnet 5 headroom', () => {
  // Sonnet 5 counts ~36% more tokens for identical text (measured with
  // count_tokens on this app's tailor prompt: 4,253 on 4.6 against 5,805 on 5).
  // The old budgets were sized for the old tokenizer; left alone the small ones
  // truncate a tool call mid-JSON, which fails rather than merely shortens.
  const OLD: Record<string, number> = {
    extract: 4000, extract_resume: 4000, tailor: 8000, instruct: 8000,
    interview_turn: 2000, compose: 8000, polish: 2000, rule: 800, proofread: 1500,
  };
  for (const [kind, old] of Object.entries(OLD)) {
    assert.ok(
      CALL_CONFIG[kind as UsageKind].maxTokens >= old * 1.36,
      `${kind} still carries a pre-Sonnet-5 token budget`,
    );
  }
});

// ── retrying a busy service ────────────────────────────────────────────────
//
// Somebody watched a tailor fail in front of them because Anthropic was full.
// There was no retry, deliberately: under the old 52-second budget a second
// attempt ran past the ceiling and the platform killed the function mid-flight,
// which is worse than the failure. The budget is now 110 seconds and a retry
// fits, so the question becomes which failures deserve one.

test('a busy service is worth trying again', () => {
  for (const status of [429, 500, 502, 503, 529]) {
    const err = new Anthropic.APIError(status, undefined, 'busy', undefined);
    assert.ok(serviceIsBusy(err), `${status} means not now, not never`);
  }
});

test('our own clocks are never retried', () => {
  // Both of these are this app running out of time, not Anthropic being full.
  // Retrying either buys a second slow call for twice the wait, which is the
  // exact behaviour `retries: 0` was set to prevent.
  assert.equal(serviceIsBusy(new Anthropic.APIUserAbortError()), false, 'the request budget ran out');
  assert.equal(
    serviceIsBusy(new Anthropic.APIConnectionTimeoutError({ message: 'slow' })),
    false,
    'the per-attempt leash fired',
  );
});

test('a request that was wrong is never retried', () => {
  for (const status of [400, 401, 403, 404, 413, 422]) {
    const err = new Anthropic.APIError(status, undefined, 'no', undefined);
    assert.equal(serviceIsBusy(err), false, `${status} will fail exactly the same way twice`);
  }
});

test('a connection that never landed is worth one more go', () => {
  assert.ok(serviceIsBusy(new Anthropic.APIConnectionError({ message: 'socket hang up' })));
});

test('anything that is not an API failure is left alone', () => {
  assert.equal(serviceIsBusy(new Error('something else')), false);
  assert.equal(serviceIsBusy(null), false);
  assert.equal(serviceIsBusy(undefined), false);
});

test('retry-after is honoured, and capped', () => {
  const withHeader = (value: string) => ({ headers: new Headers({ 'retry-after': value }) });
  assert.equal(pauseBefore(withHeader('3')), 3_000, 'wait as long as they asked');
  assert.equal(pauseBefore(withHeader('600')), 10_000, 'but not longer than a request has');
  assert.equal(pauseBefore(withHeader('nonsense')), 1_000, 'unreadable falls back');
  assert.equal(pauseBefore({}), 1_000, 'and so does absent');
});

test('a plain-object header is read too', () => {
  // Older SDK shapes hand back an object rather than a Headers instance.
  assert.equal(pauseBefore({ headers: { 'retry-after': '2' } }), 2_000);
  assert.equal(pauseBefore({ headers: { 'Retry-After': '2' } }), 2_000);
});
