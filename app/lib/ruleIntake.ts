import { callClaude } from './anthropic';
import { RULE_INTAKE_TOOL } from '../api/claude/shared';
import type { RuleCheck } from './rules';

/**
 * Reading a rule once, so it can be checked for free forever after.
 *
 * The expensive question — "what does this sentence mean?" — is asked one time,
 * when somebody writes the rule. The cheap one — "does this resume break it?" —
 * is then arithmetic, on every tailored resume, with no model call at all. That
 * split is the whole reason this is affordable: ten rules cost about one
 * tailoring, for the life of the account.
 *
 * It never rewrites the rule. The sentence somebody typed stays the rule; this
 * produces a reading to keep beside it, which the page shows so that a wrong
 * reading is visible rather than mysterious.
 */
const PROMPT = `You read one rule a person has written for their own resume, and decide two things.

FIRST: whether the rule describes something a program could verify against a finished resume, with no judgement involved.

Most rules do not, and "none" is the right answer far more often than not. Anything about emphasis, ordering, tone, framing, what to lead with, or how something should read is guidance — a person could disagree about whether it was followed, so a program cannot decide it. Only choose a check when the rule is about the literal presence of specific words, a countable length, or a NAMED thing that must always stay on the resume.

That last one is the only check that changes what the app does rather than how it grades the result: a job, project or skill the rule names is one the app will not take off to reach a page limit, and it will say so rather than doing it quietly. The name is the test. "Always include the Aegon job" names one; "keep my strongest work on the page" names nothing and is guidance. A rule that says to keep something AND gives a condition — "whenever it fits", "unless something better needs the space" — still names it, so it is still a check: the person can read what the app will do and reword it if that is not what they meant.

A wrong check is worse than no check. It reports failures that are not real, on a resume the person cannot see anything wrong with, and they have no way to work out why. When in doubt, choose "none" — the rule still goes to the model as guidance and still shapes every resume.

SECOND: whether this rule contradicts one of their existing rules — where following both is impossible, or one plainly undoes the other. Rules covering different ground do not conflict. Two rules that could both be satisfied do not conflict. This is rare; 0 is usually correct.

Never rewrite, rephrase, or improve the rule. Their words are the rule.`;

export interface RuleReading {
  check: RuleCheck | null;
  /** 1-based index into the existing rules given, or null. */
  conflictsWith: number | null;
  conflictReason: string | null;
}

export interface ToolResult {
  checkKind: 'forbidden_text' | 'max_bullet_chars' | 'max_pages' | 'always_include' | 'none';
  names: string[];
  terms: string[];
  limit: number;
  conflictsWith: number;
  conflictReason: string;
}

export async function readRule(
  userId: string,
  text: string,
  existing: string[],
): Promise<RuleReading> {
  const content = [
    existing.length
      ? `Their existing rules, in priority order:\n${existing.map((r, i) => `${i + 1}. ${r}`).join('\n')}`
      : 'They have no other rules yet.',
    '',
    `The rule they have just written:\n${text.trim()}`,
  ].join('\n');

  const { toolInput } = await callClaude<ToolResult>({
    userId,
    kind: 'rule',
    system: PROMPT,
    content: [{ type: 'text', text: content }],
    tool: RULE_INTAKE_TOOL,
  });

  return {
    check: toCheck(toolInput),
    // Bounds-checked rather than trusted: an index pointing past the list would
    // render a conflict against a rule that does not exist.
    conflictsWith:
      toolInput.conflictsWith >= 1 && toolInput.conflictsWith <= existing.length
        ? toolInput.conflictsWith
        : null,
    conflictReason: toolInput.conflictReason?.trim() || null,
  };
}

/**
 * The tool's flat answer, narrowed to a check — or to nothing.
 *
 * Every branch can decline. A `forbidden_text` with no terms and a
 * `max_bullet_chars` of zero are both the model saying "checkable" and then not
 * saying what to check, and storing either would produce a rule that either
 * never fails or always does.
 */
export function toCheck(t: ToolResult): RuleCheck | null {
  if (t.checkKind === 'forbidden_text') {
    const terms = (t.terms ?? []).map((x) => x.trim()).filter(Boolean).slice(0, 8);
    return terms.length ? { kind: 'forbidden_text', terms } : null;
  }
  if (t.checkKind === 'max_bullet_chars') {
    // A limit below about forty characters is not a rule about line length, it
    // is a misreading — and it would fail every bullet on every resume.
    return t.limit >= 40 ? { kind: 'max_bullet_chars', limit: Math.round(t.limit) } : null;
  }
  /*
   * A page limit, which is the one rule that changes what the tailor DOES
   * rather than only what the page reports.
   *
   * It was missing from here while everything downstream already understood it
   * — the checker, the page, the fitting loop. So "keep it to one page" was read
   * as guidance, saved with no check, and the resume was never cut: a feature
   * complete at every step except the one where a person switches it on.
   *
   * Whole pages, and a handful at most. Zero would fail every resume there is,
   * and a number in the dozens is a bullet length or a word count misread as a
   * page limit — the same failure the forty-character floor above exists for.
   */
  if (t.checkKind === 'max_pages') {
    const pages = Math.round(t.limit);
    return pages >= 1 && pages <= 5 ? { kind: 'max_pages', limit: pages } : null;
  }
  /*
   * The other rule that changes what the tailor DOES.
   *
   * Pins used to be read straight out of rule text by a regex at tailor time,
   * which was wrong three ways: fragile on free prose, invisible — nothing on
   * screen said what had been bound — and it turned a sentence somebody meant
   * as guidance into a constraint. This is the same intent through the
   * mechanism the rules page already had: the meaning is read once, the
   * reading is shown beside the rule, and the fitter obeys the reading.
   *
   * A name is the whole test. "Always include Aegon" is a check; "keep the
   * strongest work on the page" names nothing and stays guidance.
   */
  if (t.checkKind === 'always_include') {
    const names = (t.names ?? [])
      .map((x) => x.trim())
      // Two characters cannot identify a job, and a long one is a sentence
      // rather than a name — both would match wrongly or not at all.
      .filter((x) => x.length >= 3 && x.length <= 60)
      .slice(0, 6);
    return names.length ? { kind: 'always_include', names } : null;
  }
  return null;
}
