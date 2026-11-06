/**
 * One instruction, split into the separate things it asks for.
 *
 * Every reader of an instruction tests its vocabulary against the WHOLE
 * sentence, which is right until the sentence does two things at once. Then
 * the words of one half answer questions asked about the other.
 *
 * The sentence that showed it, 6 Nov:
 *
 *     Remove the Kudi Kitchen entry from Technical Projects only.
 *     Keep the Kudi Kitchen job in Experience.
 *
 * Two clauses, two different subjects, and this profile has a Kudi Kitchen in
 * both sections. Read whole, the text says "projects" and it says "job", so
 * the removal reader saw a tie and asked "which one — the job or the project?"
 * about a sentence that had already said. And the pin reader, seeing both
 * section words, pinned Kudi Kitchen in BOTH places — so the project the
 * person asked to delete became permanently uncuttable, and three versions
 * later the fitter reported it could not meet their one-page rule because of
 * a promise they never made.
 *
 * Read clause by clause, each half answers only for itself.
 *
 * The splitting is deliberately timid, because a wrong split is worse than no
 * split: losing half a sentence loses half an instruction. Sentence enders and
 * semicolons always separate. "and" only separates when what follows begins
 * with a verb — "keep Aegon and Droady" is one list and must not become a
 * clause called "Droady", while "drop the second bullet and use the space to
 * show Western Bell" is two requests and was being read as one.
 */

/**
 * Verbs that can open a request.
 *
 * Only ever used to decide whether "and" joins two clauses or continues a
 * list, so the cost of a word missing from here is a split that does not
 * happen — the behaviour there has always been.
 */
const OPENS_A_CLAUSE =
  /^(?:also\s+|then\s+|please\s+|now\s+)?(?:remove|removing|delete|deleting|drop|dropping|cut|cutting|keep|keeping|leave|leaving|add|adding|put|putting|bring|bringing|restore|restoring|include|including|show|showing|use|using|move|moving|swap|swapping|replace|replacing|make|making|shorten|shortening|lengthen|reword|rewording|rewrite|rewriting|change|changing|set|update|updating|mention|mentioning|take|taking|lead|start|end|list|listing|order|reorder|highlight|emphasi[sz]e|focus|trim|trimming|expand|tighten|fix|turn|swap)\b/i;

/**
 * Where one clause MIGHT end. Whether it does is decided by what follows.
 *
 * A full stop is not reliable evidence on its own: "Add the WesternBell
 * International Ltd. job" has one in the middle of an employer's name, and
 * splitting there left a clause called "job" and lost the entry the sentence
 * was about. So every separator — a stop, a semicolon, a newline, an "and" —
 * only separates when the text after it OPENS a clause.
 */
const SEPARATOR = /(?<=[.!?;,])\s+|\s*\n+\s*|\s+(?:and|but|then|also)\s+/gi;

/**
 * Where each clause begins and ends in the original string.
 *
 * Offsets rather than pieces, because a reader that has already located
 * something — a verb at index 42 — needs to know which clause it fell in, and
 * comparing trimmed substrings cannot answer that. The ranges are contiguous
 * and cover the whole input, so every position belongs to exactly one.
 *
 * Walked left to right rather than split, so the decision is made at each
 * separator in turn: the text after it begins a new clause only if it opens
 * with a verb. Anything else is a continuation and stays attached to the
 * clause it was written in — which is what keeps "keep Aegon and Droady"
 * whole, and "Ltd. job" with the name it belongs to.
 */
export function clauseRanges(text: string): { from: number; to: number }[] {
  const whole = text ?? '';
  if (!whole.trim()) return [];

  const out: { from: number; to: number }[] = [];
  const marks = new RegExp(SEPARATOR.source, 'gi');
  let start = 0;
  for (let at = marks.exec(whole); at; at = marks.exec(whole)) {
    const cut = at.index + at[0].length;
    if (!OPENS_A_CLAUSE.test(whole.slice(cut))) continue;
    if (whole.slice(start, cut).trim()) out.push({ from: start, to: cut });
    start = cut;
  }
  if (whole.slice(start).trim()) out.push({ from: start, to: whole.length });

  return out.length ? out : [{ from: 0, to: whole.length }];
}

/**
 * The clause a position falls in, or the whole string if it falls outside.
 *
 * For a reader that has found its verb and needs to know what else was said
 * in the same breath — the section word that tells a Kudi Kitchen job from a
 * Kudi Kitchen project belongs to the clause that named it, not to the
 * sentence it shares with another request.
 */
export function clauseAt(text: string, index: number): string {
  const whole = text ?? '';
  for (const { from, to } of clauseRanges(whole)) {
    if (index >= from && index < to) return whole.slice(from, to);
  }
  return whole;
}

/**
 * The separate requests in one instruction, in the order they were written.
 *
 * Never empty for non-empty input: a sentence that splits into nothing comes
 * back as itself, so a caller can always fall back to reading the whole thing.
 */
export function clauses(text: string): string[] {
  const whole = (text ?? '').trim();
  if (!whole) return [];

  /*
   * A range runs up to and including the separator that ended it, so the
   * joiner comes off here — the text of a clause is the request, not the word
   * that attached it to the next one. A full stop is left alone: it belongs to
   * the sentence, and stripping it would take the one off "Ltd." too.
   */
  return clauseRanges(text).map(({ from, to }) =>
    (text ?? '')
      .slice(from, to)
      .trim()
      .replace(/[\s,;]+$/, '')
      .replace(/\s+(?:and|but|then|also)$/i, ''),
  );
}

/**
 * The clauses a pattern appears in, or the whole instruction when none do.
 *
 * The fallback is what makes this safe to adopt: a reader that finds its verb
 * in no clause behaves exactly as it did before, reading everything.
 */
export function clausesSaying(text: string, pattern: RegExp): string[] {
  const parts = clauses(text).filter((part) => pattern.test(part));
  return parts.length ? parts : [(text ?? '').trim()].filter(Boolean);
}
