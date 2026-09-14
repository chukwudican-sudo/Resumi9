import type { ResumeStructure } from './types';
import { contentFor, planSections } from './sections';
import type { CheckableRule, RuleResult } from './rules';

/** A piece of free text, and enough about where it came from to go and fix it. */
interface Located {
  /** "your Droady bullet", "your Education entry". Reads inside a sentence. */
  where: string;
  text: string;
}

/**
 * Every piece of free text in a resume, with its provenance.
 *
 * **Not `readableText`, and that is deliberate.** `proofread.ts` already walks a
 * whole structure and looks like the thing to reuse — but it drops dates and
 * URLs on purpose (an address looks misspelled to any spellchecker), it keeps no
 * record of which field a hit came from, and it interleaves section names as
 * literal lines. A search for a banned word run over its output would match the
 * line `SKILLS` and report a hit nobody can act on.
 *
 * This is a different job. A banned-word search has no reason to skip a date or
 * a URL, and "found in your Droady bullet" is a fix somebody can make where
 * "found somewhere" is a puzzle.
 *
 * What it DOES reuse is the layer underneath: `planSections` and `contentFor`
 * already express "every section, known or custom, with all of its text" once,
 * and are already shared by two other walkers for exactly that reason. Only the
 * name and the contact block sit outside them.
 */
export function textOf(structure: ResumeStructure): Located[] {
  const out: Located[] = [];
  const add = (where: string, text?: string | null) => {
    const t = (text ?? '').trim();
    if (t) out.push({ where, text: t });
  };

  add('your name', structure.name);
  for (const [field, value] of Object.entries(structure.contact ?? {})) {
    add(`your ${field}`, value as string | undefined);
  }

  for (const section of planSections(structure)) {
    const content = contentFor(structure, section);
    const where = section.label;

    switch (content.shape) {
      case 'entries':
        for (const e of content.entries) {
          const at = e.heading ? `your ${nameOf(e.heading, e.sub)} entry` : `your ${where} section`;
          add(at, e.heading);
          add(at, e.headingRight);
          add(at, e.sub);
          add(at, e.subRight);
          add(at, e.url);
          e.bullets.forEach((b) => add(`a bullet on ${at}`, b));
        }
        break;

      case 'inline':
        for (const e of content.entries) {
          const at = e.name ? `your ${e.name} entry` : `your ${where} section`;
          add(at, e.name);
          add(at, e.tech);
          add(at, e.url);
          add(at, e.dates);
          e.bullets.forEach((b) => add(`a bullet on ${at}`, b));
        }
        break;

      case 'groups':
        for (const g of content.groups) {
          add(`your ${g.category || where} group`, g.category);
          add(`your ${g.category || where} group`, g.items);
        }
        break;

      case 'list':
        content.items.forEach((i) => add(`your ${where} section`, i));
        break;

      case 'prose':
        add(`your ${where}`, content.text);
        break;
    }
  }

  return out;
}

/**
 * What to call an entry so somebody can find it.
 *
 * The heading alone is not always enough: for a job it is the TITLE, so two
 * engineering roles both come back as "your Software Engineer entry" and the
 * message names neither. The second line usually settles it — but only
 * sometimes, because the slot means different things by section. For experience
 * it holds the employer; for education it holds the whole degree.
 *
 * Length is the tell, and it is a better one than it looks: a short second line
 * is a name (Droady, Ontario Tech) and identifies the entry, while a long one is
 * a description (Bachelor of Engineering in Software Engineering) and only
 * makes the sentence worse.
 */
function nameOf(heading: string, sub: string): string {
  const second = sub.trim();
  return second && second.length <= 40 ? `${heading} at ${second}` : heading;
}

/** Every bullet in the resume, wherever bullets live. */
function bulletsOf(structure: ResumeStructure): Located[] {
  return textOf(structure).filter((t) => t.where.startsWith('a bullet on '));
}

/**
 * Finds a word somebody typed, and only that word.
 *
 * The same escaped-literal-inside-`\b` pattern `correctText` uses, for the same
 * reason its comment gives: without the boundary, forbidding "SQL" would flag
 * every mention of PostgreSQL. Case-insensitive, because a rule about a word is
 * about the word, not about how it was capitalised on the day.
 */
function mentions(haystack: string, term: string): boolean {
  const escaped = term.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!escaped) return false;
  return new RegExp(`\\b${escaped}\\b`, 'i').test(haystack);
}

/**
 * What each rule did to this resume.
 *
 * Arithmetic, not a self-report. The model is never asked whether it obeyed —
 * this codebase has been burned by that before, when a tailor dropped a
 * fifteen-month job and its own change log mentioned the role in none of its
 * sixteen entries. A rule that can be checked is checked; a rule that cannot
 * says so.
 *
 * Costs nothing, so it runs on every render rather than being stored. A rule
 * written today is applied to a resume tailored last week, and nothing can go
 * stale.
 */
export function runChecks(structure: ResumeStructure, rules: CheckableRule[]): RuleResult[] {
  const fields = textOf(structure);
  const bullets = bulletsOf(structure);

  return rules.map((rule): RuleResult => {
    const base = { ruleId: rule.id, text: rule.text };
    if (!rule.check) return { ...base, verdict: 'guidance' };

    if (rule.check.kind === 'forbidden_text') {
      for (const term of rule.check.terms) {
        const hit = fields.find((f) => mentions(f.text, term));
        if (hit) {
          return {
            ...base,
            verdict: 'fail',
            evidence: `“${term}” is in ${hit.where}.`,
            fix: `Rewrite ${hit.where} without the word “${term}”.`,
          };
        }
      }
      return { ...base, verdict: 'pass' };
    }

    const limit = rule.check.limit;
    const over = bullets.filter((b) => b.text.length > limit);
    if (over.length) {
      return {
        ...base,
        verdict: 'fail',
        evidence:
          over.length === 1
            ? `One bullet runs to ${over[0].text.length} characters.`
            : `${over.length} bullets run over ${limit} characters.`,
        fix: `Shorten every bullet to under ${limit} characters.`,
      };
    }
    return { ...base, verdict: 'pass' };
  });
}
