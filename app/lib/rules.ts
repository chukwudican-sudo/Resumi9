/**
 * Shared constants for the rules feature.
 *
 * Lives here rather than in actions.ts because a `'use server'` file may only
 * export async functions — a plain constant there fails the build with an error
 * that typecheck does not produce, so the split is load-bearing rather than
 * organisational.
 */

/** Long enough for a real instruction, short enough to stay a rule. */
export const RULE_MAX_LENGTH = 280;

/**
 * What a rule can be checked for, when it can be checked at all.
 *
 * Derived once, by a model, from the sentence somebody typed — never instead of
 * it. The rule is their words; this is the app's reading of them, kept beside it
 * and shown on the page so a wrong reading is visible rather than mysterious.
 *
 * Two kinds on purpose. Between them they cover the rules this app already
 * suggests as examples, and every further kind is another way to be confidently
 * wrong about what somebody meant. More can follow once real rules ask for them.
 */
export type RuleCheck =
  /** "Never use the word spearheaded." "Call it Ontario Tech, never UOIT." */
  | { kind: 'forbidden_text'; terms: string[] }
  /** "Keep every bullet to one line." */
  | { kind: 'max_bullet_chars'; limit: number }
  /** "Keep it to one page." Checked against the rendered PDF, not a guess. */
  | { kind: 'max_pages'; limit: number };

/** Whether a rule held on one resume, and where it did not. */
export interface RuleResult {
  ruleId: string;
  text: string;
  /**
   * `guidance` is not a failure and not a pass.
   *
   * Most rules are advice — "lead with impact, then the technology" — and there
   * is no honest way to verify one. Saying so is the point: guidance that
   * displayed as a tick would be claiming an enforcement that never happened.
   */
  verdict: 'pass' | 'fail' | 'guidance';
  /** Only on a failure. "\u201cUOIT\u201d is in your education entry." */
  evidence?: string;
  /** What would fix it, ready for the instruction box. */
  fix?: string;
}

/** A rule as the checker needs it. */
export interface CheckableRule {
  id: string;
  text: string;
  check: RuleCheck | null;
}

/**
 * What the page says a check means, in the person's terms rather than the app's.
 *
 * Every kind is named. This used to end with the bullet-length sentence as a
 * fall-through, so the moment a third kind existed it would describe itself as
 * something it is not \u2014 and `check` is untyped jsonb in the database, so a kind
 * this build has never heard of can arrive at any time.
 */
export function describeCheck(check: RuleCheck | null): string | null {
  if (!check) return null;
  switch (check.kind) {
    case 'forbidden_text': {
      const quoted = check.terms.map((t) => `\u201c${t}\u201d`).join(', ');
      return `Checked \u2014 your resume must not contain ${quoted}.`;
    }
    case 'max_bullet_chars':
      return `Checked \u2014 no bullet longer than ${check.limit} characters.`;
    case 'max_pages':
      return `Checked \u2014 your resume must fit on ${check.limit} ${check.limit === 1 ? 'page' : 'pages'}.`;
    default:
      return null;
  }
}

/** The default when nobody has said otherwise. Two pages, per Alex's call. */
export const DEFAULT_PAGE_TARGET = 2;

/**
 * How many pages this person's resume may run to.
 *
 * The smallest limit they set, because two rules about length are a person
 * changing their mind, and the tighter one is the one they meant. Nobody
 * setting a limit means the default.
 *
 * Read by the tailor, which is why it lives beside the rules rather than in the
 * route: the model is never asked to judge length \u2014 it ranks what matters least
 * and the app cuts to fit what this returns.
 */
export function pageTarget(rules: CheckableRule[]): number {
  const limits = rules
    .map((r) => (r.check?.kind === 'max_pages' ? r.check.limit : null))
    .filter((n): n is number => typeof n === 'number' && n > 0);
  return limits.length ? Math.min(...limits) : DEFAULT_PAGE_TARGET;
}
