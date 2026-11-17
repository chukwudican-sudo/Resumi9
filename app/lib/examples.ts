import { splitTerms } from './names';
import type { ResumeStructure } from './types';

/**
 * The suggestions in the change box, written from the person's own resume.
 *
 * These were three hard-coded strings — "shorten the Aegon bullets", "lead
 * with the Python work", and a placeholder reading "Make the FraudWatch
 * bullets shorter…". Aegon and FraudWatch belong to the account the app was
 * built with, so every other person who has ever opened the change box has
 * been shown a stranger's employer and a stranger's project as the example of
 * what to type. It reads as somebody else's data leaking in, which is the
 * worst possible first impression for a tool holding your work history.
 *
 * Built from the structure instead. An example naming something actually on
 * the page is also a better example: it can be pressed and it will work,
 * where "shorten the Aegon bullets" could only ever be a template to edit.
 *
 * Every string degrades to a nameless one when the resume cannot supply a
 * name, because an empty resume still has a change box.
 */

/** An entry with enough lines that shortening it means something. */
function wordiest(structure: ResumeStructure): string | null {
  const entries = [
    ...(structure.experience ?? []).map((e) => ({ name: e.org ?? '', bullets: e.bullets ?? [] })),
    ...(structure.projects ?? []).map((p) => ({ name: p.name ?? '', bullets: p.bullets ?? [] })),
  ].filter((e) => e.name.trim());
  if (!entries.length) return null;

  /*
   * Longest total prose, not most bullets: three short lines are not what
   * somebody wants to shorten, and one long one is.
   */
  const by = (e: { bullets: string[] }) => e.bullets.join(' ').length;
  return [...entries].sort((a, b) => by(b) - by(a))[0]?.name ?? null;
}

/**
 * A skill worth leading with: the one their entries mention most.
 *
 * Counted across the bullets rather than taken off the top of the skills
 * list, because the skills list is ordered by category and its first item is
 * an accident of grouping. A term nothing evidences would make a poor
 * suggestion — the edit would have nothing to lead with.
 */
function mostEvidenced(structure: ResumeStructure): string | null {
  const terms = (structure.skills ?? []).flatMap((g) => splitTerms(g.items ?? ''));
  if (!terms.length) return null;

  const prose = [
    ...(structure.experience ?? []).flatMap((e) => [e.title ?? '', ...(e.bullets ?? [])]),
    ...(structure.projects ?? []).flatMap((p) => [p.tech ?? '', ...(p.bullets ?? [])]),
  ].join(' \n ');

  let best: { term: string; seen: number } | null = null;
  for (const term of terms) {
    const safe = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const seen = (prose.match(new RegExp(`(?<![a-z0-9])${safe}(?![a-z0-9])`, 'gi')) ?? []).length;
    if (seen > 0 && (!best || seen > best.seen)) best = { term, seen };
  }
  return best?.term ?? null;
}

/** Whether anything on the page has a second line to drop. */
const hasSecondLine = (structure: ResumeStructure): boolean =>
  [...(structure.experience ?? []), ...(structure.projects ?? [])].some((e) => (e.bullets ?? []).length >= 2);

/**
 * Three suggestions, each one the person could press as it stands.
 *
 * Deliberately NOT "make it fit one page": the guard restores every entry an
 * edit removes while bullet trims stick, so asking for one page returned a
 * resume that was still two pages and had lost its best bullets. Fitting to a
 * page is the app's job, not an instruction.
 */
export function editExamples(structure: ResumeStructure | null | undefined): string[] {
  const resume = structure ?? ({} as ResumeStructure);
  const entry = wordiest(resume);
  const skill = mostEvidenced(resume);

  return [
    hasSecondLine(resume) ? 'drop the second bullet' : 'make the wording plainer',
    skill ? `lead with the ${skill} work` : 'lead with the most relevant work',
    entry ? `shorten the ${entry} bullets` : 'shorten the longest bullets',
  ];
}

/** The change box's own placeholder, in the same voice. */
export function editPlaceholder(structure: ResumeStructure | null | undefined): string {
  const entry = wordiest(structure ?? ({} as ResumeStructure));
  return entry ? `Make the ${entry} bullets shorter…` : 'Make the longest bullets shorter…';
}
