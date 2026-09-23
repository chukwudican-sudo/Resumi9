import { MONTHS, parseDates } from './entryFormat';
import { patternFor, waysOfWriting } from './requirementMatch';
import type { ResumeStructure } from './types';

/**
 * What the person's own instruction gives permission for.
 *
 * The checks that run after an edit — the honesty pass and the guard — were
 * built to catch the model inventing claims and dropping entries, and they
 * catch real ones. What neither could tell is the difference between the model
 * doing something on its own and the person asking for it. So "remove the Aegon
 * job" removed the job and the guard put it straight back, with a message
 * blaming "the tailoring" on a screen that quotes the instruction directly
 * above it. Same for a skill, a summary, a date, and any fact the person
 * supplied themselves.
 *
 * This reads the instruction once and answers what it licenses. Everything
 * downstream keeps its judgement; it just stops applying it to things that were
 * asked for.
 *
 * **Lexical, and no model call.** The same argument honesty.ts makes for being
 * arithmetic: an edit runs inside one request budget, and a permission decision
 * nobody can audit is worse than one that is wrong in a known direction.
 *
 * **It refuses when unsure, and the refusal is answerable.** A restored entry is
 * visible the moment somebody reads their own resume; a job silently missing
 * from a resume they send is not. So an unclear removal restores and says so —
 * see `nearlyRemoves`, which is what puts a one-tap "yes, remove it" beside the
 * notice.
 */

export type EntryKind = 'experience' | 'projects' | 'education';

export interface Asked {
  /** The instruction verbatim, or "". The honesty check reads it as evidence. */
  readonly words: string;
  /** They asked for this entry to go. */
  removes(kind: EntryKind, name: string): boolean;
  /** They worded a removal for this name, too loosely to act on. */
  nearlyRemoves(name: string): boolean;
  /** They asked for this skill term to go. */
  removesSkill(term: string): boolean;
  /** They asked for this entry's dates, AND the model returned what they said. */
  allowsDates(name: string, returned: string | null | undefined): boolean;
  readonly wantsSummary: boolean;
  readonly dropsSummary: boolean;
  /**
   * They worded a removal of some kind, anywhere in the instruction.
   *
   * Coarse on purpose, and used for one thing: whether the app may leave an
   * entry with no bullets. Forcing bullets back is right when the model emptied
   * something on its own and wrong when somebody asked for it — and "remove the
   * coursework line" names no entry, so nothing finer would catch it.
   */
  readonly askedForRemoval: boolean;
  /**
   * A question to put to the person before anything is done, or null.
   *
   * The app guessed where it should have asked: "drop the second bullet"
   * silently took Droady's, because Droady happened to be first. Asking costs
   * nothing here — no model call, no edit, no wait — so where the app can see
   * the ambiguity itself, it says so instead of picking.
   */
  readonly ask: string | null;
}

/**
 * Removal, meaning it and nothing else.
 *
 * "cut" is deliberately absent: "cut the Aegon bullets down to two" is a length
 * request, and a word that means both cannot license a deletion. It is picked up
 * by MAYBE below instead, which asks rather than acts.
 */
const REMOVAL =
  /\b(remove|removing|removed|delete|deleting|deleted|drop|dropping|dropped|get rid of|getting rid of|take\s+(?:[\w'’-]+\s+){0,4}out|leave out|leaving out|exclude|excluding|omit|omitting|scrap|scrapping)\b/i;

/** Wording that might be a removal. Enough to ask about, never enough to act. */
const MAYBE = /\b(cut|cutting|lose|losing|ditch|ditching|without|no longer)\b/i;

/**
 * The half of MAYBE that is worth a question.
 *
 * "Cut the Aegon job" means two things and deserves asking. "No longer at
 * WesternBell" means the job ended — asking whether to delete it would be
 * offering the wrong two answers, and "without" is usually about wording.
 */
const MEANS_BOTH = /\b(cut|cutting|lose|losing|ditch|ditching)\b/i;

/** Anything that turns the sentence into a refusal or a question about one. */
const NEGATION = /\b(don'?t|do not|never|instead of|rather than|avoid|stop|not)\b/i;
const ASKING = /^\s*(why|what|how|did|does|do|can|could|should|is|are|was|were|would)\b/i;

/**
 * Words naming a PART of an entry rather than the entry.
 *
 * The one clause that makes this safe. "Remove the second bullet from Droady"
 * has a removal verb and an employer in it, and would otherwise license deleting
 * the job. It is also why the app's own suggestion chips — "drop the second
 * bullet", "shorten the Aegon bullets" — keep working rather than becoming a
 * button that deletes somebody's employment history.
 */
const PART =
  /\b(bullets?|lines?|points?|sentences?|clauses?|words?|phrases?|parts?|bits?|mentions?|references?|details?|numbers?|metrics?|percentages?|dates?|titles?|summary|sections?|skills?)\b/i;

/** Which kind of entry the instruction is talking about, when it says. */
const KIND: Record<EntryKind, RegExp> = {
  experience: /\b(jobs?|roles?|positions?|compan(?:y|ies)|employers?|gigs?|internships?)\b/i,
  projects: /\b(projects?)\b/i,
  education: /\b(degrees?|schools?|universit(?:y|ies)|education)\b/i,
};

/** Talk about skills, which lets a bare term be read as one. */
const SKILL_NOUN = /\b(skills?|tech|technolog\w*|stack|languages?|tools?)\b/i;

/** A date is being talked about, rather than a year appearing in passing. */
const DATE_NOUN = /\b(dates?|ended?|ending|started?|starting|until|since|graduat\w*|finish\w*)\b/i;
const NOW = /\b(present|current|currently|now|ongoing)\b/i;

const SUMMARY = /\b(summary|profile statement|objective)\b/i;
const ADDING = /\b(add|adds|adding|write|writing|include|including|put|create|creating|give|need|want)\b/i;

/** Words too generic to identify a company by their first token alone. */
const SUFFIX = new Set([
  'inc', 'ltd', 'llc', 'corp', 'corporation', 'group', 'labs', 'technologies',
  'solutions', 'systems', 'co', 'company', 'university', 'college', 'international', 'the',
]);

const norm = (text: string | null | undefined) => (text ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * The ways this entry's name might be written in a sentence.
 *
 * A full name first, then its leading word — "Aegon" for "Aegon Asset
 * Management" — because nobody types an employer's legal name into a one-line
 * instruction. The same caution as the guard's `byContainedName`: long enough to
 * mean something, and never a word every company has.
 */
function namesOf(name: string): string[] {
  const full = name.trim();
  if (!full) return [];
  const ways = [full];
  const first = full.split(/[\s,/&–—-]+/).filter(Boolean)[0] ?? '';
  const bare = first.replace(/[.]/g, '');
  if (bare.length >= 4 && !SUFFIX.has(bare.toLowerCase())) ways.push(bare);
  return ways;
}

/** Where this name first appears in the text, or -1. */
function whereNamed(text: string, name: string): number {
  let at = -1;
  for (const way of namesOf(name)) {
    const found = patternFor(way).exec(text);
    if (found && (at < 0 || found.index < at)) at = found.index;
  }
  return at;
}

/** Whether a term is said in the text, with the matchers the rest of the app uses. */
const saidIn = (text: string, term: string) =>
  waysOfWriting(term).some((way) => patternFor(way).test(text));

interface Grant {
  kind: EntryKind;
  name: string;
}

/**
 * Reads one instruction against the resume it will be applied to.
 *
 * `source` is needed because deciding WHICH entry was meant — and whether two
 * of them answer to the same words — can only be done against the real list.
 * Resolving once here keeps every predicate below a plain lookup.
 */
export function readInstruction(text: string, source: ResumeStructure): Asked {
  const words = (text ?? '').trim();
  if (!words) return NOTHING_ASKED;

  const removal = REMOVAL.exec(words);
  const maybe = MAYBE.exec(words);
  const verb = removal ?? maybe;

  /*
   * A question, or a sentence saying NOT to do something, licenses nothing.
   * "Why did you remove the Aegon job?" and "don't remove the Aegon job" both
   * carry the verb and the name, and both mean the opposite of the grant.
   *
   * Negation is looked for just before the verb rather than anywhere, so
   * "remove the Aegon job, don't touch anything else" still works.
   */
  const negated = (at: number) => NEGATION.test(words.slice(Math.max(0, at - 28), at));
  const refused = !verb || words.trimEnd().endsWith('?') || ASKING.test(words) || negated(verb.index);

  const aboutParts = PART.test(words);
  const kindsNamed = (Object.keys(KIND) as EntryKind[]).filter((kind) => KIND[kind].test(words));

  /*
   * One entry, and only when it is unmistakable: a removal verb, no part-word
   * anywhere, the kind agreeing where it is stated, and exactly one name
   * closest after the verb. Two names landing on the same spot — "remove Bell"
   * with two Bell-ish employers — resolves to nothing rather than to a guess.
   *
   * Education is never granted here. A degree is not something an edit to one
   * application should remove; the profile is where it lives.
   */
  /** Every entry this instruction names, wherever in the sentence it sits. */
  const named: { at: number; grant: Grant }[] = [];
  for (const kind of ['experience', 'projects'] as EntryKind[]) {
    for (const entry of source[kind] ?? []) {
      const name = kind === 'experience' ? (entry as { org: string }).org : (entry as { name: string }).name;
      const at = whereNamed(words, name);
      if (at >= 0) named.push({ at, grant: { kind, name } });
    }
  }

  let grant: Grant | null = null;
  let tied: string[] = [];
  if (removal && !refused && !aboutParts) {
    const wanted: EntryKind[] = kindsNamed.length
      ? kindsNamed.filter((kind) => kind !== 'education')
      : ['experience', 'projects'];

    const after = named
      .filter((n) => n.at > removal.index && wanted.includes(n.grant.kind))
      .sort((a, b) => a.at - b.at);
    const nearest = after[0];
    const sharing = after.filter((f) => f.at === nearest?.at);
    if (nearest && sharing.length === 1) grant = nearest.grant;
    else if (sharing.length > 1) tied = sharing.map((f) => f.grant.name);
  }

  /*
   * What to ask, when the app can see the ambiguity for itself.
   *
   * Three cases, and only three: a removal aimed at a part of something with no
   * entry named at all; a word that means both delete and shorten; and two
   * entries answering the same words. Anything vaguer than this the model will
   * be asked to notice — a word list cannot cover how many ways people are
   * vague, and a question nobody needed is worse than no question.
   */
  const everything = [
    ...(source.experience ?? []).map((e) => e.org),
    ...(source.projects ?? []).map((p) => p.name),
  ].filter((name) => typeof name === 'string' && name.trim());

  let ask: string | null = null;
  if (!refused && !grant) {
    if (tied.length > 1) {
      ask = `Which one — ${listOf(tied, 'or')}?`;
    } else if (removal && aboutParts && named.length === 0 && everything.length > 1) {
      ask = `Which one? You have ${listOf(everything.slice(0, 6))}.`;
    } else if (!removal && MEANS_BOTH.test(words) && !aboutParts && named.length === 1) {
      ask = `Do you want ${named[0].grant.name} removed completely, or just shortened?`;
    }
  }

  /** Skills are looser: the whole blast radius is one word in a comma list. */
  const skillsLicensed =
    Boolean(removal) && !refused && (SKILL_NOUN.test(words) || kindsNamed.length === 0);

  const wantsSummary = SUMMARY.test(words) && ADDING.test(words) && !NEGATION.test(words);
  const dropsSummary = SUMMARY.test(words) && Boolean(removal) && !refused;

  /** A date the instruction actually states, rather than a year in passing. */
  const statesDate = DATE_NOUN.test(words) && (/\b(19|20)\d{2}\b/.test(words) || NOW.test(words) || monthIn(words) > 0);

  return {
    words,

    removes: (kind, name) => Boolean(grant) && grant!.kind === kind && norm(grant!.name) === norm(name),

    /*
     * Worded as a removal and not acted on. "Cut the Aegon job" lands here: the
     * word means both "delete" and "make shorter", so it restores — and then
     * says so, with the wording that would have worked. A false refusal costs
     * one free edit; a false deletion can reach an employer.
     */
    nearlyRemoves: (name) => {
      if (!verb || refused || aboutParts) return false;
      if (grant && norm(grant.name) === norm(name)) return false;
      const at = whereNamed(words, name);
      return at > verb.index;
    },

    removesSkill: (term) => skillsLicensed && saidIn(words, term),

    /*
     * Both halves have to hold: they named this entry's dates AND the model
     * returned what they said. A date is the one thing on a resume that looks
     * right when it is wrong, so "change my Droady end date to Aug 2026" coming
     * back as something else is still reverted.
     */
    allowsDates: (name, returned) => {
      if (!statesDate || !returned) return false;
      const at = whereNamed(words, name);
      if (at < 0) return false;
      const others = [
        ...(source.experience ?? []).map((e) => e.org),
        ...(source.projects ?? []).map((p) => p.name),
      ].filter((other) => norm(other) !== norm(name) && whereNamed(words, other) >= 0);
      if (others.length) return false;
      return agrees(words, returned);
    },

    wantsSummary,
    dropsSummary,
    askedForRemoval: Boolean(removal) && !refused,
    ask,
  };
}

/** "a, b and c" — for putting a person's own entry names back to them. */
function listOf(names: string[], joiner = 'and'): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} ${joiner} ${names[names.length - 1]}`;
}

/** The month named in the text, 1-12, or 0. */
function monthIn(text: string): number {
  for (let i = 0; i < MONTHS.length; i += 1) {
    const full = MONTHS[i];
    if (new RegExp(`\\b(${full}|${full.slice(0, 3)})\\b`, 'i').test(text)) return i + 1;
  }
  return 0;
}

/** Whether the dates that came back are the ones the instruction asked for. */
function agrees(words: string, returned: string): boolean {
  const parts = parseDates(returned);
  const years = [parts.startYear, parts.endYear].filter((y): y is number => Boolean(y));
  const months = [parts.startMonth, parts.endMonth].filter((m): m is number => Boolean(m));

  const wantedYears = [...words.matchAll(/\b(?:19|20)\d{2}\b/g)].map((m) => Number(m[0]));
  const wantedMonth = monthIn(words);
  const wantsNow = NOW.test(words);

  if (wantsNow && !parts.isCurrent) return false;
  if (wantedYears.length && !wantedYears.some((year) => years.includes(year))) return false;
  if (wantedMonth > 0 && !months.includes(wantedMonth)) return false;
  return wantedYears.length > 0 || wantedMonth > 0 || wantsNow;
}

/**
 * Nothing was asked, which is every tailor and any edit without an instruction.
 *
 * The default everywhere downstream, so a path that does not know about
 * instructions behaves exactly as it did before this file existed.
 */
export const NOTHING_ASKED: Asked = {
  words: '',
  removes: () => false,
  nearlyRemoves: () => false,
  removesSkill: () => false,
  allowsDates: () => false,
  wantsSummary: false,
  dropsSummary: false,
  askedForRemoval: false,
  ask: null,
};
