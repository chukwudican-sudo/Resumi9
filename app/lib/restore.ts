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

const ASKING_BACK = /\b(?:add|put|bring|restore|reinstate|return|want|need)\b/i;
const BACK = /\bback\b|\brestor\w*|\breinstat\w*/i;
const EVERYTHING = /\b(?:all|everything|every\s+one|the\s+lot|them\s+all|all\s+of\s+(?:them|it))\b/i;
const THE_JOBS = /\b(?:jobs?|roles?|experiences?|positions?|work\s+history)\b/i;
const THE_PROJECTS = /\b(?:projects?)\b/i;
const PRONOUN = /\b(?:it|them|those|these|that|the\s+ones?)\b/i;

/** Words that can be left over without meaning something else was asked for. */
const FILLER =
  /\b(?:please|pls|can|could|would|you|i|my|me|the|a|an|to|and|also|just|now|ok|okay|thanks|thank|want|need|like|add|put|bring|restore|reinstate|return|back|again|onto|on|in|into|resume|page|it|them|those|these|that|ones?|all|everything)\b/gi;

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
  if (!ASKING_BACK.test(words) || !BACK.test(words)) return null;

  const inOrder = [...dropped].sort((a, b) => a.index - b.index);
  const named = (from: string) => inOrder.filter((d) => d.name && patternFor(d.name).test(from));

  // A name wins over everything: "put Droady back" is not ambiguous because
  // the sentence also contains the word "jobs".
  const byName = named(words);
  if (byName.length) {
    return { restore: { entries: byName, only: nothingElse(words, byName.map((d) => d.name)) && !answer } };
  }

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

/** The resume with those entries back where they were. */
export function withRestored<T extends { experience?: unknown; projects?: unknown }>(
  structure: T,
  entries: Restore['entries'],
): T {
  const out: Record<string, unknown> = { ...structure };
  for (const section of ['experience', 'projects'] as const) {
    const back = entries.filter((e) => e.section === section);
    if (!back.length) continue;
    const list = [...((structure[section] as unknown[]) ?? [])];
    // Lowest index first, so each insertion leaves the later ones still
    // pointing where they meant to. Past the end is appended rather than
    // refused — the page has changed since, and a job at the bottom is worth
    // more than a job nowhere.
    for (const entry of [...back].sort((a, b) => a.index - b.index)) {
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
