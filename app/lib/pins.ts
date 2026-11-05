import { patternFor, waysOfWriting } from './requirementMatch';
import type { ResumeStructure } from './types';

/**
 * What the person said to keep.
 *
 * The app cuts to reach a page limit, and everything it cuts it chose on its
 * own: a ranking from the model, a skills line scored against the posting, the
 * oldest job when the ranking runs out. None of that knows what somebody said
 * in the change box, so a resume could be fitted twice and lose the same job
 * twice, with the second loss arriving after they had asked for it back.
 *
 * A pin is the one sentence that fixes it: THIS stays on the page. The fitter
 * will not spend it, and if the page cannot be reached without it the page rule
 * is what gives — reported, in those words, rather than the thing they asked
 * for disappearing again quietly.
 *
 * **One mechanism, four places.** A job, a bullet, a skills line and a single
 * tool inside one are all the same promise and all read the same way. What
 * differs is only where to look to see whether the promise still holds, and
 * that is a field on the pin rather than four code paths — `place` exists
 * because "Kudi Kitchen" is both a job and a project on the resume this was
 * built against, and a pin satisfied by the wrong one of those is not kept.
 *
 * **Lexical, no model call**, for the reason asked.ts gives: an edit runs
 * inside one request budget, and a promise nobody can audit is worse than one
 * that is wrong in a known direction. The known direction here is under-reading
 * — an unread pin leaves the app exactly as it behaves today.
 */

/** Where to look to see whether a pin still holds. */
export type PinPlace = 'experience' | 'projects' | 'skills' | 'bullet';

export interface Pin {
  readonly place: PinPlace;
  /** The words that must still be somewhere in that place. */
  readonly text: string;
  /** What to call it when it will not fit. */
  readonly label: string;
}

/**
 * Keeping, meaning presence.
 *
 * "stays" and "stay" are in; so is the imperative "leave". `include` only with
 * "must" or "always" in front of it, because "include the metric" is an
 * addition and additions are the model's work, not a promise about the page.
 */
const KEEP =
  /\b(keep|keeps|keeping|kept|leave|leaving|retain|retaining|retained|preserve|preserving|stays?|staying|must\s+(?:include|have|show|keep)|always\s+(?:include|have|show|keep))\b/i;

/**
 * The other way people say it: a removal with a refusal in front.
 *
 * "don't remove the Aegon job" reads as nothing at all today — asked.ts
 * correctly refuses to license a removal from it, and then no one records that
 * the opposite was asked for. It is the same promise as "keep Aegon".
 */
const NOT_REMOVED =
  /\b(?:don'?t|do\s+not|never|no\s+need\s+to|stop)\s+(?:\w+\s+){0,2}(?:remov\w*|delet\w*|drop\w*|cut|cutting|tak\w*\s+(?:\w+\s+){0,2}(?:out|off)|los\w*|ditch\w*|exclud\w*|omit\w*)\b/i;

/**
 * "Keep" about a quality rather than about presence.
 *
 * "keep it to one page", "keep the Aegon bullets short" — the verb is the same
 * and the promise is not being made. Read as a pin, the first would pin
 * nothing and the second would quietly make a job uncuttable for good on the
 * strength of a sentence asking for it to be trimmed.
 */
const ABOUT_LENGTH =
  /\b(short|shorter|shorten\w*|brief|briefer|concise|tight|tighter|trim\w*|smaller|under|within|to\s+(?:one|two|1|2)\s+pages?|one\s+page|two\s+pages?|word\s+count)\b/i;

/** A part of an entry rather than the entry, which decides what a name means. */
const PART = /\b(bullets?|lines?|points?|sentences?|phrases?|mentions?)\b/i;

/** Which kind of thing the sentence says it is talking about, where it says. */
const KIND: Record<'experience' | 'projects' | 'skills', RegExp> = {
  experience: /\b(jobs?|roles?|positions?|compan(?:y|ies)|employers?|internships?|experience)\b/i,
  projects: /\b(projects?)\b/i,
  skills: /\b(skills?|tech|technolog\w*|stack|languages?|tools?)\b/i,
};

/** Words too generic to identify anything by on their own. */
const SUFFIX = new Set([
  'inc', 'ltd', 'llc', 'corp', 'corporation', 'group', 'labs', 'technologies',
  'solutions', 'systems', 'co', 'company', 'university', 'college', 'international', 'the',
]);

/**
 * Words that say nothing about which bullet is meant.
 *
 * Wider than the usual filler, because a bullet is matched on overlap: the
 * verbs and nouns every resume line contains would make every bullet look like
 * the one somebody described.
 */
const EMPTY = new Set([
  'and','or','of','the','a','an','in','on','for','with','to','by','at','as','from','into','that','this','it','its',
  'is','are','was','were','be','my','me','i','you','your','please','keep','keeps','keeping','kept','leave','leaving',
  'retain','stay','stays','must','always','include','bullet','bullets','line','lines','point','points','sentence',
  'about','one','the','there','resume','page','dont','do','not','never','remove','delete','drop','cut','take','out',
  'off','lose','ditch','exclude','omit','but','also','just','can','could','would','want','need','like','make','sure',
]);

const words = (text: string): string[] =>
  (text ?? '').toLowerCase().match(/[a-z0-9][a-z0-9+#.-]*/g)?.map((w) => w.replace(/^[.-]+|[.-]+$/g, '')) ?? [];

const meaningful = (text: string): string[] => [...new Set(words(text).filter((w) => w.length >= 3 && !EMPTY.has(w)))];

/** Everything said in one place of the resume, as the texts a pin could name. */
function textsIn(structure: ResumeStructure, place: PinPlace): string[] {
  switch (place) {
    case 'experience':
      return (structure.experience ?? []).flatMap((e) => [e.org, e.title].filter(Boolean) as string[]);
    case 'projects':
      return (structure.projects ?? []).flatMap((p) => [p.name, p.tech].filter(Boolean) as string[]);
    case 'skills':
      return (structure.skills ?? []).flatMap((g) => [
        g.category ?? '',
        ...String(g.items ?? '').split(',').map((t) => t.trim()),
      ]).filter(Boolean);
    case 'bullet':
      return [
        ...(structure.experience ?? []).flatMap((e) => e.bullets ?? []),
        ...(structure.projects ?? []).flatMap((p) => p.bullets ?? []),
        ...(structure.education ?? []).flatMap((e) => e.bullets ?? []),
      ];
  }
}

/**
 * One spelling, so two spellings of the same thing are the same thing.
 *
 * "&" becomes "and" because a tailor writes "AI and Data" for a line the person
 * pinned as "AI & Data", and punctuation goes because "Next.js" and "Next js"
 * are not two tools.
 */
const flat = (text: string) =>
  (text ?? '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();

/** The same, with the gaps closed: for a name somebody typed as two words. */
const squash = (text: string) => flat(text).replace(/ /g, '');

/**
 * Which pins the resume no longer keeps.
 *
 * Compared with the punctuation flattened, so "AI & Data" is still itself after
 * a tailor writes it "AI and Data", and matched by containment so a pinned tool
 * counts wherever in a line it sits.
 */
export function missingPins(structure: ResumeStructure, pins: readonly Pin[]): Pin[] {
  return pins.filter((pin) => {
    const needle = flat(pin.text);
    if (!needle) return false;
    // Padded, so a pinned "SQL" is not answered by a line that only says
    // PostgreSQL. A tool sits between separators and a flattened line turns
    // every separator into a space, so the bounds are real.
    return !textsIn(structure, pin.place).some((text) => ` ${flat(text)} `.includes(` ${needle} `));
  });
}

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

/**
 * Whether this sentence names that thing.
 *
 * The word-boundary match first, and then the same comparison with every gap
 * closed — because his own profile spells one employer "WesternBell" and
 * nobody types it that way. Five characters before the loose form is allowed,
 * so a short name cannot be found inside a longer word.
 */
const named = (text: string, name: string) =>
  namesOf(name).some((way) => {
    if (patternFor(way).test(text)) return true;
    const loose = squash(way);
    return loose.length >= 5 && squash(text).includes(loose);
  });

/**
 * The pins their standing rules ask for.
 *
 * Read off each rule's stored CHECK rather than off its text. A rule's
 * meaning is read once, when it is written, by the intake that already does
 * this for every other kind of rule — and the reading is shown on the rules
 * page, so what the fitter will obey is visible before any resume is made.
 *
 * It was a regex over the rule's prose at tailor time, which was wrong three
 * ways at once: fragile on free text, invisible, and it turned a sentence
 * somebody meant as guidance into a constraint they never agreed to. An
 * ambiguous rule gets no check, shows as guidance, and binds nothing.
 *
 * Where a name sits is worked out here, against the resume being fitted: the
 * rule says "Aegon" and this resume is the only thing that knows whether that
 * is a job, a project, a skill, or not on the page at all.
 */
export function pinsFromRules(
  rules: readonly { check?: unknown }[],
  structure: ResumeStructure,
): Pin[] {
  const pins: Pin[] = [];
  const add = (pin: Pin) => {
    if (missingPins(structure, [pin]).length) return;
    if (!pins.some((p) => p.place === pin.place && samePin(p.text, pin.text))) pins.push(pin);
  };

  for (const rule of rules) {
    const check = rule?.check as { kind?: string; names?: unknown } | null | undefined;
    if (!check || check.kind !== 'always_include' || !Array.isArray(check.names)) continue;

    for (const raw of check.names) {
      const name = typeof raw === 'string' ? raw.trim() : '';
      if (!name) continue;

      // An employer or a project, by name. Education is never cut to reach a
      // page limit, so a rule naming a degree is already satisfied.
      const asJob = (structure.experience ?? []).some((e) => e.org && named(name, e.org));
      const asProject = (structure.projects ?? []).some((p) => p.name && named(name, p.name));
      if (asJob) add(pinEntry('experience', name));
      if (asProject) add(pinEntry('projects', name));
      if (asJob || asProject) continue;

      // A skills line, or one tool on one.
      for (const group of structure.skills ?? []) {
        const category = (group.category ?? '').trim();
        if (category && named(name, category)) add({ place: 'skills', text: category, label: `the ${category} line` });
        for (const item of String(group.items ?? '').split(',').map((t) => t.trim()).filter(Boolean)) {
          if (waysOfWriting(item).some((way) => patternFor(way).test(name))) {
            add({ place: 'skills', text: item, label: item });
          }
        }
      }
    }
  }
  return pins;
}

/** Whether two pins name the same words, however either was punctuated. */
export const samePin = (a: string, b: string) => flat(a) === flat(b);

/** A pin for an entry the person asked to have back, by the name it goes by. */
export function pinEntry(section: 'experience' | 'projects', name: string): Pin {
  return { place: section, text: name, label: name };
}

/**
 * What one instruction promises to keep.
 *
 * Read against the resume it will be applied to, for the reason readInstruction
 * is: which thing was meant can only be decided against the real list, and two
 * things answering to the same words is a fact about this resume.
 */
export function readPins(instruction: string, structure: ResumeStructure): Pin[] {
  const text = (instruction ?? '').trim();
  if (!text) return [];

  const keep = KEEP.test(text) || NOT_REMOVED.test(text);
  if (!keep) return [];
  // "keep it to one page" promises nothing about any one thing on it.
  if (ABOUT_LENGTH.test(text) && !NOT_REMOVED.test(text)) return [];

  const pins: Pin[] = [];
  const add = (pin: Pin) => {
    if (!pins.some((p) => p.place === pin.place && flat(p.text) === flat(pin.text))) pins.push(pin);
  };

  const saysKind = (kind: keyof typeof KIND) => KIND[kind].test(text);
  const aboutParts = PART.test(text);

  /*
   * Entries, by name. A name on both lists — "Kudi Kitchen" is a job and a
   * project here — pins the side the sentence names, or both when it names
   * neither, because keeping too much is answered with a message and keeping
   * too little is answered with a resume that lost it.
   */
  const inExperience = (structure.experience ?? []).filter((e) => e.org && named(text, e.org));
  const inProjects = (structure.projects ?? []).filter((p) => p.name && named(text, p.name));
  const only: Array<'experience' | 'projects'> = saysKind('experience') && !saysKind('projects')
    ? ['experience']
    : saysKind('projects') && !saysKind('experience')
      ? ['projects']
      : ['experience', 'projects'];
  if (only.includes('experience')) for (const e of inExperience) add(pinEntry('experience', e.org));
  if (only.includes('projects')) for (const p of inProjects) add(pinEntry('projects', p.name));

  /*
   * Skills, which are looser on purpose: a category or a single tool, and
   * nothing has to say the word "skills" for "don't drop Figma" to be about
   * one. A term is only read as a skill when it is actually in their skills.
   */
  for (const group of structure.skills ?? []) {
    const category = (group.category ?? '').trim();
    if (category && named(text, category)) add({ place: 'skills', text: category, label: `the ${category} line` });
    for (const item of String(group.items ?? '').split(',').map((t) => t.trim()).filter(Boolean)) {
      if (waysOfWriting(item).some((way) => patternFor(way).test(text))) {
        add({ place: 'skills', text: item, label: item });
      }
    }
  }

  /*
   * A bullet, which is the one kind nobody names exactly. "keep the bullet
   * about the 200+ cylinders" is matched on the words that are left after the
   * asking is stripped out, and only when one bullet answers to them better
   * than every other — a wrong bullet pinned is a wrong thing made permanent.
   */
  if (aboutParts) {
    const asked = meaningful(text);
    if (asked.length >= 2) {
      const scored = textsIn(structure, 'bullet')
        .map((bullet) => ({ bullet, n: meaningful(bullet).filter((w) => asked.includes(w)).length }))
        .sort((a, b) => b.n - a.n);
      const [best, next] = scored;
      if (best && best.n >= 2 && best.n > (next?.n ?? 0)) {
        add({ place: 'bullet', text: best.bullet, label: 'that bullet' });
      }
    }
  }

  return pins;
}

/** Said when the page rule and what they asked to keep cannot both hold. */
export function pinnedOverLine(blocking: readonly Pin[], pages: number, target: number): string {
  const names = blocking.map((p) => p.label);
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
  return (
    `You asked to keep ${list}. With ${names.length > 1 ? 'them' : 'it'} on the page this runs to ` +
    `${pages} page${pages === 1 ? '' : 's'} and your rules ask for ${target} — ` +
    `${names.length > 1 ? 'they are' : 'it is'} kept, so the page rule is the one that gives.`
  );
}
