import { patternFor, waysOfWriting } from './requirementMatch';
import { splitTerms } from './names';
import type { ResumeStructure } from './types';

/**
 * What one instruction is allowed to change.
 *
 * An edit is asked for in one sentence and returns the WHOLE resume, and the
 * prompt asking it to touch only the relevant field is the only thing that has
 * ever held it to that. It does not always hold: the first revision anybody
 * tried came back with a corrupted project, and a rewrite of something nobody
 * mentioned is impossible to spot — you have to read thirty bullets against a
 * version you no longer have on screen to find it.
 *
 * So the app decides the blast radius and enforces it. Whatever the sentence
 * names is in scope; everything else is put back exactly as it was, byte for
 * byte, and the person is told what was held.
 *
 * **Mentioning counts, not just naming.** "remove Docker" is about the skills
 * line AND about any bullet that says Docker — scoping it to skills alone would
 * leave the word on the page in the two places it was actually read.
 *
 * **Unclear means unscoped.** A sentence that names nothing the app can find —
 * "make it more concise", "fix the typos" — is about the whole page, and
 * freezing everything would be worse than freezing nothing. The rule only ever
 * narrows what an edit may touch when it can say what the sentence was about.
 */

export interface Scope {
  /** Nothing was named, so nothing is held back. */
  readonly whole: boolean;
  /** What the sentence was about, for the sentence shown to the person. */
  readonly named: string[];
  /** Whether this part of the resume may change. */
  touches(part: 'skills' | 'summary'): boolean;
  touchesEntry(kind: 'experience' | 'projects' | 'education', name: string): boolean;
}

const SECTION: Record<'experience' | 'projects' | 'education', RegExp> = {
  experience: /\b(jobs?|roles?|positions?|compan(?:y|ies)|employers?|internships?|experience|work\s+history)\b/i,
  projects: /\b(projects?)\b/i,
  education: /\b(degrees?|schools?|universit(?:y|ies)|education|coursework|courses?)\b/i,
};
const SKILLS = /\b(skills?|tech\s+stack|technolog\w*|stack|languages?|tools?)\b/i;
const SUMMARY = /\b(summary|profile statement|objective)\b/i;

/** Words too generic to identify a company by their first token alone. */
const SUFFIX = new Set([
  'inc', 'ltd', 'llc', 'corp', 'corporation', 'group', 'labs', 'technologies',
  'solutions', 'systems', 'co', 'company', 'university', 'college', 'international', 'the',
]);

const flat = (text: string) =>
  (text ?? '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
const squash = (text: string) => flat(text).replace(/ /g, '');

/** The ways a name might be written in a sentence. Same caution as asked.ts. */
function namesOf(name: string): string[] {
  const full = (name ?? '').trim();
  if (!full) return [];
  const ways = [full];
  const first = full.split(/[\s,/&–—-]+/).filter(Boolean)[0] ?? '';
  const bare = first.replace(/[.]/g, '');
  if (bare.length >= 4 && !SUFFIX.has(bare.toLowerCase())) ways.push(bare);
  return ways;
}

/** Whether the sentence names that thing, allowing for a closed-up spelling. */
const named = (text: string, name: string) =>
  namesOf(name).some((way) => {
    if (patternFor(way).test(text)) return true;
    const loose = squash(way);
    return loose.length >= 5 && squash(text).includes(loose);
  });

const entryName = (kind: 'experience' | 'projects' | 'education', entry: any): string =>
  (kind === 'experience' ? entry?.org : kind === 'projects' ? entry?.name : entry?.school) ?? '';

const said = (text: string, term: string) =>
  waysOfWriting(term).some((way) => patternFor(way).test(text));

/**
 * What this instruction is about, read against the resume it will change.
 *
 * `all` forces the whole page, for the override offered beside the sentence
 * saying what was held: the person asked for the narrow reading and can say
 * they meant the wide one.
 */
export function readScope(instruction: string, structure: ResumeStructure, all = false): Scope {
  const text = (instruction ?? '').trim();
  const everything: Scope = {
    whole: true,
    named: [],
    touches: () => true,
    touchesEntry: () => true,
  };
  if (!text || all) return everything;

  const sections = (Object.keys(SECTION) as (keyof typeof SECTION)[]).filter((kind) =>
    SECTION[kind].test(text),
  );
  const skillsNamed = SKILLS.test(text);
  const summaryNamed = SUMMARY.test(text);

  /*
   * Terms the sentence names that are in their skills, which is how "remove
   * Docker" is recognised as being about skills without the word "skills" in
   * it — and, below, how it reaches the bullets that say Docker too.
   */
  const terms: string[] = [];
  for (const group of structure.skills ?? []) {
    for (const item of splitTerms(String(group?.items ?? ''))) {
      if (said(text, item)) terms.push(item);
    }
    const category = (group?.category ?? '').trim();
    if (category && named(text, category)) terms.push(category);
  }

  const entries: { kind: 'experience' | 'projects' | 'education'; name: string }[] = [];
  for (const kind of ['experience', 'projects', 'education'] as const) {
    for (const entry of (structure[kind] as any[]) ?? []) {
      const name = entryName(kind, entry);
      if (!name) continue;
      if (named(text, name)) entries.push({ kind, name });
    }
  }

  // Nothing the app can point at. The whole page, as before.
  if (!entries.length && !sections.length && !skillsNamed && !summaryNamed && !terms.length) {
    return everything;
  }

  /*
   * Entries that MENTION what was named, which is the half that scoping by
   * name alone gets wrong. "remove Docker" is about the skills line and about
   * the two bullets that say Docker; holding those frozen would leave the word
   * on the page in the places somebody actually reads it.
   */
  const mentions = new Set<string>();
  for (const kind of ['experience', 'projects', 'education'] as const) {
    for (const entry of (structure[kind] as any[]) ?? []) {
      const name = entryName(kind, entry);
      const body = [entry?.title, entry?.tech, ...(entry?.bullets ?? [])].filter(Boolean).join(' \n ');
      if (terms.some((term) => said(body, term))) mentions.add(`${kind}:${flat(name)}`);
    }
  }

  const inScope = new Set(entries.map((e) => `${e.kind}:${flat(e.name)}`));
  const named_ = [
    ...entries.map((e) => e.name),
    ...terms,
    ...sections.map((s) => (s === 'experience' ? 'your jobs' : s === 'projects' ? 'your projects' : 'your education')),
    ...(skillsNamed && !terms.length ? ['your skills'] : []),
  ];

  return {
    whole: false,
    named: [...new Set(named_)],
    // A named term is a reason to touch skills even with no section word in
    // the sentence: "don't use ChatGPT anywhere" is about the skills line.
    touches: (part) => (part === 'skills' ? skillsNamed || terms.length > 0 : summaryNamed),
    touchesEntry: (kind, name) =>
      sections.includes(kind) ||
      inScope.has(`${kind}:${flat(name)}`) ||
      mentions.has(`${kind}:${flat(name)}`),
  };
}

/**
 * The edit, with everything out of scope put back as it was.
 *
 * Compared and restored whole — an out-of-scope entry is replaced by the
 * previous version's object, not patched field by field, so a changed date, a
 * changed title and a changed bullet are all covered by one rule rather than
 * by a list of fields somebody has to remember to extend.
 */
export function onlyWhereAsked(
  previous: ResumeStructure,
  edited: ResumeStructure,
  scope: Scope,
): { structure: ResumeStructure; frozen: string[] } {
  if (scope.whole) return { structure: edited, frozen: [] };

  const frozen: string[] = [];
  const out: ResumeStructure = { ...edited };

  for (const kind of ['experience', 'projects', 'education'] as const) {
    const before = ((previous[kind] as any[]) ?? []).slice();
    const after = ((edited[kind] as any[]) ?? []).slice();

    /*
     * Matched by name rather than by position, because an edit may reorder —
     * and an entry that is missing from the edit entirely is restored too: a
     * deletion nobody asked for is the change this is most worth stopping.
     */
    const kept: any[] = [];
    const used = new Set<number>();
    for (const old of before) {
      const name = entryName(kind, old);
      const at = after.findIndex((entry, i) => !used.has(i) && flat(entryName(kind, entry)) === flat(name));
      if (scope.touchesEntry(kind, name)) {
        /*
         * In scope and gone: the person asked for it to go, so it goes.
         *
         * This branch used to fall back to `old` whenever the entry was
         * missing, which quietly put back every deletion the sentence had
         * just licensed. "Replace the Kudi Kitchen project with Resumi"
         * returned a resume with both — the guard had allowed the removal and
         * logged "Kudi Kitchen: removed, as you asked", and this line undid it
         * one pass later without saying so. Same bug for every swap: the thing
         * being replaced never left, and the fitter cut bullets elsewhere to
         * make room for an entry that should have taken its place.
         *
         * Deciding whether a removal was asked for is NOT this pass's job and
         * never was. The guard is the gate: `restoreMissing` puts an entry
         * back unless `asked.removes` granted it, so anything still missing by
         * the time it reaches here has already been through that test. Scoping
         * is about what the model changed on its own initiative — a deletion
         * the guard let through is not that.
         */
        if (at < 0) continue;
        used.add(at);
        kept.push(after[at]);
        continue;
      }
      if (at >= 0) {
        used.add(at);
        if (JSON.stringify(after[at]) !== JSON.stringify(old)) frozen.push(name);
      } else if (before.length !== after.length) {
        frozen.push(name);
      }
      kept.push(old);
    }

    // Anything the edit ADDED, which only an in-scope section may do.
    for (let i = 0; i < after.length; i += 1) {
      if (used.has(i)) continue;
      const name = entryName(kind, after[i]);
      if (scope.touchesEntry(kind, name)) kept.push(after[i]);
      else frozen.push(name || 'a new entry');
    }

    (out as any)[kind] = kept;
  }

  if (!scope.touches('skills') && JSON.stringify(edited.skills) !== JSON.stringify(previous.skills)) {
    out.skills = previous.skills;
    frozen.push('your skills');
  }
  if (!scope.touches('summary') && (edited.summary ?? '') !== (previous.summary ?? '')) {
    out.summary = previous.summary;
    frozen.push('your summary');
  }

  return { structure: out, frozen: [...new Set(frozen)] };
}

/** Said when an edit was held to what it named. */
export function frozenLine(frozen: readonly string[], named: readonly string[]): string {
  const list = (items: readonly string[]) =>
    items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : items[0];

  /*
   * The verb agrees with the subject, not with how many subjects there are.
   *
   * "your skills was also rewritten" appeared on every scoped edit — one
   * frozen item, so the sentence chose the singular, and the item happens to
   * be plural. It is the most-read line the app writes after an edit, and it
   * had a grammatical error in it and no capital letter after the full stop.
   */
  const subject = list(frozen);
  const plural = frozen.length > 1 || /\b(skills|bullets|dates)\b/i.test(frozen[0] ?? '');

  return (
    `This changed ${named.length ? list(named) : 'what you named'} only. ` +
    `${subject.charAt(0).toUpperCase()}${subject.slice(1)} ${plural ? 'were' : 'was'} also rewritten, ` +
    `and ${plural ? 'those are back as they were' : 'that is back as it was'} — ` +
    'ask again with "the whole resume" if you wanted it everywhere.'
  );
}
