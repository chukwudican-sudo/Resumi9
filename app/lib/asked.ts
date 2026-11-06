import { clauseAt } from './clauses';
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
 * Removal, meaning it and nothing else — including a swap.
 *
 * "replace", "swap" and "substitute" are removals of the thing named on the
 * OUTGOING side, which is what outgoingHalf below is for. Without them,
 * "replace the Kudi Kitchen job with the Rate Limit Lab project" licensed
 * nothing, the guard put Kudi Kitchen back, and the person was told their own
 * instruction had been undone.
 *
 * "cut" is deliberately absent: "cut the Aegon bullets down to two" is a length
 * request, and a word that means both cannot license a deletion. It is picked up
 * by MAYBE below instead, which asks rather than acts.
 */
const REMOVAL =
  /\b(remove|removing|removed|delete|deleting|deleted|drop|dropping|dropped|get rid of|getting rid of|take\s+(?:[\w'’-]+\s+){0,4}out|leave out|leaving out|exclude|excluding|omit|omitting|scrap|scrapping|replace|replacing|replaced|swap|swapping|substitute|substituting|instead\s+of|in\s+place\s+of)\b/i;

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
/**
 * What may sit between two names for them to be one list.
 *
 * Commas, "and", "&", "plus", and the small words that hang off a name. A
 * VERB between them means the second name belongs to a different clause:
 * "remove Aegon and shorten Droady" is not a list of two removals, and that
 * distinction is the only thing making this safe to read at all.
 */
const GLUE = /^[\s,;&]*(?:and|&|plus|also|as\s+well\s+as)?[\s,;&]*(?:the|my|that)?\s*$/i;

const PART =
  /\b(bullets?|lines?|points?|sentences?|clauses?|words?|phrases?|parts?|bits?|mentions?|references?|details?|numbers?|metrics?|percentages?|dates?|titles?|summary|sections?|skills?)\b/i;

/** Which kind of entry the instruction is talking about, when it says. */
const KIND: Record<EntryKind, RegExp> = {
  // "experience" was missing, and it is the word the app's own editor uses for
  // the section: "Replace the Kudi Kitchen experience entry with the Rate
  // Limit Lab project" named its kind precisely and was read as naming none.
  experience: /\b(jobs?|roles?|positions?|compan(?:y|ies)|employers?|gigs?|internships?|experiences?|work\s+history)\b/i,
  projects: /\b(projects?)\b/i,
  education: /\b(degrees?|schools?|universit(?:y|ies)|education)\b/i,
};

/** Talk about skills, which lets a bare term be read as one. */
const SKILL_NOUN = /\b(skills?|tech|technolog\w*|stack|languages?|tools?)\b/i;

/** A date is being talked about, rather than a year appearing in passing. */
const DATE_NOUN = /\b(dates?|ended?|ending|started?|starting|until|since|graduat\w*|finish\w*)\b/i;
const NOW = /\b(present|current|currently|now|ongoing)\b/i;

const SUMMARY = /\b(summary|profile statement|objective)\b/i;

/**
 * A sentence that puts one thing in and takes another out.
 *
 * Both halves name an entry and each half means the opposite, so reading the
 * sentence whole mixes them. "Replace the Kudi Kitchen experience entry with
 * the Rate Limit Lab project" says "project" about the thing coming IN, and
 * read as one sentence that narrowed the removal to projects and let the job
 * he named for removal through untouched.
 */
const SWAP_OUT_BEFORE = /\b(?:replace|replacing|replaced|swap|swapping|substitute|substituting)\b[\s\S]*?\b(with|for)\b/i;
const SWAP_OUT_AFTER = /\b(?:instead\s+of|in\s+place\s+of)\b/i;

/** The stretch of a sentence that says what to take OUT. */
function outgoingHalf(text: string): { from: number; to: number } {
  const before = SWAP_OUT_BEFORE.exec(text);
  if (before) return { from: 0, to: before.index + before[0].length - before[1].length };
  const after = SWAP_OUT_AFTER.exec(text);
  if (after) return { from: after.index + after[0].length, to: text.length };
  return { from: 0, to: text.length };
}

/** What to call an entry when its name alone cannot tell two of them apart. */
const KIND_NOUN: Record<EntryKind, string> = {
  experience: 'job',
  projects: 'project',
  education: 'degree',
};
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

/**
 * Where this name first appears in the text, and where it ends, or -1.
 *
 * The END matters as much as the start, and only the written form gives it:
 * "WesternBell International Ltd." is thirty characters of stored name and
 * eleven of what somebody typed. Measured by the stored length, the gap after
 * it ran past the next name entirely — which read "get rid of the WesternBell
 * job but keep Aegon" as a list of two removals.
 */
function foundAt(text: string, name: string): { at: number; end: number } {
  const all = everyMention(text, name);
  return all[0] ?? { at: -1, end: -1 };
}

/**
 * Every place a name appears, not only the first.
 *
 * One occurrence was enough until an answer began to be read alongside the
 * question it answers. The route puts the answer FIRST — "remove it
 * completely" has to precede "cut the Aegon job" or the verb has no name
 * after it — and that ordering breaks the moment the answer contains the name
 * as well: "The Kudi Kitchen project" + "Remove the Kudi Kitchen entry…" put
 * the only recorded position before the verb, so nothing was licensed, the
 * guard put the project back, and the person was told their answer had
 * changed nothing.
 *
 * Both occurrences are the same entry. Which one the verb is acting on is the
 * caller's decision, and it cannot make it from a single index.
 */
function everyMention(text: string, name: string): { at: number; end: number }[] {
  const out: { at: number; end: number }[] = [];
  for (const way of namesOf(name)) {
    const scan = new RegExp(patternFor(way).source, 'gi');
    for (let found = scan.exec(text); found; found = scan.exec(text)) {
      const at = found.index;
      const end = at + found[0].length;
      // A longer spelling found at the same place wins: "Kudi Kitchen" over
      // the "Kudi" inside it, so the span used for the glue test is right.
      const seen = out.findIndex((o) => o.at === at);
      if (seen < 0) out.push({ at, end });
      else if (end > out[seen].end) out[seen] = { at, end };
      if (scan.lastIndex === at) scan.lastIndex += 1;
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Where this name first appears in the text, or -1. */
function whereNamed(text: string, name: string): number {
  return foundAt(text, name).at;
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

  /*
   * "instead of" is a removal, except when it is a refusal of one.
   *
   * "use the Rate Limit Lab project instead of the Kudi Kitchen job" takes
   * Kudi Kitchen off. "instead of removing Aegon, shorten it" says the
   * opposite, in the same words, and granting that would delete a job the
   * person had just asked to keep — the worst thing in this file. The two are
   * told apart by what follows: a noun phrase is the thing going, a removal
   * verb is the thing being refused.
   */
  const INSTEAD_OF_REMOVING = /\b(?:instead\s+of|in\s+place\s+of)\s+(?:\w+\s+){0,2}?(?:remov|delet|drop|cut|los|tak)/i;
  const removal = (() => {
    const found = REMOVAL.exec(words);
    if (!found) return null;
    if (!/^(?:instead|in)\b/i.test(found[0]) || !INSTEAD_OF_REMOVING.test(words)) return found;
    // Look past it for a real one: "instead of removing Aegon, delete Droady".
    const rest = REMOVAL.exec(words.slice(found.index + found[0].length));
    if (!rest) return null;
    rest.index += found.index + found[0].length;
    return rest;
  })();
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
  /**
   * Every entry this instruction names, at EVERY place it names it.
   *
   * A name said twice is one entry mentioned twice, and which mention a verb
   * is acting on is decided below by position. Recording only the first put
   * an answer's copy of the name ahead of the instruction's verb and licensed
   * nothing at all.
   */
  const named: { at: number; end: number; grant: Grant }[] = [];
  for (const kind of ['experience', 'projects'] as EntryKind[]) {
    for (const entry of source[kind] ?? []) {
      const name = kind === 'experience' ? (entry as { org: string }).org : (entry as { name: string }).name;
      for (const { at, end } of everyMention(words, name)) named.push({ at, end, grant: { kind, name } });
    }
  }

  const grants: Grant[] = [];
  let tied: string[] = [];
  if (removal && !refused && !aboutParts) {
    /*
     * The NAME wins, and a kind word only breaks a tie between two of them.
     *
     * It used to filter candidates by any kind word anywhere in the sentence,
     * and a real instruction broke on it: "Replace the Kudi Kitchen
     * experience entry with the Rate Limit Lab project" says "project" about
     * the thing coming IN, which narrowed the removal to projects and
     * excluded the job being named for removal. Nothing was licensed, the
     * guard put Kudi Kitchen straight back, and the person was told their own
     * instruction had been undone.
     *
     * A kind word still decides "remove the Kudi Kitchen project" where Kudi
     * Kitchen is both a job and a project — but that is a tie between two
     * entries at the same position, which is the only thing it is good for.
     *
     * Education is never a candidate. A degree is not something an edit to
     * one application should remove; the profile is where it lives.
     */
    /*
     * Only the half of the sentence that says what to take OUT.
     *
     * On a swap the other half is about the thing coming in, and its kind
     * word belongs to that thing. See outgoingHalf.
     */
    const out = outgoingHalf(words);
    const inScope = (at: number) => at >= out.from && at < out.to;
    const kindsHere = (Object.keys(KIND) as EntryKind[]).filter((kind) =>
      KIND[kind].test(words.slice(out.from, out.to)),
    );

    /*
     * One grant per removal verb, because a sentence can ask twice.
     *
     * "Delete the second, duplicate Rate Limit Lab entry and remove Kudi
     * Kitchen" is two removals, and reading only the first left the second
     * unlicensed: the guard put Kudi Kitchen back and the person was told
     * their instruction had been undone, for the second time in a row.
     *
     * Each verb takes the nearest entry after it that no earlier verb has
     * already claimed, so the two do not both land on the same name.
     */
    const verbs = [...words.matchAll(new RegExp(REMOVAL.source, 'gi'))];
    for (const at of verbs) {
      const from = at.index ?? 0;
      // Negation is per verb: "instead of removing Aegon, delete Droady"
      // licenses neither, and "remove Aegon, don't touch Droady" licenses one.
      if (negated(from)) continue;

      const taken = new Set(grants.map((g) => `${g.kind}:${norm(g.name)}`));
      const after = named
        .filter(
          (n) =>
            n.at > from &&
            n.grant.kind !== 'education' &&
            inScope(n.at) &&
            !taken.has(`${n.grant.kind}:${norm(n.grant.name)}`),
        )
        .sort((a, b) => a.at - b.at);
      const nearest = after[0];
      const sharing = after.filter((f) => f.at === nearest?.at);

      /*
       * The kind word that breaks a tie is the one in THIS verb's clause.
       *
       * Read across the whole sentence, a second request supplies words about
       * its own subject. "Remove the Kudi Kitchen entry from Technical
       * Projects only. Keep the Kudi Kitchen job in Experience." says
       * "projects" in one clause and "job" in the other, and this profile has
       * a Kudi Kitchen in both sections — so both kinds were in play, the tie
       * stood, and the app asked "which one — the job or the project?" about
       * a sentence whose first four words had answered it. The person
       * answered, the removal was still never licensed, and the guard put the
       * project back twice.
       *
       * The sentence-wide reading stays as the fallback: where the clause
       * says no kind, whatever the sentence says is still better than nothing.
       */
      const here = clauseAt(words, from);
      const kindsInClause = (Object.keys(KIND) as EntryKind[]).filter((kind) => KIND[kind].test(here));
      const deciding = kindsInClause.length ? kindsInClause : kindsHere;

      const narrowed = deciding.length
        ? sharing.filter((f) => deciding.includes(f.grant.kind))
        : sharing;
      const candidates = narrowed.length ? narrowed : sharing;

    /*
     * Two entries with the same name in the same section are one duplicate,
     * not a choice. Asking "Rate Limit Lab or Rate Limit Lab?" is what a real
     * version 4 did, on a page that had the project under two headings.
     */
      const distinct = candidates.filter(
        (f, i) =>
          candidates.findIndex(
            (other) => other.grant.kind === f.grant.kind && norm(other.grant.name) === norm(f.grant.name),
          ) === i,
      );
      if (distinct.length === 1) {
        grants.push(distinct[0].grant);

        /*
         * And anything listed after it with nothing but glue between.
         *
         * "remove Aegon and Droady" is one verb and two entries, and taking
         * only the nearest left the second unlicensed — the guard put it back
         * and the person was told their instruction had been undone. The glue
         * test is what keeps this safe: a verb between the two names means
         * the second belongs to another clause.
         */
        let previous = distinct[0];
        for (const next of after) {
          if (next.at <= previous.at) continue;
          if (!GLUE.test(words.slice(previous.end, next.at))) break;
          // Two entries at one spot is the ambiguous case, not a list.
          if (after.some((other) => other.at === next.at && other.grant.kind !== next.grant.kind)) break;
          if (!grants.some((g) => g.kind === next.grant.kind && norm(g.name) === norm(next.grant.name))) {
            grants.push(next.grant);
          }
          previous = next;
        }
      }
      else if (distinct.length > 1 && !grants.length && !tied.length) {
      /*
       * Named by kind where the name cannot tell them apart.
       *
       * "Which one — Kudi Kitchen or Kudi Kitchen?" is a real question this
       * asked, about a name that is both a job and a project. The answer it
       * wanted was the kind, and it never said so.
       */
        const names = distinct.map((f) => f.grant.name);
        const collides = new Set(names.map(norm)).size < names.length;
        tied = distinct.map((f) => (collides ? `the ${f.grant.name} ${KIND_NOUN[f.grant.kind]}` : f.grant.name));
      }
    }
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
  if (!refused && !grants.length) {
    if (tied.length > 1) {
      ask = `Which one — ${listOf(tied, 'or')}?`;
    } else if (removal && aboutParts && named.length === 0 && everything.length > 1) {
      /*
       * No list of names. Listing them said "you have" and then named six of
       * ten, which is false — and the entries are on the page beside the
       * question anyway, so naming them was redundant as well as wrong.
       */
      ask = 'Which entry? Name the job or project.';
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

    removes: (kind, name) => grants.some((g) => g.kind === kind && norm(g.name) === norm(name)),

    /*
     * Worded as a removal and not acted on. "Cut the Aegon job" lands here: the
     * word means both "delete" and "make shorter", so it restores — and then
     * says so, with the wording that would have worked. A false refusal costs
     * one free edit; a false deletion can reach an employer.
     */
    nearlyRemoves: (name) => {
      if (!verb || refused || aboutParts) return false;
      if (grants.some((g) => norm(g.name) === norm(name))) return false;
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
