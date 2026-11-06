import { namesEntry, squash } from './names';

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
 * Lines about entries that are not on the finished page, dropped.
 *
 * The log is written in pieces by passes that run at different times, and
 * nothing has ever compared it to the resume that was actually saved. The
 * model describes the structure IT returned; the fitter then cuts entries to
 * reach the page limit; both sets of sentences are concatenated and stored.
 *
 * A real tailor, 6 Nov, produced all of this in one log:
 *
 *     Reworded WesternBell website bullet to name HTML/CSS/JavaScript …
 *     Framed the Droady and WesternBell bullets around troubleshooting …
 *     Dropped 1 role to fit one page: WesternBell International Ltd..
 *
 * Every line true when it was written. Together they describe work on a job
 * that is not on the page, and the person went looking for a bullet that does
 * not exist. The fitter's own line already says what happened to it, so the
 * sentences about work that no longer shows are the ones to go.
 *
 * Only lines about nothing BUT departed entries are dropped. "Reworded the
 * WesternBell and Droady bullets" still describes a real change to Droady,
 * and half a true sentence beats none.
 */
export function aboutWhatSurvived(
  lines: string[],
  present: readonly string[],
  gone: readonly string[],
): string[] {
  const named = (line: string, names: readonly string[]) =>
    names.some((name) => name.trim() && namesEntry(line, name));
  const left = gone.filter((name) => name.trim() && !present.some((p) => squash(p) === squash(name)));
  if (!left.length) return lines;
  return lines.filter((line) => !named(line, left) || named(line, present));
}

/**
 * A cited rule number, replaced by what the rule actually says.
 *
 * "Removing Kudi goes against rule 4" was in a real change log. Rule 4 sets
 * that job's TITLE on technical postings and says nothing about keeping the
 * entry, so the sentence was a refusal justified by a rule that did not
 * refuse anything — and the number made it unanswerable, because the person
 * would have to go and count their own rules to find out.
 *
 * The prompt asks for the rule's words rather than its number, and has since
 * before this was observed; it is not holding, which is the usual reason a
 * thing moves from the prompt into code. Quoting is better than checking the
 * citation: judging whether a rule really supports a claim is a reading
 * problem, while showing the sentence it rests on lets the person judge in
 * the time it takes to read the line.
 *
 * A number nothing answers to is dropped rather than quoted — a citation of
 * a rule that does not exist is noise in a sentence that is otherwise about
 * their resume. Universal rules are the app's own machinery and mean nothing
 * to a reader, so those citations go the same way.
 */
export function withRulesQuoted(lines: string[], rules: readonly { text: string }[]): string[] {
  const texts = rules.map((r) => (r?.text ?? '').trim()).filter(Boolean);

  /** The rule in one short phrase, with its own quote marks flattened. */
  const quote = (text: string) => {
    const one = text.replace(/\s+/g, ' ').replace(/["“”]/g, "'").trim().replace(/[.]+$/, '');
    return one.length <= 60 ? one : `${one.slice(0, 57).replace(/[\s,;:]+\S*$/, '')}…`;
  };

  // The qualifier is only consumed when it is actually there, or the match
  // swallows the space before it and "against rule 4" becomes "againstyour".
  const CITED = /\b(?:(your|universal)\s+)?rules?\s*#?(\d+)\b/gi;

  const out: string[] = [];
  for (const line of lines) {
    const cites = [...line.matchAll(CITED)];
    if (!cites.length) {
      out.push(line);
      continue;
    }

    /*
     * A citation the reader cannot check is dropped with its sentence.
     *
     * A universal rule is the app's own machinery and means nothing to
     * somebody reading their resume; a number past the end of their list is
     * a citation of nothing. Substituting either leaves a mangled sentence
     * — "This breaks universal rule 1" became "This." — so the line goes
     * instead. Nothing true is lost: a line whose only content was an appeal
     * to a rule that cannot be shown had no content for this reader.
     */
    const unusable = cites.some(
      (m) => (m[1] ?? '').toLowerCase() === 'universal' || !texts[Number(m[2]) - 1],
    );
    if (unusable) continue;

    out.push(
      line
        .replace(CITED, (_whole, _which, digits: string) => `your rule "${quote(texts[Number(digits) - 1])}"`)
        .replace(/\s{2,}/g, ' ')
        .replace(/\s+([.,;:)])/g, '$1')
        .replace(/\(\s+/g, '(')
        .trim(),
    );
  }
  return out;
}

/** The entries a resume actually shows, by the name each answers to. */
export function entryNames(structure: {
  experience?: unknown;
  projects?: unknown;
  education?: unknown;
}): string[] {
  const list = (value: unknown) => (Array.isArray(value) ? value : []);
  return [
    ...list(structure.experience).map((e) => (e as { org?: string })?.org ?? ''),
    ...list(structure.projects).map((p) => (p as { name?: string })?.name ?? ''),
    ...list(structure.education).map((s) => (s as { school?: string })?.school ?? ''),
  ].filter(Boolean);
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

/**
 * Warnings sorted by who they are about.
 *
 * One field holds two unrelated kinds of sentence, and they ended up in one
 * box at the bottom of the review column called "Worth checking":
 *
 *   "This candidate's background is entirely software engineering with no CAD
 *    evidence — consider whether this posting is a good fit."
 *
 *   "A rewritten bullet claimed Python, which this bullet does not say, so
 *    your own wording was put back."
 *
 * The first decides whether to apply at all. The second is the app reporting
 * what it did, and belongs with the change log where the rest of that lives.
 * Filed together only because they arrive in the same array.
 *
 * Told apart by the guard's own phrasing. Every repair it writes says
 * something was put back, restored, dropped, or is not in the profile —
 * they are templates in tailorGuard and honesty, not free text. Anything else
 * came from the model and is about the resume or the posting.
 *
 * A wrong guess is survivable in one direction only, which is why the test is
 * written round the app's words rather than the model's: a model warning
 * misfiled as an app note still shows, one line lower. An app note misfiled as
 * a verdict on the job puts "your own wording was put back" under a heading
 * about whether to apply.
 */
const THE_APP_DID_THIS =
  /\b(?:put back|putting back|restored|restoring|was dropped|were dropped|your own wording|not in your profile|has been put back|have been put back)\b/i;

export function splitWarnings(warnings: string[]): { aboutTheApp: string[]; aboutTheJob: string[] } {
  const aboutTheApp: string[] = [];
  const aboutTheJob: string[] = [];
  for (const line of warnings) (THE_APP_DID_THIS.test(line) ? aboutTheApp : aboutTheJob).push(line);
  return { aboutTheApp, aboutTheJob };
}
