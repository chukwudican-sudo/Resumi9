import type { ResolvedBullet } from './provenance';
import { patternFor, waysOfWriting } from './requirementMatch';

/**
 * Whether a rewritten bullet says more than the bullet it came from.
 *
 * The prompt was rewritten three times to stop this and got most of the way:
 * whole invented bullets are gone, ownership verbs survive, numbers stay put.
 * What kept getting through was the tail — a faithful rewrite with a clause
 * added at the end that nobody earned:
 *
 *   "Backend lead on a 3-person team, completing a two-week Agile sprint"
 *     → "…, working both independently and collaboratively"
 *   "Set up an automated CI pipeline (GitHub Actions) on every push"
 *     → "…, using Git-based version control throughout"
 *
 * Both read as reasonable, which is exactly why words could not stop them. This
 * is arithmetic instead: everything the bullet claims is compared with the
 * bullet it names as its source. No model, no judgement, no extra second on the
 * wait — and it runs on instruction edits too, where the model is likelier to
 * drift because it is rewriting a rewrite.
 *
 * It is deliberately narrow. A check that fires on ordinary rewording would
 * undo good tailoring, and a false revert is worse than a missed tail: the
 * person loses a sentence they would have kept. Every rule below needs the
 * claim to be BOTH absent from the evidence AND of a kind that has produced a
 * real invention on a real resume.
 */

export interface Flag {
  /** The bullet as the model wrote it. */
  text: string;
  /** What to put back instead, empty when there is nothing to fall back to. */
  revertTo: string;
  /** One clause, for the change log. "claims code reviews" */
  reason: string;
}

/**
 * Words that describe how somebody worked rather than what they did.
 *
 * Each one appeared in a reviewed resume, in a bullet whose source said nothing
 * of the kind. They are only ever flagged when the source does not use them, so
 * a person who really did write "cross-functional" keeps it.
 */
const STOCK = [
  'stakeholder', 'stakeholders',
  'cross-functional', 'cross functionally', 'cross-functionally',
  'interdisciplinary',
  'fast-paced', 'fast paced',
  'self-motivated', 'self-motivation',
  'interpersonal',
  'enterprise-scale', 'large-scale', 'high-volume', 'mission-critical',
  'collaboratively', 'independently and collaboratively',
  'code review', 'code reviews',
  'status meeting', 'status meetings',
  'stand-up', 'standups', 'stand-ups',
  'code coverage',
  'sdlc', 'software development lifecycle',
  'secure coding',
  'quantitative analysis',
  'best practices',
  /*
   * The soft competencies a posting lists and a rewrite quietly adopts.
   *
   * These are the ones that reached a finished resume. "Maintained a 95% client
   * retention rate by delivering consistent service, clear communication, and
   * timely follow-ups" came back with "timely follow-ups" swapped for "strong
   * user orientation" — a phrase from the posting's own Skills & Competencies
   * list, describing a quality nobody had claimed.
   *
   * They need their own line because the posting reader deliberately keeps
   * concrete named skills and drops competencies like these, so `requirements`
   * never carries them and nothing else was looking.
   */
  // "Employs iterative development techniques" is a line in one posting's
  // responsibilities. It came back as "employing an iterative Agile development
  // process" and as "following an iterative development approach", on bullets
  // whose sources describe a two-week sprint and a personal project — neither
  // of which says anything about how the work was iterated.
  'iterative', 'iteratively',
  'user orientation', 'customer focus', 'customer-focused',
  'attention to detail', 'detail-oriented',
  'problem solving', 'problem-solving',
  'team player', 'team-oriented',
  'communication skills', 'written and verbal',
  'self-starter', 'proactive',
  'results-driven', 'results-oriented',
];

/** A number as it would be claimed: 15%, 8,187, 30–45 seconds, $2M. */
const NUMBER = /\$?\d[\d,.]*\s*(%|k\b|m\b|x\b)?/gi;

/**
 * Whether a bullet says a thing — as a reader would judge it, not a matcher.
 *
 * A single-word term is a straight lookup. A multi-word one is not: a real
 * false positive came from asking whether "Worked across mobile, backend, and
 * web development" contains the phrase "back-end development". It does not,
 * adjacently — but it plainly says it, and the rewrite that put the two words
 * together was the tailoring working. So a multi-word requirement counts as
 * said when each of its significant words is there, wherever they sit.
 *
 * Short connecting words are dropped before that test, or "design of systems"
 * would hang on the word "of".
 */
const FILLER = new Set(['and', 'or', 'of', 'the', 'a', 'an', 'in', 'on', 'for', 'with', 'to']);

/**
 * How far apart the words of a phrase may sit and still be that phrase.
 *
 * "mobile, backend, and web development" says back-end development: the words
 * are three apart, in one list. "backend lead on a 3-person team, employing an
 * iterative Agile development process" does not: the same two words are ten
 * apart, doing unrelated jobs. Without a limit the second reads as a claim, and
 * a good rewrite gets reverted — which it was, on a live run.
 */
const NEARBY = 30;

const nearEachOther = (haystack: string, words: string[]): boolean => {
  const found = words.map((word) => {
    const scan = new RegExp(patternFor(word).source, 'gi');
    const at: number[] = [];
    for (let m = scan.exec(haystack); m; m = scan.exec(haystack)) at.push(m.index);
    return at;
  });
  if (found.some((at) => !at.length)) return false;
  return found[0].some((anchor) =>
    found.slice(1).every((at) => at.some((i) => Math.abs(i - anchor) <= NEARBY)),
  );
};

const said = (haystack: string, term: string, scattered = false): boolean =>
  waysOfWriting(term).some((way) => {
    if (patternFor(way).test(haystack)) return true;
    if (!scattered) return false;
    // Split on spaces only. A hyphen is not a word boundary here — "back-end"
    // is one word written two ways, and splitting it yields "back", which
    // matches nothing on its own and never will.
    const words = way.split(/\s+/).filter((w) => w && !FILLER.has(w));
    return words.length > 1 && nearEachOther(haystack, words);
  });

/**
 * Checks one pass of tailoring, and says what to put back.
 *
 * `requirements` are the posting's own extracted terms. A requirement appearing
 * in a rewrite but nowhere in its source is the single most common invention —
 * it is the posting's vocabulary being used as evidence, which is the one thing
 * the rules say it is not.
 */
export function checkBullets(
  bullets: ResolvedBullet[],
  requirements: string[] = [],
): Flag[] {
  const flags: Flag[] = [];

  for (const bullet of bullets) {
    if (!bullet.changed) continue;

    const evidence = bullet.evidence.join(' \n ');
    const fallback = bullet.evidence[0] ?? '';

    // A sentence that names no source at all. Whole invented bullets — "code
    // reviews and status meetings", "worked cross-functionally with
    // stakeholders" — arrived exactly this way.
    if (bullet.unsourced || !evidence.trim()) {
      flags.push({ text: bullet.text, revertTo: '', reason: 'is not based on anything in your profile' });
      continue;
    }

    // A fact carried in from another entry. The project folded into the job of
    // the same name, which then showed the same work twice.
    if (bullet.moved) {
      flags.push({ text: bullet.text, revertTo: fallback, reason: 'moves work from another entry into this one' });
      continue;
    }

    /*
     * Requirements are matched scattered, stock phrases are not.
     *
     * An employer's phrase legitimately spreads across a sentence: a bullet
     * saying "mobile, backend, and web development" does say "back-end
     * development", and reverting that rewrite cost a good edit once. A stock
     * phrase is the opposite — it is only ever an invention written whole.
     * Matched loosely, "code review" fires on "Reviewed the code for a teammate
     * and shipped the review notes", which is somebody's real work being taken
     * off their resume.
     */
    const claimed = requirements.find(
      (term) => term.trim() && said(bullet.text, term, true) && !said(evidence, term, true),
    );
    if (claimed) {
      flags.push({ text: bullet.text, revertTo: fallback, reason: `claims "${claimed}", which this bullet does not say` });
      continue;
    }

    const stock = STOCK.find((term) => said(bullet.text, term) && !said(evidence, term));
    if (stock) {
      flags.push({ text: bullet.text, revertTo: fallback, reason: `adds "${stock}", which this bullet does not say` });
      continue;
    }

    // A number nobody wrote down. The rules already forbid it and no reviewed
    // resume broke that, but a fabricated metric is the one invention a reader
    // cannot possibly check, so it is worth the line.
    const invented = (bullet.text.match(NUMBER) ?? [])
      .map((n) => n.trim())
      .find((n) => /\d/.test(n) && !evidence.includes(n.replace(/\s+/g, ' ')));
    if (invented) {
      flags.push({ text: bullet.text, revertTo: fallback, reason: `claims "${invented}", which is not in your profile` });
    }
  }

  return flags;
}

/**
 * The tailored resume with every flagged bullet put back, and a line each.
 *
 * Reverting rather than removing wherever there is something to revert to: the
 * person wrote that sentence, and it is better on their resume than a gap. A
 * bullet with no source is dropped, because there is nothing to fall back to
 * and leaving it would leave the invention.
 */
export function applyFlags<T extends { experience?: any[]; projects?: any[]; education?: any[] }>(
  structure: T,
  flags: Flag[],
): { structure: T; log: string[]; warnings: string[] } {
  if (!flags.length) return { structure, log: [], warnings: [] };

  const byText = new Map(flags.map((f) => [f.text, f]));
  const fixed: any = { ...structure };

  for (const kind of ['experience', 'projects', 'education'] as const) {
    if (!Array.isArray(fixed[kind])) continue;
    fixed[kind] = fixed[kind].map((entry: any) => ({
      ...entry,
      bullets: (entry.bullets ?? [])
        .map((text: string) => {
          const flag = byText.get(text);
          if (!flag) return text;
          return flag.revertTo;
        })
        .filter((text: string) => text.trim()),
    }));
  }

  const reverted = flags.filter((f) => f.revertTo).length;
  const removed = flags.length - reverted;
  const log: string[] = [];
  if (reverted) log.push(`Put ${reverted} ${reverted === 1 ? 'bullet' : 'bullets'} back in your own words — the rewrite had added something your profile does not say.`);
  if (removed) log.push(`Removed ${removed} ${removed === 1 ? 'bullet' : 'bullets'} that ${removed === 1 ? 'was' : 'were'} not based on anything in your profile.`);

  return {
    structure: fixed,
    log,
    // One line per flag, so the person can see exactly what was claimed rather
    // than a count. This is the only place the specific claim is ever named.
    warnings: flags.map((f) => `A rewritten bullet ${f.reason}, so ${f.revertTo ? 'your own wording was put back' : 'it was removed'}: "${f.text}"`),
  };
}
