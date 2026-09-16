import type { ResumeStructure } from './types';
import { textOf } from './ruleCheck';

/**
 * Which of a posting's requirements are already on a resume.
 *
 * Shown on the application page while the tailor is still writing, so it has
 * to cost nothing and arrive with the page: no model call, just the posting's
 * own extracted requirements checked against the words on the profile. A match
 * that needed a model would add to the very wait it is there to fill.
 *
 * **Word-for-word, with three loosenings and no more:**
 *
 *   - Spacing and hyphens. "Power BI", "PowerBI" and "Power-BI" are one tool.
 *   - Spelling. The tailor writes Canadian English, so "visualisation" and
 *     "modelling" on a resume meet "visualization" and "modeling" in a posting.
 *   - Other names for the same thing, in ALIASES. "LLM" on a resume is
 *     generative AI; "MS Excel" in a posting is Excel.
 *
 * What it will not do is count a RELATED skill. Power BI is not Tableau, and
 * PostgreSQL is not the word SQL. That is why the screen says "not found on
 * your resume" rather than "you don't have it": a literal check can honestly
 * claim the first and never the second.
 */

export interface RequirementMatch {
  /** Found on the resume, in the posting's own order. */
  have: string[];
  /** Not found, in the posting's own order. */
  missing: string[];
}

/**
 * Other ways a resume says the same thing a posting asked for.
 *
 * Directional on purpose: a key is what the POSTING asked for, and its values
 * are what satisfy it. LLM work is generative AI, but a resume that says
 * "generative AI" may mean image models, so it does not satisfy a posting that
 * asks for LLMs. Same thing, different name — never a neighbouring skill.
 */
const ALIASES: Record<string, string[]> = {
  'generative ai': ['genai', 'gen ai', 'llm', 'large language model'],
  llm: ['large language model'],
  llms: ['llm', 'large language model'],
  'large language model': ['llm'],
  'large language models': ['llm'],
  ai: ['artificial intelligence'],
  'artificial intelligence': ['ai'],
  ml: ['machine learning'],
  'machine learning': ['ml'],
  nlp: ['natural language processing'],
  'natural language processing': ['nlp'],
  javascript: ['js'],
  postgres: ['postgresql'],
  postgresql: ['postgres'],
  'node.js': ['nodejs'],
  nodejs: ['node.js'],
  aws: ['amazon web services'],
  'amazon web services': ['aws'],
  gcp: ['google cloud'],
  'google cloud': ['gcp'],
  kubernetes: ['k8s'],
  'ci/cd': ['ci cd', 'continuous integration'],
  rest: ['restful'],
  'rest api': ['restful'],
};

export function matchRequirements(
  structure: ResumeStructure | null | undefined,
  requirements: string[],
): RequirementMatch {
  const haystack = structure ? textOf(structure).map((t) => t.text).join('\n') : '';
  const have: string[] = [];
  const missing: string[] = [];
  for (const requirement of requirements) {
    const found = haystack !== '' && waysOfWriting(requirement).some((way) => patternFor(way).test(haystack));
    (found ? have : missing).push(requirement);
  }
  return { have, missing };
}

/**
 * The requirement, its aliases, and its forms without a vendor prefix or plural.
 *
 * Exported because the guard needs the same reading of a technical term: it was
 * deciding whether a skill had been dropped by exact string, so a model that
 * wrote "Git/GitHub" for "Git, GitHub" or "Data Pipelines/ETL" for "Data
 * Pipelines" had its skills "restored" into a duplicate.
 */
export function waysOfWriting(requirement: string): string[] {
  const term = requirement.trim().toLowerCase();
  if (!term) return [];
  const ways = new Set([term, ...(ALIASES[term] ?? [])]);
  // "MS Excel", "Microsoft Word": the product, whoever made it.
  const vendor = /^(?:ms|microsoft)\s+(.+)$/.exec(term);
  if (vendor) ways.add(vendor[1]);
  // "REST APIs" asked for; "REST API" written. Not below four letters, where
  // stripping an s turns "aws" into something else, and never a double s.
  if (term.length >= 4 && term.endsWith('s') && !term.endsWith('ss')) ways.add(term.slice(0, -1));
  return [...ways];
}

/**
 * One way of writing a term, as a pattern that finds only that term.
 *
 * The boundaries are hand-rolled rather than `\b`, because `\b` fails exactly
 * where technical terms live: it cannot see the end of "C++" or "C#", and it
 * happily finds the "C" inside "C++". Here a match may not touch another letter,
 * digit, plus or hash on either side.
 */
export function patternFor(way: string): RegExp {
  const body = way
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/i[sz](e|ed|es|ing|ation|ations|er|ers)(?![a-z])/g, 'i[sz]$1')
    .replace(/y[sz](e|ed|es|ing|er|ers)(?![a-z])/g, 'y[sz]$1')
    .replace(/el{1,2}(ing|ed|er|ers)(?![a-z])/g, 'el{1,2}$1')
    // A separator that may not be there at all. "Power BI" is written "PowerBI"
    // and "back-end" is written "backend" — and when a requirement term is
    // checked against the bullet it came from, a hyphen that only exists on one
    // side reads as a different word. That cost a good rewrite once: "worked
    // across mobile, backend, and web" became "front-end (mobile, web) and
    // back-end development" — the same fact in the posting's vocabulary, which
    // is the whole job — and the honesty check called it an invented claim.
    .replace(/[\s-]+/g, '[\\s\\-]*');
  // A plural on the resume still counts: "APIs" for "API". Not on one- and
  // two-letter terms, where an s makes a different word ("C" and "CS").
  const plural = way.length >= 3 && /[a-z]$/.test(way) && !way.endsWith('s') ? 's?' : '';
  return new RegExp(`(?<![a-z0-9+#])${body}${plural}(?![a-z0-9+#])`, 'i');
}
