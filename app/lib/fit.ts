import { missingPins, pinnedOverLine, type Pin } from './pins';
import type { CutTarget } from './provenance';
import { patternFor, waysOfWriting } from './requirementMatch';
import type { ResumeStructure } from './types';

/**
 * Cutting a finished resume down to the length the person asked for.
 *
 * The model is deliberately not asked to do this. Told to keep a resume short
 * it drops whatever it likes and reports a length it guessed — "may run
 * slightly over 1 page" for a resume that filled two — so the app ended up with
 * both a shorter resume and no idea how long it was. Here the model only ranks:
 * it says what matters least for this posting, and nothing else. The compiler
 * says how long the document is, and this file decides how much of that ranking
 * to spend.
 *
 * Three rules shape everything below.
 *
 * **Cuts only count if they work.** A resume that lost ten bullets and is still
 * two pages is strictly worse than the one it started as — the person gave up
 * ten sentences and got nothing for them. So the cuts are a trial: kept when
 * they reach the target, put back in full when they do not, and said out loud
 * either way.
 *
 * **Fewest cuts that fit.** Every bullet removed is evidence the reader no
 * longer sees, so the search is for the smallest prefix of the ranking that
 * gets there rather than the first one that happens to.
 *
 * **Whole entries can go, and that is the only way one page is reachable.**
 * Measured on a real profile: 27 bullets across ten jobs and projects, with a
 * one-page rule. Trimming bullets alone could not do it and never could — ten
 * entries that each keep a heading and one line is already two pages. So an
 * entry may be dropped when the ranking says so, with one floor that is not
 * negotiable: at least one job stays, whatever the ranking says, because a
 * resume with an empty work history is not a shorter resume.
 */

const SECTIONS = ['experience', 'projects'] as const;
type Section = (typeof SECTIONS)[number];

/**
 * The fewest bullets trimming may leave under an entry.
 *
 * Two, not one. One bullet per entry fits more resumes — measured, it was the
 * only thing that fitted one of ten — but it produces a page where nothing has
 * any depth, every role reduced to a single line. Somebody reading that learns
 * less than from a shorter resume with real detail on the roles that stayed.
 *
 * Keeping the heading and deleting all its bullets was considered and rejected:
 * it is a real convention for decade-old roles, and it is not what a student
 * resume does. A project reduced to a name and a stack line reads as filler,
 * and an employer would rather see it left off.
 */
const MIN_BULLETS = 2;

/**
 * The fewest jobs cutting may leave.
 *
 * One was the floor, and one is what a real resume came back with: four jobs
 * in, three dropped to reach a page, Kudi Kitchen alone under Experience. The
 * person's own words for it — *"just one experience is crazy, it makes me look
 * like I don't have any experience in a workplace in life"* — are the whole
 * argument. A recruiter glancing at a page sees ONE JOB before reading which
 * job it was, and nobody reconstructs the missing ones from the fact that the
 * page is short.
 *
 * The ranking cannot know this. It scores each entry against this posting, and
 * however good that scoring is, it says nothing about how the page reads as a
 * whole. Relevance decides which entries go; this decides how few may be left.
 *
 * Three, raised from two after a real apply run: eleven resumes, and the
 * fitter stopped at exactly two every time because two was what it was told.
 * Measured on that profile, three jobs and two projects fit on one page with
 * the skills section untouched — so two was never the page's limit, it was
 * ours.
 *
 * Somebody with fewer keeps what they have: the floor stops cutting, it never
 * invents a job.
 */
const MIN_JOBS = 3;

/**
 * The fewest projects cutting may leave, on the same reasoning.
 *
 * A Projects heading with one entry under it has the problem Experience had
 * with one job: it reads as an afterthought rather than as a section. For a
 * student it is worse than that — projects are where somebody shows they build
 * things unasked, and one of them suggests they do not.
 *
 * A floor rather than a target shape. "Aim for three jobs and two projects"
 * would override the ranking with a layout, and drop a better entry for a worse
 * one whenever a posting genuinely favours the jobs. This leaves relevance
 * deciding WHICH survive and only says how few there may be.
 *
 * What it costs, and it is worth being honest about it: with a floor on both
 * sections, the floors rather than the ranking largely decide the SHAPE of a
 * long resume. The ranking picks which two projects live, not how many. That
 * is a deliberate trade — for the people who use this, how a page reads
 * matters more than squeezing out one more per-posting match.
 */
const MIN_PROJECTS = 2;

/**
 * The fewest skill lines trimming may leave.
 *
 * Three. A resume needs a skills section; it does not need eight lines of one.
 * It is the cheapest thing on the page to lose and the fitter could not touch
 * it — so it dropped jobs instead, on all eleven resumes of one apply run,
 * while the same six to eight lines of comma-separated tools sat unchanged on
 * every single output.
 *
 * Measured on that profile: four jobs and two projects run to two pages with
 * five skill lines and fit on one with four. One line of tools costs a JOB.
 */
const MIN_SKILL_LINES = 3;

/**
 * The most skills lines a resume prints, page count or no page count.
 *
 * Five, which is the number the person's own rule asks for. Not four, which
 * the bug report suggested: the acceptance test it was written against says
 * five or fewer, and a cap tighter than the thing it is measured by would be
 * the app overruling them for no reason it could name.
 */
const MAX_SKILL_LINES = 5;

export interface FitOptions {
  /** How many pages it may run to. From the person's rules; two by default. */
  target: number;
  /** What may go, least relevant first. */
  cuts: CutTarget[];
  /**
   * The posting's own words, for ranking the skills lines.
   *
   * The whole description, not the extracted requirement list. Scoring against
   * the list first looked right and was wrong in a way worth remembering: one
   * Applied AI Engineer posting extracted to python, fastapi, aws, sagemaker,
   * eks, ecr, s3, kinesis, terraform — infrastructure names — so the AI & Data
   * line scored ZERO and was the first thing the fitter took off an AI job.
   *
   * Scored the other way round too: how many of the LINE'S items this employer
   * mentions, rather than how many of their keywords the line happens to
   * contain. "How much of this do they care about" is the question; the
   * reverse is a different one that only looks the same.
   */
  posting?: string;
  /**
   * What the person said to keep, and the fitter may not spend.
   *
   * Everything this file cuts, it chose on its own. None of that knows what
   * somebody typed in the change box, so a job could be dropped, asked for
   * back, and dropped again by the next fit — the second time after they had
   * said not to. A pin is the answer and the page rule is what gives: see
   * pins.ts, and `pinnedOverLine` for what gets said when it does.
   */
  pinned?: readonly Pin[];
  /** Compiles and counts. Null when it could not be measured at all. */
  measure: (structure: ResumeStructure) => Promise<number | null>;
  /**
   * Whether there is budget for another compile.
   *
   * Asked before every single one, so a tailor that ate the clock degrades to
   * "not measured" instead of to a dead request.
   */
  affords: () => boolean;
}

export interface FitResult {
  structure: ResumeStructure;
  /** Null when nothing was measured — never a guess. */
  pages: number | null;
  log: string[];
  warnings: string[];
  /**
   * Whole entries this took off, kept as they were.
   *
   * So the resume that gets saved knows what is missing from it. Without this
   * the saved version is only the shortened page, and an edit handed that page
   * cannot see — let alone put back — a job it removed ten seconds earlier.
   */
  dropped: DroppedEntry[];
}

/** An entry the app removed, and where it was. */
export interface DroppedEntry {
  section: Section;
  /** Its position in that section before anything was cut. */
  index: number;
  /** What to call it. */
  name: string;
  /** The entry itself, verbatim — never a summary of it. */
  entry: unknown;
}

const pagesWord = (n: number) => (n === 1 ? 'one page' : `${n} pages`);

/** Letters and digits only — the same comparison the tailoring guard makes. */
const norm = (text: string | null | undefined) => (text ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * One cut, already located on this resume.
 *
 * `skills` is the third kind and the cheapest by far. Measured on a real
 * profile: four jobs and two projects run to two pages with five skill lines
 * and fit on one with four. A line of comma-separated tools costs a whole JOB,
 * and the fitter could not touch it — so it dropped the job instead, eleven
 * times in one apply run.
 */
interface ResolvedCut {
  section: Section | 'skills';
  index: number;
  /** Null when the whole entry — or the whole skills line — goes. */
  text: string | null;
  /** What to call it in the log. Only on an entry or a skills line. */
  name?: string;
}

/**
 * The cuts that may actually be taken, in the order they were ranked.
 *
 * Everything unsafe or impossible is filtered out here rather than in the loop,
 * so that any PREFIX of the result is safe to apply — which is what lets the
 * search below try a half of it and trust the answer. Four things get dropped:
 *
 *   - a bullet that is not on the resume, because the ranking names what the
 *     model wrote and the honesty check may since have put the person's own
 *     sentence back in its place;
 *   - the last bullet of an entry, because a heading with nothing under it is
 *     worse than either keeping the entry or cutting the whole thing. The guard
 *     restores an entry that comes back empty, but it has already run by now;
 *   - the last job, always, however it was ranked;
 *   - anything naming an entry that is not there.
 */
function usableCuts(
  structure: ResumeStructure,
  targets: CutTarget[],
  posting = '',
): { cuts: ResolvedCut[]; ranked: number } {
  // Working copies, so the simulation can spend bullets as it goes and know
  // what each entry has left by the time a later cut asks.
  const remaining: Record<Section, string[][]> = {
    experience: (structure.experience ?? []).map((entry) => [...(entry.bullets ?? [])]),
    projects: (structure.projects ?? []).map((entry) => [...(entry.bullets ?? [])]),
  };
  const identity: Record<Section, string[]> = {
    experience: (structure.experience ?? []).map((entry) => `${norm(entry.org)}|${norm(entry.dates)}`),
    projects: (structure.projects ?? []).map((entry) => `${norm(entry.name)}|${norm(entry.dates)}`),
  };
  // What to call an entry the APP decided to drop. The ranking supplies its own
  // wording; these are for the cuts it never proposed.
  const label: Record<Section, string[]> = {
    experience: (structure.experience ?? []).map((entry) => entry.org || entry.title || 'a role'),
    projects: (structure.projects ?? []).map((entry) => entry.name || 'a project'),
  };
  const gone: Record<Section, Set<number>> = { experience: new Set(), projects: new Set() };

  /**
   * Whether this entry may go, given what has already gone.
   *
   * Two floors. A resume with no work history is not a shorter resume — that
   * one was always here. The second was not, and the ranking could walk
   * straight through it: dropping every project in turn left a Projects heading
   * over nothing, or over one entry whose bullets had been trimmed away. A
   * section survives only while something under it still says what it was.
   */
  // Two of each, or all of them where somebody has fewer — a floor stops
  // cutting, it never invents a second job for a person with one.
  const floor: Record<Section, number> = {
    experience: Math.min(MIN_JOBS, identity.experience.length),
    projects: Math.min(MIN_PROJECTS, identity.projects.length),
  };

  const mayDrop = (section: Section, at: number): boolean => {
    if (identity[section].length - gone[section].size <= floor[section]) return false;
    return remaining[section].some((bullets, i) => i !== at && !gone[section].has(i) && bullets.length > 0);
  };

  const takeEntry = (target: Extract<CutTarget, { kind: 'entry' }>): ResolvedCut | null => {
    const section = target.section;
    if (!norm(target.name)) return null;
    const key = `${norm(target.name)}|${norm(target.dates)}`;
    const at = identity[section].findIndex((k, i) => k === key && !gone[section].has(i));
    if (at === -1) return null;
    if (!mayDrop(section, at)) return null;
    gone[section].add(at);
    return { section, index: at, text: null, name: target.name };
  };

  const takeBullet = (text: string): ResolvedCut | null => {
    for (const section of SECTIONS) {
      for (let i = 0; i < remaining[section].length; i += 1) {
        if (gone[section].has(i)) continue;
        const list = remaining[section][i];
        // An entry is never trimmed below the floor. An entry that arrived with
        // fewer is left exactly as it is — the floor stops trimming, it does
        // not pad.
        if (list.length <= MIN_BULLETS) continue;
        const at = list.indexOf(text);
        if (at === -1) continue;
        list.splice(at, 1);
        return { section, index: i, text };
      }
    }
    return null;
  };

  const usable: ResolvedCut[] = [];
  for (const target of targets) {
    const cut = target.kind === 'entry' ? takeEntry(target) : takeBullet(target.text);
    if (cut) usable.push(cut);
  }
  // Where the person's posting stops deciding and the app starts guessing.
  const ranked = usable.length;

  /*
   * Past the end of the ranking.
   *
   * The model names a handful of things and stops, and the app used to stop
   * with it: every cut applied, still two pages, everything put back, and a
   * message saying it could not be done. Measured on ten real resumes, three
   * of them needed more than the ranking offered — including both that
   * prompted this work.
   *
   * Order is everything here, because the search below takes PREFIXES: the
   * shortest one that fits wins, so whatever is appended first is what gets
   * used first. Bullets before entries, and within each, the least relevant
   * entry before the most.
   *
   * Within a section, from the end. For BULLETS that is a relevance order: the
   * tailor writes the strongest evidence for this posting first, so the last
   * one is the weakest. For ENTRIES it is not — entries are printed in date
   * order and the tailor is told to keep them that way, so the last one is the
   * OLDEST, not the least relevant. That is the default and it is only a
   * default: the relevance call on whole entries is the model's ranking above,
   * and this is what runs when the ranking stops or never came.
   *
   * No relevance score of our own, because it was tried and measured. The same
   * keyword scoring that picks skills lines was run over the four jobs on one
   * real profile against eleven real postings: on the procurement posting it
   * put the procurement job SECOND, behind a wealth-management job that
   * happened to share "planning", "risk" and "communication" with the
   * posting's soft-skills list. A skills line is a list of tool names and
   * matches exactly; a bullet is prose, and prose overlap is mostly noise.
   * Guessing worse than dropping the oldest is not an improvement.
   */
  const weakestFirst = (section: Section) => {
    const out: number[] = [];
    for (let i = remaining[section].length - 1; i >= 0; i -= 1) if (!gone[section].has(i)) out.push(i);
    return out;
  };

  // Bullets, down to the floor. Nothing here can empty an entry.
  for (const section of SECTIONS) {
    for (const i of weakestFirst(section)) {
      const list = remaining[section][i];
      while (list.length > MIN_BULLETS) {
        usable.push({ section, index: i, text: list[list.length - 1] });
        list.pop();
      }
    }
  }

  /*
   * Skills lines, ahead of every entry.
   *
   * Ordered by how little of this posting the line answers — the one relevance
   * judgement the app can make for itself rather than asking the model for. A
   * line naming nothing the employer asked for is the cheapest thing on the
   * page, and a job is the dearest; the fitter was spending them the wrong way
   * round because this was the only one it could not reach.
   */
  const sheddable = (structure.skills ?? []).length - MIN_SKILL_LINES;
  if (sheddable > 0) {
    weakestLines(structure, posting)
      .slice(0, sheddable)
      .forEach((line) => usable.push({ section: 'skills', index: line.i, text: null, name: line.name }));
  }

  /*
   * Then whole entries — the fuller section giving first, so the two shrink
   * together.
   *
   * Built section by section, this emptied one before touching the other. A
   * resume with four jobs and six projects came back with ONE job and five
   * projects, because every experience drop sat ahead of every project drop in
   * the list and the search takes a prefix. The person read it and asked why
   * the app thought they had one job.
   *
   * There is no ranking across sections — the tailor orders within each — so
   * proportion is the fairest thing available: take from whichever has more
   * left, and a tie goes to projects, since a job is the harder thing to
   * replace on a resume and the floors already single experience out for
   * protection.
   *
   * Two floors below that. At least one job, always; and a section may not be
   * reduced to a heading over an entry with nothing under it — a Projects
   * heading printing one bare title line is not a shorter resume, it is a
   * worse one.
   */
  for (;;) {
    const options = SECTIONS.map((section) => ({
      section,
      left: weakestFirst(section).filter((i) => mayDrop(section, i)),
      size: weakestFirst(section).length,
    })).filter((o) => o.left.length > 0);
    if (!options.length) break;

    options.sort((a, b) => b.size - a.size || (a.section === 'projects' ? -1 : 1));
    const { section, left } = options[0];
    const i = left[0];
    gone[section].add(i);
    usable.push({ section, index: i, text: null, name: label[section][i] });
  }

  return { cuts: usable, ranked };
}

/**
 * The skills lines, least relevant to this posting first.
 *
 * Scored on how little of the posting the line answers — the one relevance
 * judgement the app can make for itself rather than asking the model for. A
 * line naming nothing the employer asked for is the cheapest thing on the
 * page and a job is the dearest; the fitter was spending them the wrong way
 * round because a skills line was the only thing it could not reach.
 *
 * Shared by the two places that spend a line: the hard cap, which runs on
 * every resume, and the cut list, which runs only when the page is over. One
 * ranking, so they cannot disagree about which line matters least.
 */
function weakestLines(
  structure: ResumeStructure,
  posting: string,
): { i: number; answers: number; name: string }[] {
  return (structure.skills ?? [])
    .map((group, i) => {
      const items = String(group?.items ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      // The category name counts too: a line headed "AI & Data" on a posting
      // that says AI all the way through is relevant whatever its items are.
      const wanted = [group?.category ?? '', ...items].filter((t) => t.trim());
      const answers = posting.trim()
        ? wanted.filter((term) => waysOfWriting(term).some((way) => patternFor(way).test(posting))).length
        : 0;
      return { i, answers, name: group?.category || 'a skills line' };
    })
    // Fewest answers first; ties broken by position, so the lines a person put
    // last go before the ones they led with.
    .sort((a, b) => a.answers - b.answers || b.i - a.i);
}

/**
 * The skills section, capped, whatever the page count says.
 *
 * Measured on eleven real resumes: when the page was over, the fitter trimmed
 * skills to three; when it fitted, the model's own line count survived — five
 * or six, the same items reordered. So the length of the longest section on
 * the page was decided by whether something ELSE ran long, which is not a
 * decision anybody made. The person's own rule asks for five or fewer.
 *
 * Pins win over the cap: a line somebody marked "always include" stays even
 * when that leaves six. They asked, and the cap is the app's own judgement.
 */
function cappedSkills(
  structure: ResumeStructure,
  posting: string,
  pinned: readonly Pin[],
): { structure: ResumeStructure; dropped: string[] } {
  const lines = structure.skills ?? [];
  if (lines.length <= MAX_SKILL_LINES) return { structure, dropped: [] };

  const spare = lines.length - MAX_SKILL_LINES;
  const gone = new Set<number>();
  for (const line of weakestLines(structure, posting)) {
    if (gone.size >= spare) break;
    const without = { ...structure, skills: lines.filter((_, i) => i !== line.i && !gone.has(i)) };
    if (missingPins(without, pinned).length) continue;
    gone.add(line.i);
  }
  if (!gone.size) return { structure, dropped: [] };

  return {
    structure: { ...structure, skills: lines.filter((_, i) => !gone.has(i)) },
    dropped: [...gone].map((i) => lines[i]?.category || 'a skills line'),
  };
}

/** Entries dropped and bullets removed, by the positions already worked out. */
function trim<T extends { bullets?: string[] }>(
  entries: T[],
  dropped: Set<number>,
  perEntry: Map<number, string[]>,
): T[] {
  return entries
    .map((entry, i) => ({ entry, i }))
    .filter(({ i }) => !dropped.has(i))
    .map(({ entry, i }) => {
      const remove = [...(perEntry.get(i) ?? [])];
      if (!remove.length) return entry;
      return {
        ...entry,
        bullets: (entry.bullets ?? []).filter((text) => {
          const at = remove.indexOf(text);
          if (at === -1) return true;
          // One removal per listed occurrence, so a sentence that genuinely
          // appears twice loses only the copy that was ranked.
          remove.splice(at, 1);
          return false;
        }),
      };
    });
}

/**
 * The resume with those cuts taken.
 *
 * The two sections are written out rather than looped over, and not only to
 * satisfy the compiler — assigning through a union key asks for a value that is
 * both an experience entry and a project entry at once, which nothing is.
 */
function applyCuts(structure: ResumeStructure, cuts: ResolvedCut[]): ResumeStructure {
  const dropped: Record<Section, Set<number>> = { experience: new Set(), projects: new Set() };
  const bullets: Record<Section, Map<number, string[]>> = { experience: new Map(), projects: new Map() };
  const skillsGone = new Set<number>();

  for (const cut of cuts) {
    if (cut.section === 'skills') {
      skillsGone.add(cut.index);
      continue;
    }
    if (cut.text === null) {
      dropped[cut.section].add(cut.index);
      continue;
    }
    const list = bullets[cut.section].get(cut.index) ?? [];
    list.push(cut.text);
    bullets[cut.section].set(cut.index, list);
  }

  return {
    ...structure,
    experience: trim(structure.experience ?? [], dropped.experience, bullets.experience),
    projects: trim(structure.projects ?? [], dropped.projects, bullets.projects),
    skills: (structure.skills ?? []).filter((_, i) => !skillsGone.has(i)),
  };
}

/**
 * What was cut, in the person's terms.
 *
 * Entries are named rather than counted. Losing a whole project is the biggest
 * thing this file does, and "dropped 2 projects" leaves somebody hunting the
 * page for which two.
 */
function describe(cuts: ResolvedCut[], target: number): string[] {
  const dropped = new Set(cuts.filter((c) => c.text === null).map((c) => `${c.section}:${c.index}`));
  const lines: string[] = [];

  const named = (section: Section | 'skills', noun: string) => {
    const group = cuts.filter((c) => c.text === null && c.section === section);
    if (!group.length) return;
    lines.push(
      `Dropped ${group.length} ${group.length === 1 ? noun : `${noun}s`} to fit ${pagesWord(target)}: ${group
        .map((c) => c.name)
        .join(', ')}.`,
    );
  };
  named('skills', 'skills line');
  named('projects', 'project');
  named('experience', 'role');

  // Bullets inside an entry that went are not counted: they were not a choice,
  // and claiming them would overstate what the person actually gave up.
  const trimmed = cuts.filter((c) => c.text !== null && !dropped.has(`${c.section}:${c.index}`)).length;
  if (trimmed) {
    lines.push(
      `Cut ${trimmed} ${trimmed === 1 ? 'bullet' : 'bullets'} to fit ${pagesWord(target)} — the ones ranked least relevant to this posting.`,
    );
  }

  return lines;
}

/**
 * Measures the resume and, if it runs long, cuts as little as will fit.
 *
 * The search order is deliberate and is about the budget rather than about
 * elegance. There is room for roughly three compiles after a tailor, so the
 * whole ranking is tried FIRST: it answers "can this be fixed at all" in one
 * measurement, and it means running out of budget mid-search still leaves a
 * version that fits. Bisecting from the other end would spend the same budget
 * and, on a bad first probe, finish knowing only that some cut somewhere might
 * have worked — and cut nothing.
 */
export async function fitToPages(structure: ResumeStructure, opts: FitOptions): Promise<FitResult> {
  /*
   * What they said to keep, less whatever is already not here.
   *
   * A pin is kept with the application and this resume is rebuilt from the
   * profile every time, so a pin can outlive the thing it named: a bullet the
   * tailor has since reworded, a skill taken out of the profile, a job
   * deleted. A pin the resume does not already keep is not something the
   * fitter can break, and treating it as one would report a page rule as
   * unmeetable on every future tailor for a sentence nobody could satisfy.
   */
  const pinned = (opts.pinned ?? []).filter((pin) => !missingPins(structure, [pin]).length);
  const breaks = (candidate: ResumeStructure) => missingPins(candidate, pinned);

  /*
   * The cap first, before anything is measured.
   *
   * It is not a page decision and must not wait on one: measured across
   * eleven real resumes, the ones that ran long had skills trimmed to three
   * and the ones that fitted kept whatever the model returned — five or six.
   * The longest section on the page was sized by whether something else ran
   * over, which is nobody's decision.
   */
  const capped = cappedSkills(structure, opts.posting ?? '', pinned);
  structure = capped.structure;
  const capLog = capped.dropped.length
    ? [
        `Technical Skills was ${capped.dropped.length + MAX_SKILL_LINES} lines; your rules ask for ${MAX_SKILL_LINES} or fewer, so ` +
          `${capped.dropped.join(', ')} ${capped.dropped.length === 1 ? 'went' : 'went'} — ${capped.dropped.length === 1 ? 'the line' : 'the lines'} this posting mentions least.`,
      ]
    : [];
  const unchanged = { structure, log: capLog, warnings: [] as string[], dropped: [] as DroppedEntry[] };

  // No budget to measure, so nothing is known and nothing is claimed. A page
  // rule reads as guidance on a resume whose length nobody counted.
  if (!opts.affords()) return { ...unchanged, pages: null };

  const pages = await opts.measure(structure);
  if (pages === null) return { ...unchanged, pages: null };
  if (pages <= opts.target) return { ...unchanged, pages };

  const tooLong = `This runs to ${pagesWord(pages)} and your rules ask for ${pagesWord(opts.target)}.`;

  const all = usableCuts(structure, opts.cuts, opts.posting ?? '');
  const ranked = all.ranked;
  // Cuts that would spend a pin, taken off the table before anything is
  // measured. Each is judged on its own, which is exact for every pin naming
  // one thing in one place; the search below re-checks the set it settles on.
  const cuts = pinned.length ? all.cuts.filter((cut) => !breaks(applyCuts(structure, [cut])).length) : all.cuts;
  if (!cuts.length) {
    return {
      ...unchanged,
      pages,
      warnings: [
        pinned.length
          ? `${tooLong} Everything left to cut is something you asked to keep, so it was left as it is.`
          : `${tooLong} There was nothing safe to cut, so it was left as it is.`,
      ],
    };
  }

  // Everything the ranking offers. If even this does not fit, no prefix of it
  // will, and the person keeps their full resume rather than a shortened one
  // that still breaks the rule.
  if (!opts.affords()) return { ...unchanged, pages };
  /*
   * Measured, unless it spends a pin — in which case it did not fit.
   *
   * The per-cut filter above catches every pin that names one thing in one
   * place, which is all of them in practice. This is for the one that does
   * not: a tool listed on two skills lines, where dropping either line alone
   * keeps it and dropping both does not. "Did not fit" is already how a
   * candidate gets rejected everywhere below, so the awkward case needs no
   * second code path.
   */
  const measureKeeping = async (candidate: ResumeStructure) =>
    breaks(candidate).length ? null : opts.measure(candidate);

  const most = applyCuts(structure, cuts);
  const mostPages = await measureKeeping(most);
  if (mostPages === null || mostPages > opts.target) {
    return {
      ...unchanged,
      pages,
      /*
       * Everything the app is allowed to cut, and it still does not fit.
       *
       * The full resume is kept rather than a shortened one that breaks the
       * rule anyway — and the message says what to do about it, because
       * "nothing was cut" left somebody staring at a rule their resume cannot
       * meet with no idea what to try next.
       */
      /*
       * Two different sentences, because there are two different situations
       * and only one of them is the person's problem to solve. Pinned content
       * that will not fit is the app keeping a promise — it says which promise
       * and that the rule is what gave, rather than sending them off to take
       * something off a resume they already told it what to keep on.
       */
      warnings: [
        pinned.length
          ? `${tooLong} ${pinnedOverLine(pinned, pages, opts.target)}`
          : `${tooLong} Even cutting everything least relevant to this posting, it will not fit — there is too much on it. Two pages, or take something off yourself.`,
      ],
    };
  }

  // Now walk it back. Fewer cuts is always better, and the answer is known to
  // exist, so whatever budget is left goes on finding a smaller one.
  let best = { structure: most, pages: mostPages, cuts };
  let lo = 1;
  let hi = cuts.length - 1;
  while (lo <= hi && opts.affords()) {
    const mid = Math.floor((lo + hi) / 2);
    const taken = cuts.slice(0, mid);
    const trial = applyCuts(structure, taken);
    const measured = await measureKeeping(trial);
    if (measured !== null && measured <= opts.target) {
      best = { structure: trial, pages: measured, cuts: taken };
      hi = mid - 1;
    } else {
      // A compile that failed outright is treated as "did not fit". It is the
      // safe reading: the alternative is saving a resume nobody measured as if
      // it had passed.
      lo = mid + 1;
    }
  }

  /*
   * Said out loud when the posting stopped deciding.
   *
   * Past the end of the ranking the app chooses on its own, with no idea what
   * this job asks for — and that is how somebody got one job and five
   * projects. The model is told to rank everything precisely so this never
   * fires; a log line is how we find out when it does, instead of discovering
   * it in a screenshot.
   */
  if (best.cuts.length > ranked) {
    console.error(
      `[Resumi9] The cut ranking covered ${ranked} of the ${best.cuts.length} cuts needed — ` +
        'the rest were chosen without reference to the posting.',
    );
  }

  return {
    structure: best.structure,
    pages: best.pages,
    log: [...capLog, ...describe(best.cuts, opts.target)],
    warnings: [],
    // Read off the ORIGINAL structure, by the position each cut recorded, so
    // what is kept is the entry as the reader would have seen it.
    // Entries only. A skills line is not something anybody asks to have put
    // back by name, and the restore path splices entries into experience and
    // projects.
    dropped: best.cuts
      .filter((c): c is ResolvedCut & { section: Section } => c.text === null && c.section !== 'skills')
      .map((c) => ({
        section: c.section,
        index: c.index,
        name: c.name ?? 'an entry',
        entry: (structure[c.section] ?? [])[c.index],
      }))
      .filter((d) => d.entry),
  };
}
