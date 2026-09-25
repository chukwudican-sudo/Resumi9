import { keyFor, planSections, type Landing, type PlannedSection } from './sections';
import type { ResumeStructure } from './types';

/**
 * Reading "put the summary below education" out of a sentence.
 *
 * Moving a section was the one instruction the box could not carry out at all.
 * Order was copied from the source unconditionally, the edit tool had no field
 * for it, and the model was never shown that sections existed — so asked to
 * move one it returned the entire resume instead, in a shape nothing could
 * resolve, and the guard deleted a bullet it could not account for. That is the
 * edit that lost somebody's coursework line.
 *
 * So the model never gets a say in order again. The app reads the move itself,
 * applies it itself, and the result is the same every time, which a model's
 * answer is not. When the sentence is NOTHING but a move, there is no model
 * call at all: instant, free, and nothing else on the resume can be touched by
 * an edit that was only ever about order.
 *
 * Everything hangs on resolution being strict. "Move the Stripe bullet below
 * the AI one" is the same English shape as a section move, and the only thing
 * standing between it and a reordered resume is that "the Stripe bullet" does
 * not name a section. There is no separate list of things to refuse: if both
 * halves do not resolve to sections the person actually has, this is not a
 * section move and the sentence goes to the model untouched.
 */

/** A move somebody asked for, ready to apply. */
export interface Move {
  key: string;
  label: string;
  where: Landing;
  /** The section it lands beside. Null for the top and the bottom. */
  target: string | null;
  targetLabel: string | null;
  /**
   * The sentence was nothing but this move, so the model has no work to do.
   *
   * Deliberately hard to earn: guessing this wrongly means silently dropping
   * half of what somebody asked for, while guessing the other way only spends
   * a model call that was not needed.
   */
  only: boolean;
}

export type MoveRead = { move: Move } | { ask: string } | null;

/**
 * Words people say for a section but would never write as its heading.
 *
 * `keyFor` reads HEADINGS — it knows "Professional Summary" and "Work History"
 * because those are things printed on resumes. Nobody types "work history" into
 * a box; they type "jobs". The two vocabularies are different and this is the
 * spoken one.
 */
const SPOKEN: Record<string, string> = {
  job: 'experience',
  jobs: 'experience',
  work: 'experience',
  'work history': 'experience',
  'job history': 'experience',
  roles: 'experience',
  school: 'education',
  schooling: 'education',
  uni: 'education',
  university: 'education',
  college: 'education',
  degree: 'education',
  degrees: 'education',
  studies: 'education',
  intro: 'summary',
  bio: 'summary',
  blurb: 'summary',
  'about me': 'summary',
  'tech skills': 'skills',
  'technical skills': 'skills',
  certs: 'certifications',
  side_projects: 'projects',
  'side projects': 'projects',
};

const PRONOUN = /^(?:it|that|this|them|those|these|the section)$/i;

const MOVER = '(?:move|moving|put|putting|place|placing|shift|shifting|bring|bringing|send|sending|relocate|reorder)';
const THE = '(?:the|my|our)\\s+';
const NAME = "([a-z0-9&/#+.'\\- ]{2,40}?)";
const AFTER = '(?:below|underneath|under|beneath|after)';
const BEFORE = '(?:above|over|before|ahead\\s+of|on\\s+top\\s+of|atop)';
const START = '(?:first|at\\s+the(?:\\s+very)?\\s+top|to\\s+the(?:\\s+very)?\\s+top|up\\s+top|at\\s+the\\s+start|to\\s+the\\s+start|at\\s+the\\s+front|to\\s+the\\s+front)';
const END = '(?:last|at\\s+the(?:\\s+very)?\\s+bottom|to\\s+the(?:\\s+very)?\\s+bottom|at\\s+the\\s+end|to\\s+the\\s+end)';

const MODAL = '(?:should\\s+(?:go|be|sit|come)\\s+|needs?\\s+to\\s+(?:go|be|come)\\s+|goes\\s+|go\\s+|comes\\s+|belongs\\s+)?';
const TAIL = '(?=$|[\\s,.;!?])';

/*
 * Two spellings of each shape, and the difference matters.
 *
 * With the verb made optional inside one pattern, the section name is free to
 * start anywhere — so "please put skills first" read the section as "please put
 * skills", which resolves to nothing, and the whole instruction was dropped.
 * When there is a verb the name begins directly after it; when there is none
 * the name begins at the start of the sentence. Neither leaves it floating.
 */
const RELATIVE_VERB = new RegExp(
  `\\b${MOVER}\\s+(?:${THE})?${NAME}\\s+(?:section\\s+)?${MODAL}(${AFTER}|${BEFORE})\\s+(?:${THE})?${NAME}(?:\\s+section)?${TAIL}`,
  'i',
);
const RELATIVE_BARE = new RegExp(
  `^(?:${THE})?${NAME}\\s+(?:section\\s+)?${MODAL}(${AFTER}|${BEFORE})\\s+(?:${THE})?${NAME}(?:\\s+section)?${TAIL}`,
  'i',
);
const ABSOLUTE_VERB = new RegExp(
  `\\b${MOVER}\\s+(?:${THE})?${NAME}\\s+(?:section\\s+)?${MODAL}(${START}|${END})${TAIL}`,
  'i',
);
const ABSOLUTE_BARE = new RegExp(`^(?:${THE})?${NAME}\\s+(?:section\\s+)?${MODAL}(${START}|${END})${TAIL}`, 'i');

/**
 * Politeness in front of the instruction, taken off before anything is read.
 *
 * "Please", "can you" and "I want you to" are not part of what is being moved,
 * but they sit exactly where the section name is expected.
 */
const PREAMBLE =
  /^(?:\s*(?:please|pls|plz|hey|hi|so|ok|okay|and|then|also|just|can\s+you|could\s+you|would\s+you|i\s+want(?:\s+you)?(?:\s+to)?|i'?d\s+like(?:\s+you)?(?:\s+to)?|i\s+need(?:\s+you)?(?:\s+to)?|let'?s|lets)\b[,\s]*)+/i;

/** Words that can be left over without meaning something else was asked for. */
const FILLER =
  /\b(?:please|pls|plz|can|could|would|you|i|want|would\s+like|like|need|make|just|also|and|then|now|ok|okay|thanks|thank|for|me|my|the|it|section|sections|instead|too|as\s+well)\b/gi;

function resolve(phrase: string, planned: PlannedSection[]): PlannedSection | null {
  const words = phrase
    .trim()
    .toLowerCase()
    .replace(/^(?:the|my|our|a)\s+/, '')
    .replace(/\s+section$/, '')
    .replace(/[.,;:!?]+$/, '')
    .trim();
  if (!words || PRONOUN.test(words)) return null;

  // Their own heading first: somebody who renamed Experience to "Where I've
  // Worked" and then typed that deserves to be understood before any table.
  const byLabel = planned.find((s) => s.label.trim().toLowerCase() === words);
  if (byLabel) return byLabel;

  const key = SPOKEN[words] ?? keyFor(words);
  return planned.find((s) => s.key === key) ?? null;
}

/** Whether the sentence is used up by the move, give or take politeness. */
function nothingElse(text: string, matched: string): boolean {
  const rest = text
    .replace(matched, ' ')
    .replace(FILLER, ' ')
    .replace(/[^a-z0-9]+/gi, '')
    .trim();
  return rest === '';
}

/**
 * What a sentence asks to move, a question when it is nearly a move, or
 * nothing at all.
 *
 * `answer` is the reply to a question this function asked on a previous pass:
 * "move it below education" carries no subject, and the person supplies one.
 * Read separately rather than glued to the front of the instruction, because a
 * subject spliced into the sentence lands in a different place than the parser
 * expects and stops matching at all.
 */
export function readMove(text: string, structure: ResumeStructure, answer = ''): MoveRead {
  const words = (text ?? '').trim().replace(PREAMBLE, '');
  if (!words) return null;

  const planned = planSections(structure);
  if (planned.length < 2) return null;

  // A named landmark beats a bare direction: "move skills above experience" is
  // about experience, not about the top of the page.
  const relative = RELATIVE_VERB.exec(words) ?? RELATIVE_BARE.exec(words);
  const absolute = relative ? null : (ABSOLUTE_VERB.exec(words) ?? ABSOLUTE_BARE.exec(words));
  const hit = relative ?? absolute;
  if (!hit) return null;

  const spoken = hit[1];
  const subject = resolve(spoken, planned) ?? (answer ? resolve(answer, planned) : null);
  const direction = hit[2].toLowerCase();

  let where: Landing;
  let target: PlannedSection | null = null;
  if (relative) {
    where = new RegExp(`^${BEFORE}$`, 'i').test(direction.replace(/\s+/g, ' ')) ? 'before' : 'after';
    target = resolve(hit[3], planned);
    // The half that names nothing is the half that decides. Both must be
    // sections this person has, or the sentence was never about sections.
    if (!target) return null;
  } else {
    where = new RegExp(`^${END}$`, 'i').test(direction.replace(/\s+/g, ' ')) ? 'end' : 'start';
  }

  if (!subject) {
    /*
     * A move with nothing to move.
     *
     * This is the exact sentence that started all of it — "move it after
     * education, below it" — and the honest answer is that the app does not
     * know what "it" is, because it does not remember the instruction before
     * this one. Asking beats the alternative, which was reordering nothing and
     * deleting a bullet on the way.
     */
    if (PRONOUN.test(spoken.trim().toLowerCase())) {
      return {
        ask: target
          ? `Move what ${where === 'before' ? 'above' : 'below'} ${target.label}?`
          : `Move what to the ${where === 'end' ? 'bottom' : 'top'}?`,
      };
    }
    return null;
  }

  if (target && target.key === subject.key) return null;

  return {
    move: {
      key: subject.key,
      label: subject.label,
      where,
      target: target?.key ?? null,
      targetLabel: target?.label ?? null,
      only: nothingElse(words, hit[0]) && !answer,
    },
  };
}

/** How the change log says what happened. */
export function moveLine(move: Move): string {
  if (move.where === 'start') return `${move.label} moved to the top.`;
  if (move.where === 'end') return `${move.label} moved to the bottom.`;
  return `${move.label} moved ${move.where === 'before' ? 'above' : 'below'} ${move.targetLabel}.`;
}
