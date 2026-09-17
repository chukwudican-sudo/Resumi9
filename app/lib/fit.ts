import type { CutTarget } from './provenance';
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

export interface FitOptions {
  /** How many pages it may run to. From the person's rules; two by default. */
  target: number;
  /** What may go, least relevant first. */
  cuts: CutTarget[];
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
}

const pagesWord = (n: number) => (n === 1 ? 'one page' : `${n} pages`);

/** Letters and digits only — the same comparison the tailoring guard makes. */
const norm = (text: string | null | undefined) => (text ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** One cut from the ranking, already located on this resume. */
interface ResolvedCut {
  section: Section;
  index: number;
  /** Null when the whole entry goes. */
  text: string | null;
  /** What to call it in the log. Only on an entry. */
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
function usableCuts(structure: ResumeStructure, targets: CutTarget[]): ResolvedCut[] {
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
  const gone: Record<Section, Set<number>> = { experience: new Set(), projects: new Set() };

  const takeEntry = (target: Extract<CutTarget, { kind: 'entry' }>): ResolvedCut | null => {
    const section = target.section;
    if (!norm(target.name)) return null;
    const key = `${norm(target.name)}|${norm(target.dates)}`;
    const at = identity[section].findIndex((k, i) => k === key && !gone[section].has(i));
    if (at === -1) return null;
    // The floor. A resume with no work history is not a shorter resume, and
    // this is the one thing the ranking is not allowed to talk the app into.
    if (section === 'experience' && identity.experience.length - gone.experience.size <= 1) return null;
    gone[section].add(at);
    return { section, index: at, text: null, name: target.name };
  };

  const takeBullet = (text: string): ResolvedCut | null => {
    for (const section of SECTIONS) {
      for (let i = 0; i < remaining[section].length; i += 1) {
        if (gone[section].has(i)) continue;
        const list = remaining[section][i];
        // An entry keeps its last bullet.
        if (list.length <= 1) continue;
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
  return usable;
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

  for (const cut of cuts) {
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

  const named = (section: Section, noun: string) => {
    const group = cuts.filter((c) => c.text === null && c.section === section);
    if (!group.length) return;
    lines.push(
      `Dropped ${group.length} ${group.length === 1 ? noun : `${noun}s`} to fit ${pagesWord(target)}: ${group
        .map((c) => c.name)
        .join(', ')}.`,
    );
  };
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
  const unchanged = { structure, log: [] as string[], warnings: [] as string[] };

  // No budget to measure, so nothing is known and nothing is claimed. A page
  // rule reads as guidance on a resume whose length nobody counted.
  if (!opts.affords()) return { ...unchanged, pages: null };

  const pages = await opts.measure(structure);
  if (pages === null) return { ...unchanged, pages: null };
  if (pages <= opts.target) return { ...unchanged, pages };

  const tooLong = `This runs to ${pagesWord(pages)} and your rules ask for ${pagesWord(opts.target)}.`;
  const cuts = usableCuts(structure, opts.cuts);
  if (!cuts.length) {
    return {
      ...unchanged,
      pages,
      warnings: [`${tooLong} There was nothing safe to cut, so it was left as it is.`],
    };
  }

  // Everything the ranking offers. If even this does not fit, no prefix of it
  // will, and the person keeps their full resume rather than a shortened one
  // that still breaks the rule.
  if (!opts.affords()) return { ...unchanged, pages };
  const most = applyCuts(structure, cuts);
  const mostPages = await opts.measure(most);
  if (mostPages === null || mostPages > opts.target) {
    return {
      ...unchanged,
      pages,
      warnings: [`${tooLong} Cutting the least relevant parts was not enough to get there, so nothing was cut.`],
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
    const measured = await opts.measure(trial);
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

  return {
    structure: best.structure,
    pages: best.pages,
    log: describe(best.cuts, opts.target),
    warnings: [],
  };
}
