import { patternFor } from './requirementMatch';
import type { DroppedEntry } from './fit';

/**
 * Reading "put Droady back" out of a sentence.
 *
 * The app can take entries off a resume to reach a page limit, and until now
 * it could not put one back. Somebody looked at a page showing one job, typed
 * "i need more significant experiences, why is there just one", and got a
 * question in reply — because the other three were not on the page and the
 * edit had nothing to see. Their own words for what that cost: it makes them
 * look like they have never worked anywhere.
 *
 * Restoring is done by the app, not by the model, for the same reason section
 * moves are: the entry is COPIED from what was kept, exactly as it was, so
 * nothing is retyped and nothing can be invented on the way. The model's only
 * job is to notice that a restore was asked for at all, and even that is a
 * backstop — this reads the ordinary ways of asking.
 */

export interface Restore {
  /** Which entries to bring back, in the order they sat on the page. */
  entries: DroppedEntry[];
  /** The sentence was nothing but this, so the model has no work to do. */
  only: boolean;
}

export type RestoreRead = { restore: Restore } | { ask: string } | null;

const ASKING_BACK = /\b(?:add|put|bring|restore|reinstate|return|want|need|include|show|use)\b/i;

/**
 * Asking for something IN, without the word "back" anywhere.
 *
 * The real sentence this missed: "Replace the Kudi Kitchen experience entry
 * with the Rate Limit Lab project". No "add", no "back" — so nothing read it
 * as a request to bring anything in, the whole sentence went to the model,
 * and the model answered that Rate Limit Lab "is not available to add". It
 * was sitting in the list of things the app had taken off, one lookup away.
 */
const SWAPPING = /\b(?:replace|replacing|replaced|swap|swapping|substitute|substituting|instead\s+of|in\s+place\s+of)\b/i;

/**
 * Which side of a swap is the thing coming IN.
 *
 * "Replace A with B" and "swap A for B" put it after the connector; "use B
 * instead of A" and "put B in place of A" put it before. Reading the wrong
 * side restores the entry they asked to get rid of, which on the resume this
 * was found on would have been possible: Kudi Kitchen is both a job on the
 * page and a project the app had taken off.
 */
const INCOMING_AFTER = /\b(?:replace|replacing|replaced|swap|swapping|substitute|substituting)\b[\s\S]*?\b(?:with|for)\b/i;
const INCOMING_BEFORE = /\b(?:instead\s+of|in\s+place\s+of)\b/i;
const BACK = /\bback\b|\brestor\w*|\breinstat\w*/i;
const EVERYTHING = /\b(?:all|everything|every\s+one|the\s+lot|them\s+all|all\s+of\s+(?:them|it))\b/i;
const THE_JOBS = /\b(?:jobs?|roles?|experiences?|positions?|work\s+history)\b/i;
const THE_PROJECTS = /\b(?:projects?)\b/i;
const PRONOUN = /\b(?:it|them|those|these|that|the\s+ones?)\b/i;

/**
 * Words that can be left over without meaning something else was asked for.
 *
 * The second group is what an entry gets called and where in a list it sits.
 * "add Aegon back as a third job" was failing this test on "as", "third" and
 * "job", so the sentence went to the model — a call, a wait, and a rewrite of
 * a resume, for an instruction the app can carry out by copying one entry
 * from what it kept. It is also the exact sentence the bug report asks to be
 * able to type.
 *
 * Deliberately NOT here: top, bottom, above, below, first in the sense of
 * placement. Those ask for an arrangement, which a restore does not do — and
 * swallowing them would silently ignore the half of the sentence the person
 * cares most about. "as a third job" is a description of the result; "at the
 * top" is a request.
 */
const FILLER =
  /\b(?:please|pls|can|could|would|you|i|my|me|the|a|an|to|and|also|just|now|ok|okay|thanks|thank|want|need|like|add|put|bring|restore|reinstate|return|back|again|onto|on|in|into|resume|page|it|them|those|these|that|ones?|all|everything)\b|\b(?:as|second|third|fourth|fifth|jobs?|roles?|positions?|entr(?:y|ies)|experiences?|projects?|sections?)\b/gi;

function nothingElse(text: string, names: string[]): boolean {
  let rest = text;
  for (const name of names) rest = rest.replace(patternFor(name), ' ');
  rest = rest.replace(FILLER, ' ').replace(/[^a-z0-9]+/gi, '');
  return rest === '';
}

/**
 * What a sentence asks to bring back, a question when it is nearly one, or
 * nothing at all.
 *
 * `answer` is the reply to a question this asked on an earlier pass: "put it
 * back" names nothing, and the person supplies the name.
 */
export function readRestore(text: string, dropped: DroppedEntry[], answer = ''): RestoreRead {
  const words = (text ?? '').trim();
  if (!words || !dropped.length) return null;

  const swap = SWAPPING.test(words);
  if (!swap && (!ASKING_BACK.test(words) || !BACK.test(words))) return null;

  const inOrder = [...dropped].sort((a, b) => a.index - b.index);
  const named = (from: string) => inOrder.filter((d) => d.name && patternFor(d.name).test(from));

  /*
   * On a swap, only the incoming half of the sentence is read for names.
   *
   * Otherwise "replace Kudi Kitchen with Rate Limit Lab" brings back the Kudi
   * Kitchen project as well as the Rate Limit Lab one — both are on the list
   * of things taken off, and the sentence names both.
   */
  const incoming = (() => {
    if (!swap) return words;
    const after = INCOMING_AFTER.exec(words);
    if (after) return words.slice(after.index + after[0].length);
    const before = INCOMING_BEFORE.exec(words);
    if (before) return words.slice(0, before.index);
    return words;
  })();

  // A name wins over everything: "put Droady back" is not ambiguous because
  // the sentence also contains the word "jobs".
  const byName = named(incoming);
  if (byName.length) {
    /*
     * A swap is never `only`.
     *
     * `only` means the app can carry the whole sentence out by itself with no
     * model call. Bringing something in is half of a swap; what goes out is
     * the other half, and skipping it would answer a replace with an add.
     */
    return {
      restore: {
        entries: byName,
        only: !swap && nothingElse(words, byName.map((d) => d.name)) && !answer,
      },
    };
  }

  /*
   * A swap names what it wants, so only the name counts.
   *
   * The kind branches below are for "bring my jobs back". On a swap they
   * misfire: "Replace the Kudi Kitchen EXPERIENCE entry with the Rate Limit
   * Lab project" contains the word experience, which read as a request for
   * every job the app had taken off — and quietly brought Western Bell back
   * on a sentence that never mentioned it.
   *
   * Nothing, when the thing they named is not available: it is already on the
   * page, or they have no such entry. Falling through to a kind would answer
   * "put Rate Limit Lab in" with "here are all your projects".
   */
  if (swap) return null;

  const jobs = inOrder.filter((d) => d.section === 'experience');
  const projects = inOrder.filter((d) => d.section === 'projects');

  /*
   * A kind rather than a name — "bring my jobs back".
   *
   * Taken as all of that kind. Somebody asking for their jobs back after being
   * shown one is not asking for a second one, and a question here would be the
   * app being careful at the exact moment it should be sorry.
   */
  if (THE_JOBS.test(words) && jobs.length) {
    return { restore: { entries: jobs, only: nothingElse(words, jobs.map((d) => d.name)) && !answer } };
  }
  if (THE_PROJECTS.test(words) && projects.length) {
    return { restore: { entries: projects, only: nothingElse(words, projects.map((d) => d.name)) && !answer } };
  }
  if (EVERYTHING.test(words)) {
    return { restore: { entries: inOrder, only: nothingElse(words, inOrder.map((d) => d.name)) && !answer } };
  }

  if (answer) {
    const fromAnswer = named(answer);
    if (fromAnswer.length) return { restore: { entries: fromAnswer, only: false } };
    if (EVERYTHING.test(answer)) return { restore: { entries: inOrder, only: false } };
  }

  // "Put it back", with more than one thing it could be. One thing and there
  // is nothing to ask about.
  if (PRONOUN.test(words)) {
    if (inOrder.length === 1) return { restore: { entries: inOrder, only: nothingElse(words, [inOrder[0].name]) } };
    return { ask: `Which one — ${inOrder.map((d) => d.name).join(', ')}?` };
  }

  return null;
}

/**
 * Everything that could come back: what the app took off, plus anything in
 * their profile that is not on this page.
 *
 * `dropped` is the better source and stays first in the list — it holds the
 * entry as it was PRINTED, tailored wording and all, so putting it back is a
 * copy rather than a rebuild. But it only ever held what the app itself cut,
 * and somebody asking for a project they have is not asking a question about
 * the app's bookkeeping. The profile fills the rest in, in their own words.
 *
 * Matched by name, because that is what a person types and what the page
 * shows. An entry already on the page is not offered: adding a second copy of
 * something is never what "add X" meant.
 */
export function couldComeBack(
  dropped: DroppedEntry[],
  profile: { experience?: unknown[]; projects?: unknown[] } | null,
  onThePage: { experience?: unknown[]; projects?: unknown[] } | null,
): DroppedEntry[] {
  const key = (name: unknown) => String(name ?? '').trim().toLowerCase();
  const taken = new Set<string>();
  for (const d of dropped) taken.add(`${d.section}:${key(d.name)}`);

  const out = [...dropped];
  for (const section of ['experience', 'projects'] as const) {
    const here = new Set(
      ((onThePage?.[section] as any[]) ?? []).map((e) =>
        key(section === 'experience' ? e?.org : e?.name),
      ),
    );
    ((profile?.[section] as any[]) ?? []).forEach((entry, index) => {
      const name = String((section === 'experience' ? entry?.org : entry?.name) ?? '').trim();
      if (!name) return;
      const id = `${section}:${key(name)}`;
      if (taken.has(id) || here.has(key(name))) return;
      taken.add(id);
      out.push({ section, index, name, entry });
    });
  }
  return out;
}

/** The resume with those entries back where they were. */
export function withRestored<T extends { experience?: unknown; projects?: unknown }>(
  structure: T,
  entries: Restore['entries'],
): T {
  const out: Record<string, unknown> = { ...structure };
  const name = (section: 'experience' | 'projects', entry: unknown) =>
    String(((entry ?? {}) as any)[section === 'experience' ? 'org' : 'name'] ?? '')
      .trim()
      .toLowerCase();

  for (const section of ['experience', 'projects'] as const) {
    const back = entries.filter((e) => e.section === section);
    if (!back.length) continue;
    const list = [...((structure[section] as unknown[]) ?? [])];

    /*
     * Never a second copy of something already there.
     *
     * A real version 4 printed Rate Limit Lab twice. The app read "replace
     * Kudi Kitchen with Rate Limit Lab" and restored the project; the model,
     * handed the bullets by the person in the same breath, wrote the entry
     * out as well. Both were right on their own and the page had the project
     * under two headings.
     *
     * The copy on the page wins. It is the one that has been through the
     * tailoring, the honesty check and the guard, where this one is a splice
     * of an older version.
     */
    const here = new Set(list.map((entry) => name(section, entry)).filter(Boolean));

    // Lowest index first, so each insertion leaves the later ones still
    // pointing where they meant to. Past the end is appended rather than
    // refused — the page has changed since, and a job at the bottom is worth
    // more than a job nowhere.
    for (const entry of [...back].sort((a, b) => a.index - b.index)) {
      const key = name(section, entry.entry);
      if (key && here.has(key)) continue;
      if (key) here.add(key);
      list.splice(Math.min(entry.index, list.length), 0, entry.entry);
    }
    out[section] = list;
  }
  return out as T;
}

/** How the change log says what came back. */
export function restoreLine(entries: Restore['entries']): string {
  const names = entries.map((e) => e.name);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `Put ${list} back, as ${names.length === 1 ? 'it was' : 'they were'} before the page limit took ${
    names.length === 1 ? 'it' : 'them'
  } off.`;
}
