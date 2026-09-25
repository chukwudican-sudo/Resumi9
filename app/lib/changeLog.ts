/**
 * The change log, made safe to print.
 *
 * "What changed" is the only account somebody gets of what an edit did. Nobody
 * reads thirty-nine bullets to check; they read the list. So of everything on
 * that screen it is the line most likely to be believed — and it was the one
 * thing saved exactly as the model wrote it, while the resume beside it went
 * through provenance, an honesty pass and the guard.
 *
 * It cost a version that said it had made 116 edits. The tool asks for a list
 * of sentences; the model sent one sentence; `[...'Removed the Aegon job']`
 * spreads a string into its letters, and the screen drew a column of them, one
 * per row, down the whole page. Saved that way too, so reloading did not help.
 *
 * Two functions, because there are two problems and they are not the same one.
 * `asLines` stops it happening again. `mendSplitLines` is for the rows already
 * written — four of them on one resume — which no code change can reach.
 */

/**
 * Whatever came back, as a list of sentences.
 *
 * A bare string is ONE line, never its characters. A tool schema asking for an
 * array of strings does not guarantee one: a forced tool call constrains what
 * is asked for, not what arrives, and a model that answers a request for a list
 * with a single sentence is being reasonable in every way but the shape.
 */
function normalise(value: unknown, trim: boolean): string[] {
  const keep = (s: string) => (trim ? s.trim() : s);
  const one = (item: unknown): string[] => {
    if (typeof item === 'string') return item.split('\n').map(keep);
    if (item === null || item === undefined) return [];
    // A warning arrived as `{ text, retry }` for one afternoon and those rows
    // are still stored. Anything else object-shaped is worth printing rather
    // than dropping — "[object Object]" on screen is a bug somebody reports.
    const text = (item as { text?: unknown }).text;
    if (typeof text === 'string') return [keep(text)];
    if (typeof item === 'object') return [];
    return [keep(String(item))];
  };

  return (Array.isArray(value) ? value : [value]).flatMap(one);
}

export function asLines(value: unknown): string[] {
  return normalise(value, true).filter(Boolean);
}

/**
 * A stored log, read back and made readable.
 *
 * Mending has to happen before blanks are dropped, and that is the whole reason
 * this is its own function rather than `mendSplitLines(asLines(…))`. The spread
 * string put its SPACES in the list as rows of their own, so a tidy-up that
 * drops empty rows first deletes exactly the characters that separate the
 * words, and the sentence comes back as "RemovedtheAegonjob".
 */
export function storedLines(value: unknown): string[] {
  return mendSplitLines(normalise(value, false))
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Lines about where sections sit, dropped.
 *
 * Run only when the app itself moved a section, so the arrangement is already
 * reported in the app's own words and anything the model adds is either a
 * repetition or a description of the machinery:
 *
 *     Noted your request to move Skills below Education — section placement is
 *     handled by the app's layout, so no content was changed.
 *
 * It put a second one in the WARNINGS, which are meant to be things to check
 * before sending a resume to an employer. Neither was a lie; both were the app
 * talking about itself to somebody who wanted to know what their resume says.
 *
 * In code rather than in the prompt because the prompt was tried first: a line
 * instructing the model to say nothing about order, written the same day, was
 * ignored on that same run.
 */
export function withoutOrderTalk(lines: string[]): string[] {
  const SECTION = /\bsections?\b/i;
  const ABOUT_ORDER =
    /\b(?:order(?:ing|ed)?|placement|placed|position(?:ed|ing)?|arrang\w+|layout|sequence|reorder\w*|rendered|above|below|top|bottom|first|last)\b/i;
  return lines.filter((line) => !(SECTION.test(line) && ABOUT_ORDER.test(line)));
}

/**
 * A sentence that was stored one letter per row, put back together.
 *
 * Repair for rows written before `asLines` existed. Only runs of single
 * characters are joined, and only runs long enough that no real log could be
 * mistaken for one — a log line is a sentence, so four consecutive rows of one
 * character each is not a coincidence, it is a spread string.
 *
 * Joined with nothing, because the spaces were spread too and are sitting in
 * the list as their own rows.
 */
export function mendSplitLines(lines: string[]): string[] {
  const RUN = 4;
  const out: string[] = [];

  for (let i = 0; i < lines.length; ) {
    let end = i;
    while (end < lines.length && lines[end].length <= 1) end += 1;

    if (end - i >= RUN) {
      const mended = lines.slice(i, end).join('').trim();
      if (mended) out.push(mended);
    } else {
      for (let j = i; j < end; j += 1) out.push(lines[j]);
    }

    if (end === i) {
      out.push(lines[i]);
      i += 1;
    } else {
      i = end;
    }
  }

  return out.filter(Boolean);
}
