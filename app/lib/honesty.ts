import { NOTHING_ASKED, type Asked } from './asked';
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
 * Words too common to tell us anything about where a sentence came from.
 *
 * Wider than FILLER, which exists for matching a phrase. This one decides
 * whether a bullet is ABOUT what somebody told us, and for that the verbs and
 * connectives a resume uses everywhere have to be set aside, or every sentence
 * looks like every other.
 */
const COMMON = new Set([
  ...['and','or','of','the','a','an','in','on','for','with','to','by','at','as','from','into','that','this','it','its','their','our','my','is','are','was','were','be','been','using','used','use','via','per','across','through','over','under','not','no','but','so','than','then','when','while','after','before','out','up','down','off','about','every','all','each','more','most','new','own'],
  ...['built','build','building','made','make','created','create','developed','develop','designed','design','added','add','wrote','write','set','ran','run','worked','work','helped','help','led','lead','shipped','ship','delivered','deliver','implemented','implement','improved','improve','reduced','cut','increased','raised'],
  // The same register, and all three cost a good rewrite. "Grew client
  // portfolios" rewritten as "growing portfolios" reads as a new word because
  // grew and grow are not each other to any stemmer this file is going to
  // have; "supported" is what everybody writes for everything.
  ...['grew','grow','growing','grown','support','supports','supported','supporting'],
  /*
   * Ways of saying "did it", which are a wording choice and not a claim.
   *
   * Found on a real run: a fact reading "Did user research and wireframing in
   * Figma" came back as "Conducted user research and built wireframes", and
   * the pair "conducted research" was flagged — the posting says "conduct
   * user research" and the source says "did". Same claim, different verb,
   * which is the one rewrite the rules name as allowed.
   *
   * Only pure do-synonyms. managed, owned, oversaw, led, coordinated and
   * drove are NOT here and must not be: those claim a position, and a source
   * saying "worked on" rewritten as "managed" is an escalation this check is
   * one of the few things that can catch.
   */
  ...['do','did','does','doing','done','conduct','conducts','conducted','conducting','perform','performs','performed','performing','carry','carried','carrying','complete','completes','completed','completing','execute','executed','executing','undertake','undertook','undertaken','handle','handles','handled','handling'],
  ...['project','projects','feature','features','app','application','system','systems','team','teams','code','data','user','users','time','work'],
]);

/**
 * A word reduced to its root, crudely.
 *
 * Only enough to see that "validating" and "validate" are the same word.
 * Without it a bullet written from somebody's own sentence reads as two
 * thirds theirs instead of five sixths, and the test below fails them for
 * having conjugated a verb differently.
 */
const stem = (word: string): string =>
  word
    .replace(/(?<=.{4})ing$/, '')
    .replace(/(?<=.{4})ed$/, '')
    // "strategies" and "strategy" are one word, and dropping the s alone
    // leaves "strategie" against "strategy" — which read as an invention on a
    // bullet rewritten from the person's own sentence about strategy.
    .replace(/(?<=.{3})ies$/, 'y')
    // The plural BEFORE the trailing e, or the two spellings of one word come
    // apart: "wireframes" loses its s to become "wireframe" and stops there,
    // while "wireframing" loses its ing and becomes "wirefram". Read as two
    // words, a bullet rewritten from the person's own "wireframing" was
    // flagged for taking "wireframes" from the posting.
    .replace(/(?<=.{3})s$/, '')
    .replace(/(?<=.{4})e$/, '');

/** The words in a sentence that actually say what it is about, stemmed. */
const contentWords = (text: string): string[] => {
  const seen = new Set<string>();
  for (const raw of (text ?? '').toLowerCase().match(/[a-z0-9][a-z0-9+#.-]*/g) ?? []) {
    const word = raw.replace(/^[.-]+|[.-]+$/g, '');
    if (word.length < 3 || COMMON.has(word)) continue;
    seen.add(stem(word));
  }
  return [...seen];
};

/**
 * Whether a bullet is saying back what the person themselves just told us.
 *
 * The case this exists for, from a real run: the app asked what the Resumi
 * project should say, the person answered "schema-constrained output,
 * hallucination guards, mock-mode test harness", the model wrote two bullets
 * from exactly that — and the check deleted both, because the entry had been
 * dropped earlier so neither bullet had a source bullet behind it. The entry
 * saved as a heading with nothing under it, and the facts the app had just
 * ASKED FOR were the ones it threw away.
 *
 * `evidence` widening does not cover this: the unsourced test deliberately
 * reads the source bullets alone, so that an instruction in the room cannot
 * launder a bullet that came from nowhere. That rule is right and stays. This
 * is narrower — not "an instruction exists" but "this sentence is made of the
 * words they typed". Most of what it is about has to appear in their own text,
 * which an invented bullet written alongside an unrelated instruction cannot
 * manage.
 *
 * Three quarters, and that number is a judgement rather than a finding. Two
 * thirds would admit one more real bullet from the run above and would also
 * let an invention ride in on a long instruction. Set strict, because the
 * cost of refusing a good bullet is now small: an entry emptied by this check
 * is taken off rather than printed as a heading over nothing, so a refused
 * bullet no longer takes somebody's project off the page with it.
 */
export function toldByThePerson(text: string, words: string): boolean {
  if (!words.trim()) return false;
  const inBullet = contentWords(text);
  if (inBullet.length < 3) return false;
  const theirs = new Set(contentWords(words));
  const matched = inBullet.filter((w) => theirs.has(w)).length;
  return matched / inBullet.length >= 0.75;
}

/**
 * The posting's own words, in a rewrite, where the source has nothing.
 *
 * The invention this catches is not a lie about a tool — the requirement check
 * above has that one — it is a true sentence with a clause welded on:
 *
 *     redesigning an offline-sync retry scheduler TO FLAG ANOMALIES and fire
 *     against the next real retry time, UNDER TIGHT LATENCY CONSTRAINTS
 *
 * The scheduler retries failed syncs. It does not flag anomalies, there is no
 * latency constraint anywhere in the person's notes, and both phrases are
 * sitting in the posting. An interviewer reads "flag anomalies" and asks about
 * it, which is the whole cost.
 *
 * **Two words, not one.** Measured over 139 real bullets from one apply run:
 * one unsourced word that also appears in the posting fires on 20% of bullets;
 * demanding two fires on 10% and catches exactly the same inventions, so the
 * second word is free precision. A single word is how a legitimate rewrite
 * reaches for the employer's vocabulary for a fact the person does have.
 *
 * **A phrase counts for both of them.** Two content words running together in
 * the bullet and in the posting and in neither case in the source is the
 * strongest signal available and the cheapest to read: on the same 139 it
 * fired nine times, eight of them phrases from the bug report's own table.
 *
 * **What it cannot see**, said plainly because the gap matters: a claim built
 * from words the source already contains. "integration checks before merge"
 * on a bullet whose source says "payment integration", "to prepare data for
 * the models" where the source says "AI/LLM model". Nothing lexical reaches
 * those — of eleven inventions in the report, this reads six.
 */
const lifted = (text: string, evidence: string, posting: string): string | null => {
  if (!posting.trim()) return null;

  /**
   * Content words in order, one per word written, separators closed up.
   *
   * "back-end" and "backend" are one word, and so are "front-end",
   * "offline-sync" and "Node.js" — the same point patternFor makes about
   * requirements. Read without this, a rewrite of "mobile, backend, and web
   * development" was flagged for taking "back-end development" from the
   * posting, which is a hyphen, not a claim.
   */
  const inOrder = (from: string): string[] =>
    ((from ?? '').toLowerCase().match(/[a-z0-9][a-z0-9+#.-]*/g) ?? [])
      .map((w) => w.replace(/^[.-]+|[.-]+$/g, ''))
      .filter((w) => w.length >= 3 && !COMMON.has(w))
      .map((w) => stem(w).replace(/[.-]/g, ''));

  /**
   * The same, plus the halves of anything compound — for membership only.
   *
   * Closing the separators alone goes wrong in the other direction: the
   * posting writes "low-latency" and the bullet writes "latency constraints",
   * and one squashed word does not contain the other. A compound says both of
   * its parts, so for "is this word in the source" and "is this word in the
   * posting" both parts count. Never used for the pairs, where one word per
   * word written is what makes two of them adjacent.
   */
  const wordSet = (from: string): Set<string> => {
    const out = new Set<string>();
    for (const raw of (from ?? '').toLowerCase().match(/[a-z0-9][a-z0-9+#.-]*/g) ?? []) {
      const word = raw.replace(/^[.-]+|[.-]+$/g, '');
      for (const part of [word, ...word.split(/[.-]/)]) {
        if (part.length >= 3 && !COMMON.has(part)) out.add(stem(part).replace(/[.-]/g, ''));
      }
    }
    return out;
  };

  /** Pairs of content words that sit next to each other once the filler goes. */
  const pairs = (from: string): Set<string> => {
    const words = inOrder(from);
    const out = new Set<string>();
    for (let i = 0; i + 2 <= words.length; i += 1) out.add(`${words[i]} ${words[i + 1]}`);
    return out;
  };

  /**
   * The same words, each with where it sits, so what gets SAID is what the
   * bullet says.
   *
   * Reported off the stems, the message read: takes "requir" and "multipl"
   * from the posting. The stems are how the comparison is made and are not
   * words — somebody reading a warning about their own sentence should see
   * their own sentence, so the phrase is sliced back out of the original.
   */
  const placed = (from: string): { stem: string; at: number; end: number }[] => {
    const out: { stem: string; at: number; end: number }[] = [];
    for (const found of from.toLowerCase().matchAll(/[a-z0-9][a-z0-9+#.-]*/g)) {
      const raw = found[0];
      const trimmed = raw.replace(/^[.-]+|[.-]+$/g, '');
      if (trimmed.length < 3 || COMMON.has(trimmed)) continue;
      const at = (found.index ?? 0) + raw.indexOf(trimmed);
      out.push({ stem: stem(trimmed).replace(/[.-]/g, ''), at, end: at + trimmed.length });
    }
    return out;
  };
  const written = placed(text);
  /** One word or a run of two, as the bullet punctuated it. */
  const asWritten = (from: number, to = from) => text.slice(written[from].at, written[to].end);

  const inSource = wordSet(evidence);

  /*
   * A pair counts when the posting has it and the SOURCE is missing a word of
   * it — not when the source merely lacks the pair.
   *
   * The difference is a good rewrite. "Worked across mobile, backend, and web
   * development" rewritten as "front-end (mobile, web) and back-end
   * development" makes the pair "mobile web", which the source does not
   * contain as a pair and does contain as two words. Reordering a sourced fact
   * is the thing tailoring is FOR, and the pair test alone called it an
   * invention — the same mistake, in the same place, that cost a good rewrite
   * when requirements were matched whole.
   */
  const theirs = pairs(posting);
  for (let i = 0; i + 1 < written.length; i += 1) {
    const [first, second] = [written[i].stem, written[i + 1].stem];
    if (!theirs.has(`${first} ${second}`)) continue;
    if (!inSource.has(first) || !inSource.has(second)) return asWritten(i, i + 1);
  }

  /*
   * Two separate words, which is the other half and catches what the pairs
   * cannot: the posting says "flag performance anomalies" and the bullet says
   * "to flag anomalies", so no pair is shared and both words are new.
   */
  const inPosting = wordSet(posting);
  /*
   * One word per word written on the bullet's side, deliberately.
   *
   * Counting a compound's halves too lets one hyphen supply both of the two
   * words this rule asks for: "front-end (mobile, web)" rewritten from
   * "mobile, backend, and web" was flagged for taking "frontend" AND "front",
   * which is one word twice.
   */
  const added: string[] = [];
  const counted = new Set<string>();
  for (let i = 0; i < written.length; i += 1) {
    const { stem: word } = written[i];
    if (counted.has(word) || inSource.has(word) || !inPosting.has(word)) continue;
    counted.add(word);
    added.push(asWritten(i));
  }
  return added.length >= 2 ? added.slice(0, 2).join('" and "') : null;
};

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
  asked: Asked = NOTHING_ASKED,
  /**
   * What the bullets are being compared against, in the person's terms.
   *
   * A tailor compares against the profile; an edit compares against the version
   * on screen. Telling somebody their own unchanged sentence is "not in your
   * profile" — which is what 26 warnings said on one edit — is both wrong and
   * insulting.
   */
  sourceLabel = 'your profile',
  /**
   * The posting's whole text, for the echo check below.
   *
   * Not the extracted requirement list, which is where this check started and
   * is why these got through: the list holds normalised tool names, and
   * "flag anomalies", "latency constraints" and "defect tracking" are none of
   * those. Empty string behaves exactly as before.
   */
  posting = '',
): Flag[] {
  const flags: Flag[] = [];

  for (const bullet of bullets) {
    if (!bullet.changed) continue;

    const source = bullet.evidence.join(' \n ');
    /*
     * The person's own instruction is evidence, because they are the source for
     * their own history.
     *
     * "Add that I used C# at Droady" came back reverted: C# is a requirement
     * this posting names and the source bullet does not contain it, so the
     * check read it as the model reaching for the posting's vocabulary. It
     * could not tell that from somebody stating a fact about their own work.
     * Their words now sit beside the bullet's own, and only for the edit that
     * carries them — a tailor has no instruction and behaves exactly as before.
     */
    const evidence = asked.words ? `${source} \n ${asked.words}` : source;
    const fallback = bullet.evidence[0] ?? '';

    /*
     * A sentence that names no source at all. Whole invented bullets — "code
     * reviews and status meetings", "worked cross-functionally with
     * stakeholders" — arrived exactly this way.
     *
     * Tested against the SOURCE rather than the widened evidence, deliberately:
     * an instruction in the room must not turn a bullet that came from nowhere
     * into one that merely claims too much, which would change both what
     * happens to it and what the person is told.
     */
    if (bullet.unsourced || !source.trim()) {
      // Unless they told us. See toldByThePerson: the app asked for these
      // facts, and deleting the answer to its own question is how an entry
      // ended up on somebody's resume as a heading with nothing under it.
      if (!toldByThePerson(bullet.text, asked.words)) {
        flags.push({ text: bullet.text, revertTo: '', reason: `is not based on anything in ${sourceLabel}` });
        continue;
      }
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

    /*
     * The posting's words where the source has nothing. See `lifted`.
     *
     * Last of the wording checks on purpose: it is the broadest, so anything
     * the narrower ones can name gets named by them instead — "claims
     * \"python\"" tells somebody more than "reaches for \"python testing\"".
     */
    const echoed = lifted(bullet.text, evidence, posting);
    if (echoed) {
      flags.push({
        text: bullet.text,
        revertTo: fallback,
        reason: `takes "${echoed}" from the posting, which ${sourceLabel === 'your profile' ? 'your profile' : sourceLabel} does not say`,
      });
      continue;
    }

    // A number nobody wrote down. The rules already forbid it and no reviewed
    // resume broke that, but a fabricated metric is the one invention a reader
    // cannot possibly check, so it is worth the line.
    const invented = (bullet.text.match(NUMBER) ?? [])
      .map((n) => n.trim())
      .find((n) => /\d/.test(n) && !evidence.includes(n.replace(/\s+/g, ' ')));
    if (invented) {
      flags.push({ text: bullet.text, revertTo: fallback, reason: `claims "${invented}", which is not in ${sourceLabel}` });
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
  sourceLabel = 'your profile',
): { structure: T; log: string[]; warnings: string[] } {
  if (!flags.length) return { structure, log: [], warnings: [] };

  const byText = new Map(flags.map((f) => [f.text, f]));
  const fixed: any = { ...structure };

  /*
   * Emptied entries are taken off, never left as a heading.
   *
   * A real run: the Resumi project was restored on request, the model wrote
   * two bullets for it, this check deleted both, and the resume saved with
   * "Resumi" printed over nothing. A heading with no lines under it is worse
   * than the entry being absent — it reads as a mistake to anybody holding the
   * page, and it is one.
   *
   * Every entry left with nothing goes, however it got that way — but only the
   * ones THIS pass emptied are named in the log, because those are the ones
   * the person is owed an explanation for.
   */
  const emptied: string[] = [];
  /*
   * Left with one line, which is thinner than the person's own rule allows.
   *
   * Said rather than acted on, and that is a deliberate difference from the
   * emptied case above. An entry with nothing under it is a printing mistake
   * and can only be taken off; an entry with one real line is a real entry,
   * and deleting somebody's job because the OTHER bullet was an invention
   * would make this check cost more than what it caught. So the resume keeps
   * it and the person is told, which is also what they can act on — the line
   * that went is named two warnings up.
   */
  const thinned: string[] = [];

  for (const kind of ['experience', 'projects', 'education'] as const) {
    if (!Array.isArray(fixed[kind])) continue;
    fixed[kind] = fixed[kind]
      .map((entry: any) => {
        const before = (entry.bullets ?? []).length;
        const bullets = (entry.bullets ?? [])
          .map((text: string) => {
            const flag = byText.get(text);
            if (!flag) return text;
            return flag.revertTo;
          })
          .filter((text: string) => text.trim());
        const named = entry.org || entry.name || entry.school || entry.title || 'an entry';
        if (before > 0 && bullets.length === 0) emptied.push(named);
        // Education is left out: a degree is one line about a school and is
        // not thin for having one.
        if (bullets.length === 1 && before > 1 && kind !== 'education') thinned.push(named);
        return { ...entry, bullets };
      })
      .filter((entry: any) => (entry.bullets ?? []).length > 0);
  }

  const reverted = flags.filter((f) => f.revertTo).length;
  const removed = flags.length - reverted;
  const log: string[] = [];
  if (reverted) log.push(`Put ${reverted} ${reverted === 1 ? 'bullet' : 'bullets'} back in your own words — the rewrite had added something your profile does not say.`);
  if (removed) log.push(`Removed ${removed} ${removed === 1 ? 'bullet' : 'bullets'} that ${removed === 1 ? 'was' : 'were'} not based on anything in ${sourceLabel}.`);
  if (emptied.length) {
    log.push(
      `${emptied.join(', ')} had nothing left under ${emptied.length === 1 ? 'it' : 'them'} afterwards, so ${emptied.length === 1 ? 'it was' : 'they were'} taken off rather than printed as a heading over nothing.`,
    );
  }

  return {
    structure: fixed,
    log,
    warnings: [
      // One line per flag, so the person can see exactly what was claimed
      // rather than a count. This is the only place the claim is ever named.
      ...flags.map((f) => `A rewritten bullet ${f.reason}, so ${f.revertTo ? 'your own wording was put back' : 'it was removed'}: "${f.text}"`),
      ...(thinned.length
        ? [
            `${thinned.join(', ')} ${thinned.length === 1 ? 'has' : 'have'} only one line left, and your rules ask for two. ` +
              `Add a fact in the change box or tailor again, and ${thinned.length === 1 ? 'it' : 'they'} will fill back out.`,
          ]
        : []),
    ],
  };
}
