import { patternFor } from './requirementMatch';

/**
 * Whether a sentence names a thing on the resume.
 *
 * One question, asked in five places, answered five different ways. Each
 * reader of an instruction — pins, asked, restore, move, scope — grew its own
 * copy of "does this sentence mention that entry", and they disagree, which is
 * how one sentence gets read five ways in a single request.
 *
 * Measured on a real edit, 6 Nov: the person typed "Add the Western Bell
 * International job to Experience" about an entry the app had taken off to fit
 * a page. `couldComeBack` listed it as available. `readRestore` could not match
 * it, because the profile spells it `WesternBell International Ltd.` — closed
 * up, with a suffix. So no restore was read, the sentence went to the model,
 * the model was told the app would splice the entry in, it returned a log and
 * no structure, and the request came back 502 "that edit came back unusable".
 * Two spellings of one employer, and the person is told their edit is broken.
 *
 * So the comparison lives here and nowhere else. Three ways a name can be
 * written, in the order they are tried:
 *
 *   1. As stored. `patternFor` already absorbs a hyphen or a space that only
 *      one side has, so "back-end" matches "backend".
 *   2. Without the corporate suffix. Somebody types "Western Bell", never
 *      "WesternBell International Ltd." — the suffix is on the record, not in
 *      the sentence.
 *   3. Closed up. "WesternBell" and "Western Bell" are the same employer, and
 *      which one is stored depends on who typed it into the profile.
 *
 * The caution that matters is in the other direction: this must not match a
 * name the person did not say, because every caller acts on a match — a pin
 * that never lifts, an entry restored, a section unfrozen. So the closed-up
 * comparison has a length floor, and a bare first word only counts when it is
 * long enough and is not a word every company shares.
 */

/** Words too generic to identify anything by on their own. */
const SUFFIX = new Set([
  'inc', 'ltd', 'limited', 'llc', 'llp', 'plc', 'corp', 'corporation', 'co', 'company',
  'group', 'holdings', 'labs', 'lab', 'technologies', 'technology', 'tech', 'solutions',
  'systems', 'services', 'international', 'global', 'partners', 'ventures', 'studio',
  'studios', 'university', 'college', 'school', 'institute', 'the', 'and', 'of',
]);

/** Letters and digits only, for comparing text that may be spaced differently. */
export const squash = (text: string): string =>
  (text ?? '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');

/** The words of a name, punctuation dropped. */
const wordsOf = (name: string): string[] =>
  (name ?? '').split(/[\s,/&–—-]+/).map((w) => w.replace(/[.]/g, '')).filter(Boolean);

/**
 * The name with trailing throwaway words removed, one step at a time.
 *
 * Every length is returned, longest first, not only the fully stripped one.
 * "WesternBell International Ltd." reduces to "WesternBell" in two steps and
 * the step between them is the one people actually type — returning only the
 * ends missed "Western Bell International" entirely.
 *
 * Only from the END, and never all of it: "International Business Machines"
 * is not improved by having "International" taken off the front, and a name
 * made entirely of these words keeps whatever it had.
 */
function shortenings(name: string): string[] {
  const words = wordsOf(name);
  const out: string[] = [];
  for (let end = words.length; end > 1; end -= 1) {
    out.push(words.slice(0, end).join(' '));
    if (!SUFFIX.has(words[end - 1].toLowerCase())) break;
  }
  if (words.length) out.push(words[0]);
  return out;
}

/**
 * The spellings of a name worth looking for in a sentence.
 *
 * Longest first, so a caller that wants to know WHICH form matched — for
 * reporting, or for cutting the matched span out of a sentence — gets the most
 * specific one rather than a first word that happens to appear.
 */
export function waysOfNaming(name: string): string[] {
  const full = (name ?? '').trim();
  if (!full) return [];

  const ways = [full];
  for (const shorter of shortenings(full)) {
    /*
     * The first word alone is kept only when it can carry a name on its own —
     * for the person who writes "Aegon" about "Aegon Asset Management". Four
     * characters at least, and never a word every company shares: "The",
     * "Global" and "Tech" would each match half a profile.
     */
    const single = wordsOf(shorter).length === 1;
    if (single && (shorter.length < 4 || SUFFIX.has(shorter.toLowerCase()))) continue;
    ways.push(shorter);
  }

  const seen = new Set<string>();
  return ways
    .filter((way) => way && !seen.has(way.toLowerCase()) && seen.add(way.toLowerCase()))
    .sort((a, b) => b.length - a.length);
}

/**
 * A pattern matching one name however it is spaced or punctuated.
 *
 * `patternFor` absorbs a separator that only one side has, which covers
 * "back-end" against "backend" — but not a space that appears INSIDE a word
 * the profile stores closed up. "WesternBell" and "Western Bell" are one
 * employer, written by two different people, and no pattern built from either
 * spelling finds the other.
 *
 * So the letters are what matter and everything between them is optional. The
 * whole sequence still has to appear in order, which is what keeps this from
 * matching loosely: it is the same name, respaced, or it is not a match.
 */
export function spanFor(name: string): RegExp | null {
  const letters = squash(name);
  if (letters.length < 3) return null;
  const body = letters
    .split('')
    .map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\s.,\\-/&]*');
  return new RegExp(`(?<![a-z0-9])${body}(?![a-z0-9])`, 'i');
}

/**
 * Whether `text` names the thing called `name`.
 *
 * The closed-up comparison is last and has a floor of five characters: below
 * that it starts matching inside unrelated words, and a wrong match here
 * deletes somebody's job rather than returning a bad search result.
 */
export function namesEntry(text: string, name: string): boolean {
  const said = (text ?? '').trim();
  if (!said || !(name ?? '').trim()) return false;

  for (const way of waysOfNaming(name)) {
    if (patternFor(way).test(said)) return true;
  }

  const flat = squash(said);
  return waysOfNaming(name).some((way) => {
    const closed = squash(way);
    return closed.length >= 5 && flat.includes(closed);
  });
}

/**
 * Whether `text` BEGINS with the thing called `name`.
 *
 * The difference between asking for an entry and mentioning one. "Add the
 * Western Bell International job" and "add that I used C# at Droady" both
 * contain an asking verb and the name of something the app has taken off; only
 * the first is a request to put it back. What separates them is what the verb
 * is acting on, so the caller strips the verb and the filler after it and asks
 * this about what is left.
 */
export function namedAtStart(text: string, name: string): boolean {
  const said = (text ?? '').trim();
  if (!said || !(name ?? '').trim()) return false;

  for (const way of waysOfNaming(name)) {
    const at = patternFor(way).exec(said);
    if (at && at.index === 0) return true;
    const closed = squash(way);
    if (closed.length >= 5 && squash(said).startsWith(closed)) return true;
  }
  return false;
}

/**
 * One skills line, split into the terms it lists.
 *
 * A comma inside brackets does not end a term. `"Cloud Platforms (Vercel,
 * Cloudflare)"` split naively becomes `"Cloud Platforms (Vercel"` and
 * `"Cloudflare)"` — two halves that match nothing in the person's record, so
 * the guard reads both as invented, takes them off, and then puts the whole
 * original back somewhere else.
 *
 * This existed eleven times across the app, written out by hand each time and
 * naive in all eleven. Nobody had hit it yet because the profiles in use spell
 * their one bracketed term with a slash — "GitHub Actions (CI/CD)".
 */
export function splitTerms(items: string): string[] {
  const text = items ?? '';
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '(' || c === '[') depth += 1;
    else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
    else if (c === ',' && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((t) => t.trim()).filter(Boolean);
}

/**
 * A term with any bracketed aside removed: "GitHub Actions (CI/CD)" → "GitHub
 * Actions".
 *
 * What a term is really called, for deciding whether a line still lists it
 * after the tailor has rewritten the line. The bracket is a gloss, and a
 * tailor that drops the gloss has not dropped the skill.
 */
export function withoutAside(term: string): string {
  return (term ?? '').replace(/\s*[([][^)\]]*[)\]]\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Which stored name a sentence names, or null.
 *
 * For the callers that have a list and need the one that was meant. The
 * longest match wins, so "Kudi Kitchen" is preferred over "Kudi" when a
 * profile holds both.
 */
export function whichNamed<T>(text: string, items: readonly T[], nameOf: (item: T) => string): T | null {
  let best: { item: T; length: number } | null = null;
  for (const item of items) {
    const name = nameOf(item);
    if (!namesEntry(text, name)) continue;
    const length = squash(name).length;
    if (!best || length > best.length) best = { item, length };
  }
  return best?.item ?? null;
}
