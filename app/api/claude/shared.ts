import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { CapacityError } from '../../server/limits';
import type { ApiErrorPayload } from '../../lib/types';

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export function errorResponse(payload: ApiErrorPayload, status: number) {
  return NextResponse.json({ error: payload }, { status });
}

/** Standard message for a transient upstream failure. Used in several places. */
export const SERVICE_UNAVAILABLE = 'The AI service is temporarily unavailable. Please try again.';

/**
 * Turns a refused call into a response, or returns null if this was not one.
 *
 * 429 rather than 503: the call was understood and declined, and the
 * distinction matters to anything that retries automatically. Only the
 * user-facing half of the error is sent — the figures stay in the log, because
 * a limit you can read off a response is a limit you can probe.
 */
export function capacityResponse(error: unknown) {
  if (!(error instanceof CapacityError)) return null;
  return errorResponse({ type: 'generic', message: error.userMessage }, 429);
}

export function buildDocumentBlock(file: { base64?: string; mimeType?: string } | undefined) {
  if (!file?.base64) return null;
  return {
    type: 'document' as const,
    source: {
      type: 'base64' as const,
      media_type: (file.mimeType || 'application/pdf') as 'application/pdf',
      data: file.base64,
    },
  };
}

export function buildImageBlock(image: { base64: string; mimeType: string }) {
  return {
    type: 'image' as const,
    source: {
      type: 'base64' as const,
      media_type: image.mimeType as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif',
      data: image.base64,
    },
  };
}

// The ResumeStructure JSON-schema shape, shared by every tool that reads or
// writes a resume (source extraction, tailor, instruct, and later the
// interview's compose step) so they cannot drift apart.
export const RESUME_STRUCTURE_SCHEMA = {
  type: 'object' as const,
  description: 'A resume as structured content (name, contact, sections, entries, bullets) — no layout.',
  properties: {
    name: { type: 'string', description: 'The person\'s full name. Empty string if not found.' },
    contact: {
      type: 'object',
      description: 'Contact details. Omit any field that is not present.',
      properties: {
        phone: { type: 'string' },
        email: { type: 'string' },
        linkedin: { type: 'string' },
        github: { type: 'string' },
        website: { type: 'string' },
      },
      additionalProperties: false,
    },
    summary: { type: 'string', description: 'Optional professional summary/objective. Omit if there is none.' },
    education: {
      type: 'array',
      description: 'Education entries.',
      items: {
        type: 'object',
        properties: {
          school: { type: 'string' },
          location: { type: 'string' },
          degree: { type: 'string' },
          dates: { type: 'string' },
          bullets: { type: 'array', items: { type: 'string' }, description: 'Relevant coursework, honours, thesis. Often empty.' },
        },
        required: ['school', 'location', 'degree', 'dates'],
        additionalProperties: false,
      },
    },
    experience: {
      type: 'array',
      description: 'Work experience entries.',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          dates: { type: 'string' },
          org: { type: 'string' },
          location: { type: 'string' },
          bullets: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'dates', 'org', 'location', 'bullets'],
        additionalProperties: false,
      },
    },
    projects: {
      type: 'array',
      description: 'Project entries.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          tech: { type: 'string' },
          dates: { type: 'string' },
          bullets: { type: 'array', items: { type: 'string' } },
          url: {
            type: 'string',
            description:
              'Link to the project, if there is one. Return it exactly as given — it is the reader\'s way of seeing the work, and it is not yours to edit or drop.',
          },
        },
        required: ['name', 'tech', 'dates', 'bullets'],
        additionalProperties: false,
      },
    },
    skills: {
      type: 'array',
      description: 'Technical skills grouped by category.',
      items: {
        type: 'object',
        properties: {
          category: { type: 'string' },
          items: { type: 'string', description: 'The skills in this category as a single string (e.g. comma-separated).' },
        },
        required: ['category', 'items'],
        additionalProperties: false,
      },
    },
    certifications: {
      type: 'array',
      description: 'Optional certifications. Omit if there are none.',
      items: { type: 'string' },
    },
    awards: {
      type: 'array',
      description: 'Optional awards. Omit if there are none.',
      items: { type: 'string' },
    },
  },
  required: ['name', 'contact', 'education', 'experience', 'projects', 'skills'],
  additionalProperties: false,
};

/**
 * Sections a resume has that are not one of the seven the app knows by name.
 *
 * Deliberately NOT part of RESUME_STRUCTURE_SCHEMA. That schema is what the
 * tailor and the instruct pass read and write, and leaving them unable to
 * return a section makes dropping one impossible rather than merely forbidden —
 * a stronger guarantee than any validator, on a path where a job going missing
 * has happened before. This is attached to the extraction tool alone, which
 * reads a file once and never edits anybody's resume.
 *
 * The model is not asked what KIND of section it is. It returns the content in
 * whichever of these three fits, and the app reads the shape off the content —
 * see inferShape in lib/sections.ts for why a model's own answer to that
 * question is not worth having.
 */
export const EXTRA_SECTIONS_SCHEMA = {
  type: 'array' as const,
  description:
    'Sections on the resume that are not education, experience, projects, skills, summary, certifications or awards — volunteering, extracurriculars, leadership, publications, languages, interests, and anything else it has. Omit if there are none.',
  items: {
    type: 'object' as const,
    properties: {
      label: {
        type: 'string',
        description: 'The section heading, exactly as the resume writes it. Do not tidy or shorten it.',
      },
      entries: {
        type: 'array',
        description:
          'Use when the section is a list of things with headings — a role, a position, a publication. One object per item.',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'The role, position or name.' },
            org: { type: 'string', description: 'The organisation, club, publisher or venue. Omit if there is none.' },
            location: { type: 'string' },
            dates: { type: 'string' },
            url: { type: 'string' },
            bullets: { type: 'array', items: { type: 'string' }, description: 'The lines underneath, in their own words.' },
          },
          required: ['title'],
          additionalProperties: false,
        },
      },
      lines: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Use when the section is a plain list of one-line items — certifications, awards, languages, interests. One string per line, exactly as written.',
      },
      text: {
        type: 'string',
        description: 'Use when the section is a paragraph of prose. The paragraph, exactly as written.',
      },
    },
    required: ['label'],
    additionalProperties: false,
  },
};

/**
 * The resume as a TAILORING pass may return it.
 *
 * A narrower copy of RESUME_STRUCTURE_SCHEMA, because the two jobs are not the
 * same. Reading somebody's PDF has to capture everything on it. Tailoring
 * rewrites bullets and ordering — and `validateTailored` then overwrites
 * everything else with the profile's own values. Asking for those fields bought
 * nothing but tokens, and nothing streams, so every one of them was time
 * somebody spent waiting.
 *
 * Gone: `name`, `contact`, `education[].degree`, `education[].location`,
 * `projects[].url`, `certifications`, `awards` — each assigned straight from the
 * source afterwards, or refused outright.
 *
 * **Kept, and this is the part that looks wrong and is not:** `org`, `dates`,
 * `location` on experience, `school` and `dates` on education, `name`, `tech`
 * and `dates` on projects. They are also overwritten — but `pairUp` uses them to
 * work out WHICH entry came back. Remove them and the guard cannot tell two
 * roles at the same employer apart, which is the exact failure its comments
 * record being built to catch.
 */
/**
 * A tailored bullet: what it now says, and which bullets it came from.
 *
 * `from` is the whole point. Three revisions of the prompt could not stop a
 * faithful rewrite growing a clause nobody earned — "…, working both
 * independently and collaboratively" on a bullet about a 3-person team, "…,
 * using Git-based version control throughout" on a bullet about a CI pipeline.
 * Naming the source makes the claim checkable in code instead of arguable in
 * prose.
 *
 * `text` is optional, and leaving it out is the normal answer for a bullet that
 * did not need changing. It also pays for the check: output tokens are the
 * whole of the wait, and most bullets on most resumes come back as they went.
 */
const TAILORED_BULLET = {
  type: 'object' as const,
  properties: {
    from: {
      type: 'array' as const,
      items: { type: 'string' as const },
      description:
        'The id or ids this bullet is a rewrite of, copied from the profile you were given — a bullet id like "e0.b1", or a fact id like "f3". Every bullet must name at least one, and they must belong to THIS entry: a bullet built from another entry\'s work is that work moved, which is not allowed. Facts with no entry of their own may be used anywhere.',
    },
    text: {
      type: 'string' as const,
      description:
        'The rewritten bullet. Leave it out entirely when the bullet is right as it stands — that is the normal answer for a bullet already written in this posting\'s terms, and it costs nothing to send.',
    },
  },
  required: ['from'],
  additionalProperties: false as const,
};

const TAILORED_STRUCTURE_SCHEMA = {
  ...RESUME_STRUCTURE_SCHEMA,
  properties: {
    summary: RESUME_STRUCTURE_SCHEMA.properties.summary,
    education: {
      ...RESUME_STRUCTURE_SCHEMA.properties.education,
      items: {
        type: 'object' as const,
        properties: {
          // Echoed back, so a bullet's source can be checked against the entry
          // it now sits in.
          id: { type: 'string' as const, description: 'The entry id from the profile, returned unchanged.' },
          // Identity for pairUp. Not editable, and not optional.
          school: { type: 'string' as const },
          dates: { type: 'string' as const },
          bullets: {
            type: 'array' as const,
            items: TAILORED_BULLET,
            description: 'Relevant coursework, honours, thesis. Often empty.',
          },
        },
        required: ['id', 'school', 'dates'],
        additionalProperties: false as const,
      },
    },
    experience: {
      ...RESUME_STRUCTURE_SCHEMA.properties.experience,
      items: {
        type: 'object' as const,
        properties: {
          id: { type: 'string' as const, description: 'The entry id from the profile, returned unchanged.' },
          title: { type: 'string' as const },
          dates: { type: 'string' as const },
          org: { type: 'string' as const },
          location: { type: 'string' as const },
          bullets: { type: 'array' as const, items: TAILORED_BULLET },
        },
        required: ['id', 'title', 'dates', 'org', 'location', 'bullets'],
        additionalProperties: false as const,
      },
    },
    projects: {
      ...RESUME_STRUCTURE_SCHEMA.properties.projects,
      items: {
        type: 'object' as const,
        properties: {
          id: { type: 'string' as const, description: 'The entry id from the profile, returned unchanged.' },
          name: { type: 'string' as const },
          tech: { type: 'string' as const },
          dates: { type: 'string' as const },
          bullets: { type: 'array' as const, items: TAILORED_BULLET },
        },
        required: ['id', 'name', 'tech', 'dates', 'bullets'],
        additionalProperties: false as const,
      },
    },
    skills: RESUME_STRUCTURE_SCHEMA.properties.skills,
  },
  required: ['education', 'experience', 'projects', 'skills'],
};

/**
 * The tailoring tool, shaped to the resume it is tailoring.
 *
 * `summary` exists only when the person's profile has one. The guard drops a
 * summary the master resume does not have — "the person decides what sections
 * they have" — but the field was always on offer, so the model wrote one
 * anyway and then logged "Added a summary framing…" on a resume that has no
 * summary on it. Four tailors out of four said that. A field that cannot reach
 * the page should not be askable.
 *
 * `structuralChanges` is gone with it. It existed to report a bullet moved from
 * one entry into another, which the rules now forbid outright: a fact belongs
 * to the entry it happened in. Asking for the report invited the move — one
 * tailor folded a project into a job of the same name, the guard restored the
 * project, and the same facts appeared twice on one page.
 */
export function tailorToolFor({ hasSummary }: { hasSummary: boolean }): Anthropic.Tool {
  const { summary, ...withoutSummary } = TAILORED_STRUCTURE_SCHEMA.properties;
  const structureSchema = hasSummary
    ? TAILORED_STRUCTURE_SCHEMA
    : { ...TAILORED_STRUCTURE_SCHEMA, properties: withoutSummary };

  return {
  name: 'submit_tailored_resume',
  description: 'Submit the tailored resume as an edited ResumeStructure, with a change log, a match score, the requirements it does not meet, and any warnings.',
  input_schema: {
    type: 'object',
    properties: {
      structure: {
        ...structureSchema,
        description: 'The tailored resume content as a ResumeStructure — the same shape as the input structure, with fields/bullets edited for the job. Name, contact, and dates must be identical to the input.',
      },
      /**
       * Capped, because this was a third of everything the call produced.
       *
       * Asked for "every content change and why", the model wrote a sentence
       * per reworded bullet — 28 lines and 4,113 characters on a resume of 28
       * bullets, about a fifth of the whole wait, for text that scrolls past
       * underneath the resume. Measured on one real posting: 59.4s and 3,235
       * output tokens uncapped, 47-50s and ~2,500 capped, across three runs.
       *
       * Six lines is a summary of what changed, which is what the page is for.
       * The per-bullet detail is visible in the resume itself.
       */
      log: {
        type: 'array',
        items: { type: 'string' },
        description: 'The substantive changes you made, at most 6 lines, one short sentence each, in the spelling named in ABOUT THIS REQUEST. No leading bullet characters needed. Summarise rather than enumerate: "Rewrote the Shopify bullets around credit risk modelling" covers five edited bullets in one line. Do not write a line per reworded bullet, and do not describe a change you did not make.',
      },
      matchScore: {
        type: 'integer',
        description: 'Rough 0-100 estimate of how many key job requirements are covered by the tailored resume.',
      },
      missingRequirements: {
        type: 'array',
        items: { type: 'string' },
        description: 'Named skills, tools or qualifications the posting asks for that this resume does not show (e.g. "Docker", "C#"). This is where an unmet requirement belongs — never write one into a bullet instead. Empty array if the resume already covers everything material.',
      },
      warnings: {
        type: 'array',
        items: { type: 'string' },
        description: 'Anything the person should check before sending: a personal rule you could not satisfy, a conflict between a rule and the posting, something in the structure that looks wrong. Empty array if none. Say nothing about length — the app measures the real page count itself.',
      },
    },
    required: [
      'structure',
      'log',
      'matchScore',
      'missingRequirements',
      'warnings',
    ],
    additionalProperties: false,
  },
  };
}


/**
 * Reading one rule: what can be verified in it, and what it argues with.
 *
 * Deliberately NOT asked to rewrite the rule. The person's sentence is the rule
 * — this extracts a machine-checkable reading to keep beside it. Rewriting
 * somebody's own words into tidier ones is how a section called "Real Projects"
 * came back as "Projects", and it cost a commit to undo.
 */
export const RULE_INTAKE_TOOL: Anthropic.Tool = {
  name: 'submit_rule_reading',
  description:
    'Submit a machine-checkable reading of one rule, if it has one, and any existing rule it contradicts.',
  input_schema: {
    type: 'object',
    properties: {
      checkKind: {
        type: 'string',
        enum: ['forbidden_text', 'max_bullet_chars', 'none'],
        description:
          'How this rule could be verified against a finished resume by a program, with no judgement. "forbidden_text" when the rule forbids specific words or names appearing anywhere — "never say spearheaded", "call it Ontario Tech not UOIT" (forbid UOIT), "do not put my GPA on anything" (forbid GPA). "max_bullet_chars" when it caps bullet length. "none" for everything else, which is most rules: anything about emphasis, ordering, tone, what to lead with, or how something should read is guidance a program cannot check. Choose "none" rather than stretching — a wrong check reports failures that are not real, and the person cannot tell why.',
      },
      terms: {
        type: 'array',
        items: { type: 'string' },
        description:
          'For forbidden_text only: the exact words or phrases that must not appear, as they would be written on a resume. Bare terms, no quotes, no explanation. Matched whole-word and case-insensitively, so give the root a person would type ("spearheaded", not "spearhead(ed|ing)"). Empty for any other kind.',
      },
      limit: {
        type: 'integer',
        description:
          'For max_bullet_chars only: the maximum characters a single bullet may run to. One line on this resume template is roughly 110 characters; two is roughly 220. 0 for any other kind.',
      },
      conflictsWith: {
        type: 'integer',
        description:
          'The 1-based number of an existing rule this one genuinely contradicts — where following both is impossible or one plainly undoes the other. 0 when there is no conflict, which is the usual answer. Rules that merely cover different ground do not conflict.',
      },
      conflictReason: {
        type: 'string',
        description:
          'One short sentence saying what the contradiction is, addressed to the person who wrote both. Empty when conflictsWith is 0.',
      },
    },
    required: ['checkKind', 'terms', 'limit', 'conflictsWith', 'conflictReason'],
    additionalProperties: false,
  },
};

export const EXTRACT_TOOL: Anthropic.Tool = {
  name: 'submit_job_posting_extraction',
  description: 'Submit the company name, role title, and full relevant job description extracted from the attached screenshots and/or pasted text.',
  input_schema: {
    type: 'object',
    properties: {
      company: { type: 'string', description: 'The company name. Empty string if not confidently detected.' },
      role: { type: 'string', description: 'The role/job title. Empty string if not confidently detected.' },
      description: {
        type: 'string',
        description: 'The full relevant job description — responsibilities, requirements, qualifications, nice-to-haves. Boilerplate, benefits, and legal text stripped out. Empty string if no usable job content was found.',
      },
      location: {
        type: 'string',
        description: 'Where the role is based, or "Remote". Empty string if not stated.',
      },
      requirements: {
        type: 'array',
        items: { type: 'string' },
        description:
          'The concrete, named things this role asks for, each as a short canonical term: a language, framework, tool, platform, or a specific named skill — "Docker", "Kubernetes", "GraphQL", "Postgres", "CI/CD", "distributed systems". One term per entry, no sentences, no soft skills, no seniority. These are counted across every posting the person saves to find what they keep being asked for and never mention, so consistent naming matters more than completeness: prefer the common name for a thing over the posting\'s phrasing of it.',
      },
    },
    required: ['company', 'role', 'description', 'location', 'requirements'],
    additionalProperties: false,
  },
};

export const SOURCE_EXTRACTION_TOOL: Anthropic.Tool = {
  name: 'submit_source_extraction',
  description: 'Submit the extracted resume content as a ResumeStructure, along with whether the document was usable as a resume and, if not, the reason.',
  input_schema: {
    type: 'object',
    properties: {
      structure: {
        ...RESUME_STRUCTURE_SCHEMA,
        description: 'The extracted resume content. Return empty/default values if usable is false.',
      },
      sections: EXTRA_SECTIONS_SCHEMA,
      order: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Every section heading on the resume, top to bottom, exactly as written — including the ones you put in "structure". This is how the resume is arranged, and it is kept. Omit the name/contact block at the top; that is not a section.',
      },
      usable: {
        type: 'boolean',
        description: 'True if the document is a readable resume that could be extracted. False if it is a scanned/image-only PDF with no text, blank/corrupt, or not a resume at all.',
      },
      reason: {
        type: 'string',
        description: 'Short plain-English reason when usable is false. Empty string when usable is true.',
      },
    },
    required: ['structure', 'usable', 'reason'],
    additionalProperties: false,
  },
};

export const INSTRUCT_TOOL: Anthropic.Tool = {
  name: 'submit_resume_update',
  description: 'Submit the surgically updated ResumeStructure after acting on a single mid-session instruction.',
  input_schema: {
    type: 'object',
    properties: {
      structure: {
        // The same narrow shape the tailor returns. This asked for the whole
        // resume — name, contact, degrees, links — and the guard overwrote all
        // of it from the source afterwards, so every edit paid to write fields
        // that were thrown away before anybody saw them.
        ...TAILORED_STRUCTURE_SCHEMA,
        description: 'The full updated resume content as a ResumeStructure — same shape as the input structure, with only the field(s) relevant to the instruction changed; everything else returned verbatim.',
      },
      log: {
        type: 'array',
        items: { type: 'string' },
        description: 'Plain-English description of what changed and why, in the spelling named in ABOUT THIS REQUEST.',
      },
      warnings: {
        type: 'array',
        items: { type: 'string' },
        description: 'Anything the person should check before sending. Empty array if none. Say nothing about length — the app measures the real page count itself.',
      },
    },
    required: ['structure', 'log', 'warnings'],
    additionalProperties: false,
  },
};

function kb(base64: string | undefined): string {
  if (!base64) return '0KB';
  return `${Math.round((base64.length * 0.75) / 1024)}KB`;
}

function preview(text: string | undefined, length = 160): string {
  if (!text) return '(empty)';
  return text.length > length ? `${text.slice(0, length)}...` : text;
}

/**
 * Prints exactly what's about to be sent to Claude for a tailor/instruct
 * call. PDFs (About Me, Rules) are sent as opaque base64 `document` blocks —
 * Claude reads them natively and the server never parses their text, so we
 * can only confirm presence/size here, not list their internal sections.
 */
export function logRequestInputs(
  label: string,
  args: {
    aboutMe: { base64?: string; mimeType?: string };
    rules: { base64?: string; mimeType?: string };
    jobPosting: { company?: string; role?: string; description?: string; images?: unknown[] };
    structureSummary?: string;
    content: any[];
  },
) {
  const { aboutMe, rules, jobPosting, structureSummary, content } = args;
  console.log(`\n[Resumi9] ${label} — inputs being sent to Claude`);
  console.log(
    `  About Me PDF      : ${aboutMe?.base64 ? `present (${kb(aboutMe.base64)}, ${aboutMe.mimeType || 'application/pdf'}) — sent as a document block; content is opaque to the server, Claude reads it natively` : 'MISSING'}`,
  );
  console.log(
    `  Resume Rules PDF  : ${rules?.base64 ? `present (${kb(rules.base64)}, ${rules.mimeType || 'application/pdf'}) — sent as a document block; content is opaque to the server, Claude reads it natively` : 'not provided (optional — skipped)'}`,
  );
  console.log(
    `  Job Posting       : company="${jobPosting?.company || '(none)'}", role="${jobPosting?.role || '(none)'}", description=${jobPosting?.description?.length || 0} chars, screenshots=${jobPosting?.images?.length || 0}`,
  );
  console.log(`  Job Posting text  : "${preview(jobPosting?.description)}"`);
  if (structureSummary) {
    console.log(`  Resume Structure  : ${structureSummary}`);
  }
  console.log(`  Content blocks sent to messages.create(): [${content.map((c) => c.type).join(', ')}] (${content.length} total)`);
}

/** One-line summary of a structure, for the request log. */
export function summariseStructure(structure: any): string {
  return `name="${structure?.name || '(none)'}", education=${(structure?.education || []).length}, experience=${(structure?.experience || []).length}, projects=${(structure?.projects || []).length}, skills=${(structure?.skills || []).length} categories`;
}
