import Anthropic from '@anthropic-ai/sdk';
import { callClaude } from './anthropic';
import type { ResumeStructure } from './types';
import { STORED_ELSEWHERE, contentFor, hasContent, planSections } from './sections';

/**
 * Spelling, and nothing else.
 *
 * This was one of four jobs in the polish call and it was the one that got
 * dropped. Asked to proofread, group the skills, order the sections and write
 * warnings in a single response, the model reliably did the last three and
 * returned no corrections at all — on a resume containing "Dean Listst" and
 * "Ms Powerpoinnt". Given the same resume and only this to do, it found both,
 * twice out of twice.
 *
 * Four attempts at rewording the combined prompt changed nothing, which is
 * usually the sign that the structure is wrong rather than the words. So this
 * is its own call with its own tool, and there is nothing in the response for
 * attention to go to instead.
 */

export const PROOFREAD_PROMPT = `You are proofreading a resume. Spelling only.

List every misspelled word you find. A correction is the misspelled word and its fix — never a rewritten phrase, and never a sentence. You are not editing: if a line is clumsy, badly worded or too long, that is not yours to touch and an attempt to fix it here will be discarded.

Check carefully the names you do know. Universities, companies, cities, provinces, states, countries, awards and honours are things you know the spelling of — "Dean Listst" is "Dean's List", "Univeristy" is "University", "Oshawa, ONtalio" is "Oshawa, Ontario", "San Fransisco" is "San Francisco". A misspelled award is the most embarrassing kind, because it is the part somebody was proud enough to include.

A place name is two words often enough that people mistype the second one and read past it. Check the part after the comma as carefully as the part before it.

Leave alone, always:
- technical terms, libraries, tools and product names — pytest, matplotlib, PostgreSQL, Kubernetes. A spellchecker flags all of these and every "fix" would be damage.
- names you do not recognise. An unfamiliar company or product is far likelier to be spelled correctly than to be a typo you can fix. This does not cover places: there are a few hundred provinces, states and countries and you know them, so an unrecognised one is a typo rather than somewhere you have not heard of.
- numbers, dates, and anything inside a web address.
- British or Canadian spellings. "organisation" and "colour" are not typos.

Return an empty list only after reading every line. Most resumes have at least one.`;

const PROOFREAD_TOOL: Anthropic.Tool = {
  name: 'submit_corrections',
  description: 'Every misspelling found in the resume, as the wrong word and its fix.',
  input_schema: {
    type: 'object',
    properties: {
      corrections: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            from: { type: 'string', description: 'The misspelled word, exactly as it appears.' },
            to: { type: 'string', description: 'What it should say.' },
            reason: { type: 'string', description: 'One short sentence, addressed to the person.' },
          },
          required: ['from', 'to', 'reason'],
          additionalProperties: false,
        },
      },
    },
    required: ['corrections'],
    additionalProperties: false,
  },
};

export interface Correction {
  from: string;
  to: string;
  reason: string;
}

/**
 * Everything on the resume that is text somebody wrote, as plain lines.
 *
 * Built from the section plan rather than from a list of five field names. It
 * WAS that list — name, skills, education, experience, projects — which was
 * everything a resume could hold back when the app named the sections. Once
 * they became the person's own, this function kept claiming to be "everything"
 * while quietly meaning "the five I know", and a certifications section went to
 * print carrying "Creditial Id 1000" and "Torojjto, ON" twice each. The
 * spellchecker did not miss them; it was never shown them.
 */
export function readableText(structure: ResumeStructure, contactName?: string): string {
  const lines: string[] = [
    contactName ? `NAME\n${contactName}` : '',
    '',
    'SKILLS',
    ...structure.skills.map((s) => `${s.category}: ${s.items}`),
    '',
    'EDUCATION',
    ...structure.education.flatMap((e) => [e.school, e.degree, e.location, ...(e.bullets ?? [])]),
    '',
    'EXPERIENCE',
    ...structure.experience.flatMap((x) => [`${x.title} — ${x.org} — ${x.location}`, ...x.bullets]),
    '',
    'PROJECTS',
    // The url is left out on purpose: an address looks misspelled to any
    // spellchecker and "fixing" one produces a dead link.
    ...structure.projects.flatMap((p) => [`${p.name} — ${p.tech}`, ...p.bullets]),
  ];

  // Everything else this person's resume has.
  //
  // The four above are spelled out field by field because which field is which
  // matters: education's location is worth checking and its dates are not.
  // Dates are the reason this is not one generic loop — "Sep 2023 – 2028" looks
  // misspelled to any spellchecker, and a correction landing on a date is worse
  // than the typo it was chasing.
  for (const section of planSections(structure)) {
    if (STORED_ELSEWHERE.has(section.key)) continue;
    const content = contentFor(structure, section);
    if (!hasContent(content)) continue;

    lines.push('', section.label.toUpperCase());
    switch (content.shape) {
      case 'entries':
      case 'inline':
        for (const e of content.shape === 'entries' ? content.entries : []) {
          // heading, the line under it, and the place — never the date column.
          lines.push([e.heading, e.sub, e.subRight].filter(Boolean).join(' — '), ...e.bullets);
        }
        for (const e of content.shape === 'inline' ? content.entries : []) {
          lines.push([e.name, e.tech].filter(Boolean).join(' — '), ...e.bullets);
        }
        break;
      case 'groups':
        for (const g of content.groups) lines.push(g.items ? `${g.category}: ${g.items}` : g.category);
        break;
      case 'list':
        lines.push(...content.items);
        break;
      case 'prose':
        lines.push(content.text);
        break;
    }
  }

  return lines.filter((line) => line !== undefined).join('\n');
}

/**
 * The proper nouns this person has put on their own resume.
 *
 * The prompt used to name two projects as examples of things not to
 * "correct" — and they were one account's projects, sent in every other
 * person's proofread. Worse than a leak, it was the wrong list: it protected
 * two names nobody else has and said nothing about the employer, school or
 * product the reader actually typed.
 *
 * A name somebody wrote into their own profile is theirs. They may have
 * misspelled it, but a model cannot tell a misspelling from an unfamiliar
 * company, and the cost is asymmetric: a missed typo in a product name is a
 * blemish, while "fixing" a real employer's name puts a wrong employer on a
 * resume that goes to that employer.
 */
export function ownNames(structure: ResumeStructure): string[] {
  const list = (value: unknown) => (Array.isArray(value) ? value : []);
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  /*
   * Names, not vocabulary.
   *
   * An employer, a school, a project, a certificate and an award are things
   * only this person can spell — a model has no way to tell "Grüner Logistik"
   * from a typo, and "correcting" one puts a wrong employer on a resume that
   * goes to that employer.
   *
   * Skills and tech lines are deliberately NOT here, and that is a reversal.
   * They look like the same category and they are not: "PostgresSQL",
   * "Kubernets" and "Javascrpt" are exactly the typos a reader notices and a
   * spellchecker can fix, and marking the whole skills section correct by
   * fiat is how they survive to an employer. The prompt already tells the
   * model to leave technical terms it recognises alone; that is a judgement
   * about a word it knows, which is different from a blanket exemption for
   * whatever somebody typed.
   */
  const names = [
    ...list(structure.experience).map((e) => text((e as { org?: string }).org)),
    ...list(structure.projects).map((p) => text((p as { name?: string }).name)),
    ...list(structure.education).map((e) => text((e as { school?: string }).school)),
    ...list(structure.certifications).map((c) => text(c)),
    ...list(structure.awards).map((a) => text(a)),
  ].filter(Boolean);

  const seen = new Set<string>();
  return names.filter((n) => {
    const key = n.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function proofread(
  userId: string,
  structure: ResumeStructure,
  contactName?: string,
): Promise<Correction[]> {
  /*
   * Their own names, listed for this call only. Capped because a long skills
   * section would otherwise dominate the prompt, and the longest names are
   * the ones a spellchecker is likeliest to mangle.
   */
  const mine = ownNames(structure).sort((a, b) => b.length - a.length).slice(0, 60);
  const { toolInput } = await callClaude<{ corrections: Correction[] }>({
    userId,
    kind: 'proofread',
    system: mine.length
      ? `${PROOFREAD_PROMPT}\n\nThese are this person's own names for their employers, schools, projects, certificates and awards, exactly as they wrote them. Treat every one as correct and never return a correction for any of them. This list is names only — it is not their skills, and a misspelled tool or language is still a misspelling worth catching:\n${mine.join(', ')}`
      : PROOFREAD_PROMPT,
    content: [{ type: 'text' as const, text: readableText(structure, contactName) }],
    tool: PROOFREAD_TOOL,
  });

  return Array.isArray(toolInput?.corrections) ? toolInput.corrections : [];
}
