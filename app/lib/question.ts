import { patternFor } from './requirementMatch';
import type { ResumeStructure } from './types';

/**
 * The model's question, with the reading-back-of-names taken out.
 *
 * The app's own question used to name the entries — "Which one? You have
 * Droady, Kudi Kitchen, WesternBell and Aegon" — which was four of ten, a
 * partial list written as a complete one. That was dropped. The model then did
 * the same thing from the other side, on the first live test after it shipped:
 *
 *     Could you clarify which section's "second bullet" you mean — e.g. which
 *     experience or project entry (Droady, Kudi Kitchen, FraudWatch, MealApp,
 *     Resumi, etc.)?
 *
 * Asking it not to is the obvious fix and the one already shown not to hold: a
 * line telling it to say nothing about section order, written the same day, was
 * ignored on that same test. So this is done in code, where being ignored is
 * not one of the options.
 *
 * The app knows every entry name — it wrote them into the prompt — so it can
 * tell a question apart from a list of things it just showed the model. Three
 * different names is the line: one or two can carry real meaning ("the Aegon
 * job or the Aegon project?"), while three is the model enumerating.
 *
 * Trimmed where trimming is safe, replaced where it is not, so both paths end
 * in a question somebody can answer. The cost is that a model question which
 * names three entries for a genuinely good reason loses that detail — a fair
 * trade for never printing a list nobody asked for.
 */

/** What the app asks when it cannot use the model's wording. */
export const PLAIN_QUESTION = 'Which entry? Name the job or project.';

/**
 * Where an aside begins.
 *
 * A name list is introduced, never blurted: a dash, a bracket, a colon, or one
 * of the phrases that means "for instance". Names sitting in the main clause
 * have nothing to cut in front of them and are left alone — "shorten Droady,
 * Kudi Kitchen or FraudWatch?" needs its names to make sense.
 */
const ASIDE = /\s*(?:[—–-]{1,2}\s|\(|:\s|\b(?:e\.?g\.?|i\.?e\.?|such as|for example|for instance|like)\b)/gi;

function namesOn(structure: ResumeStructure): string[] {
  const out: string[] = [];
  for (const job of structure.experience ?? []) {
    if (job?.org) out.push(job.org);
    if (job?.title) out.push(job.title);
  }
  for (const project of structure.projects ?? []) if (project?.name) out.push(project.name);
  for (const school of structure.education ?? []) if (school?.school) out.push(school.school);
  // Two letters or fewer cannot be told from ordinary words at this length.
  return out.map((n) => n.trim()).filter((n) => n.length > 2);
}

export function tidyQuestion(question: string, structure: ResumeStructure): string {
  const asked = (question ?? '').trim();
  if (!asked) return asked;

  const hits = new Map<string, number>();
  for (const name of namesOn(structure)) {
    if (hits.has(name.toLowerCase())) continue;
    const at = asked.search(patternFor(name));
    if (at >= 0) hits.set(name.toLowerCase(), at);
  }
  if (hits.size < 3) return asked;

  const first = Math.min(...hits.values());

  /*
   * The FIRST aside that opens before the names do.
   *
   * The real example has two, a dash and then a bracket, and the whole aside
   * is one thought: "— e.g. which experience or project entry (Droady, …)".
   * Cutting at the later one keeps the half that introduces the list and
   * leaves "you mean — e.g. which experience or project entry?" hanging on a
   * for-instance with no instance. The question proper ends where the first
   * aside begins.
   */
  ASIDE.lastIndex = 0;
  let cut = -1;
  for (let m = ASIDE.exec(asked); m; m = ASIDE.exec(asked)) {
    if (m.index >= first) break;
    cut = m.index;
    break;
  }
  if (cut < 0) return PLAIN_QUESTION;

  const kept = asked.slice(0, cut).replace(/[\s,;:—–-]+$/, '').trim();
  // What is left has to stand as a question on its own. A stub does not.
  if (kept.length < 12 || !/[a-z]/i.test(kept)) return PLAIN_QUESTION;
  return /[?.!]$/.test(kept) ? kept : `${kept}?`;
}
