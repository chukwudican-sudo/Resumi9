import { formatDates, formatPhone, formatPlace, formatWebsite, recencyKey } from './entryFormat';
import { titleWithEmployment } from './employment';
import { composeDegree } from './degree';
import type { ProfileEntry, ResumeSection, ResumeStructure, SectionEntry, SectionShape } from './types';
import {
  KNOWN_SHAPES,
  STORED_ELSEWHERE,
  contentFor,
  entryKindFor,
  hasContent,
  ownSections,
  planSections,
  type SectionContent,
} from './sections';

/**
 * Turns what someone typed into their master resume.
 *
 * Deliberately deterministic — no model, no waiting, no cost. What you enter in
 * the form is what appears, immediately and exactly. That matters for trust as
 * much as for speed: a resume that quietly rewords your own sentences before
 * you have asked it to is unsettling, and it makes it impossible to tell what
 * the tailoring later actually changed.
 *
 * The AI has exactly one job in this product, and it is not this one. It runs
 * when you tailor to a specific posting, against a master resume you can see.
 */

export interface EntryWithBullets extends ProfileEntry {
  bullets: string[];
  tech?: string | null;
  url?: string | null;
  city?: string | null;
  region?: string | null;
  country?: string | null;
  startMonth?: number | null;
  startYear?: number | null;
  endMonth?: number | null;
  endYear?: number | null;
  isCurrent?: boolean;
  extra?: Record<string, string> | null;
}

/**
 * A `profile_entries` row as the resume wants it.
 *
 * Lives here rather than at each call site because it was duplicated in two
 * places and both silently dropped the structured date and place columns when
 * they were added — dates saved fine and then disappeared on the next read.
 * One conversion means a new column can only be forgotten once.
 */
export function entryFromRow(row: {
  id: string;
  kind: string;
  title: string | null;
  org: string | null;
  location: string | null;
  datesDisplay: string | null;
  orderIndex: number;
  source: string;
  bullets: unknown;
  tech: string | null;
  url: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  startMonth: number | null;
  startYear: number | null;
  endMonth: number | null;
  endYear: number | null;
  isCurrent: boolean | null;
  extra: unknown;
}): EntryWithBullets {
  return {
    id: row.id,
    kind: row.kind as EntryWithBullets['kind'],
    title: row.title ?? undefined,
    org: row.org ?? undefined,
    location: row.location ?? undefined,
    datesDisplay: row.datesDisplay ?? undefined,
    orderIndex: row.orderIndex,
    source: row.source as EntryWithBullets['source'],
    bullets: (row.bullets as string[]) ?? [],
    tech: row.tech,
    url: row.url,
    city: row.city,
    region: row.region,
    country: row.country,
    startMonth: row.startMonth,
    startYear: row.startYear,
    endMonth: row.endMonth,
    endYear: row.endYear,
    isCurrent: row.isCurrent ?? false,
    extra: (row.extra as Record<string, string> | null) ?? null,
  };
}

function datesOf(e: EntryWithBullets) {
  return {
    startMonth: e.startMonth ?? null,
    startYear: e.startYear ?? null,
    endMonth: e.endMonth ?? null,
    endYear: e.endYear ?? null,
    isCurrent: e.isCurrent ?? false,
  };
}

function placeOf(e: EntryWithBullets) {
  return { city: e.city ?? null, region: e.region ?? null, country: e.country ?? null };
}

/** Contact details are stored as `Label: value` identity facts. */
export interface ContactFact {
  category: string;
  text: string;
}

function readContact(facts: ContactFact[]) {
  const pick = (label: string) => {
    const hit = facts.find(
      (f) => f.category === 'identity' && f.text.toLowerCase().startsWith(`${label.toLowerCase()}: `),
    );
    return hit ? hit.text.slice(label.length + 2).trim() : '';
  };
  return {
    name: pick('Name'),
    email: pick('Email'),
    phone: pick('Phone'),
    location: pick('Location'),
    linkedin: pick('LinkedIn'),
    github: pick('GitHub'),
    website: pick('Website'),
  };
}

/** Skills are stored as `Category: items` skill facts, or bare items. */
function readSkills(facts: ContactFact[]): { category: string; items: string }[] {
  const groups = new Map<string, string[]>();
  for (const f of facts) {
    if (f.category !== 'skill') continue;
    const colon = f.text.indexOf(':');
    const category = colon > 0 ? f.text.slice(0, colon).trim() : 'Skills';
    const items = colon > 0 ? f.text.slice(colon + 1).trim() : f.text.trim();
    if (!items) continue;
    const list = groups.get(category);
    if (list) list.push(items);
    else groups.set(category, [items]);
  }
  return Array.from(groups, ([category, items]) => ({ category, items: items.join(', ') }));
}

/**
 * @param sections The person's own sections, if they have any. Empty means the
 * conventional set — which is what every profile had before sections existed,
 * so an untouched one builds byte-for-byte as it always did.
 */
/**
 * One section's entries, in the order they will print.
 *
 * Exported because the editor has to agree with the page. It listed entries in
 * the order they were added while the resume printed them newest first, so the
 * form said Dean's List, Scholarship, Hackathon and the PDF beside it said
 * Hackathon, Dean's List, Scholarship — and there was no way to tell from the
 * editor what you were about to send.
 *
 * Most recent first, but only when every entry in the section can be placed.
 * recencyKey scores an undated entry 0, so in a mixed section it sinks to the
 * bottom regardless of where its owner put it. That is a real case now that
 * imports parse dates: a resume where two jobs give months and one says
 * "Summer 2025" would have the third pushed to the end, which is not what the
 * file said and not what anyone asked for. One rule per section instead —
 * dates when they are all there, the order they were given when they are not.
 */
export function inPrintOrder<T extends EntryWithBullets>(entries: T[]): T[] {
  const allDated = entries.every((e) => recencyKey(datesOf(e)) > 0);
  return [...entries].sort((a, b) => {
    if (!allDated) return a.orderIndex - b.orderIndex;
    const diff = recencyKey(datesOf(b)) - recencyKey(datesOf(a));
    return diff !== 0 ? diff : a.orderIndex - b.orderIndex;
  });
}

export function buildResume(
  entries: EntryWithBullets[],
  facts: ContactFact[],
  sections: ResumeSection[] = [],
): ResumeStructure {
  const contact = readContact(facts);
  const byKind = (kind: string) => inPrintOrder(entries.filter((e) => e.kind === kind));

  const home = readContact(facts).location.split(',').pop()?.trim() || null;

  // Trailing whitespace survives a form field and then shows up as a gap before
  // a separator on the page.
  const clean = (value: string | null | undefined) => (value ?? '').trim();

  const structure: ResumeStructure = {
    name: contact.name,
    contact: {
      email: contact.email || undefined,
      phone: contact.phone ? formatPhone(contact.phone) : undefined,
      linkedin: contact.linkedin ? formatWebsite(contact.linkedin) : undefined,
      github: contact.github ? formatWebsite(contact.github) : undefined,
      website: contact.website ? formatWebsite(contact.website) : undefined,
    },
    education: byKind('education').map((e) => ({
      school: clean(e.org),
      location: formatPlace(placeOf(e), e.location, home),
      // Composed rather than joined here, so a title that already names the
      // degree does not get a second one bolted onto the front. See degree.ts.
      degree: composeDegree(clean(e.extra?.credential), clean(e.title), clean(e.extra?.honours), clean(e.extra?.gpa)),
      dates: formatDates(datesOf(e), 'education', e.datesDisplay),
      // Coursework, honours, a thesis. For a student this is often the most
      // relevant thing on the page, and it had nowhere to go.
      bullets: e.bullets ?? [],
    })),
    experience: byKind('experience').map((e) => ({
      // "(Part-time)" earns its place by being rare — it explains why two roles
      // overlap, or why a stint was short. "(Full-time)" on every entry is what
      // a reader already assumed and makes the page look generated.
      title: titleWithEmployment(clean(e.title), e.extra?.employment),
      org: clean(e.org),
      location: formatPlace(placeOf(e), e.location, home),
      dates: formatDates(datesOf(e), 'experience', e.datesDisplay),
      bullets: e.bullets ?? [],
    })),
    projects: byKind('project').map((e) => ({
      name: clean(e.title),
      tech: clean(e.tech),
      // Kept separate from tech. Concatenating them put a 50-character URL in
      // a heading cell that does not wrap, which pushed the dates past the
      // right margin and clipped them off the page.
      url: clean(e.url) || undefined,
      dates: formatDates(datesOf(e), 'project', e.datesDisplay),
      bullets: e.bullets ?? [],
    })),
    skills: readSkills(facts),
  };

  if (!sections.length) return structure;

  // The person's own plan, which is the only place three of these fields can
  // come from.
  //
  // Summary, certifications and awards were extracted from uploaded resumes for
  // as long as the extractor has existed, and then died here: this function
  // reads rows, no row held a summary, and so the rebuild that runs after every
  // save produced a structure with no summary in it. The paragraph survived in
  // the derived blob until the first save or the first Polish overwrote it. It
  // did not look like data loss because the preview rendered from the blob.
  const named = new Map(sections.map((s) => [s.key, s]));
  const text = named.get('summary')?.text?.trim();
  if (text) structure.summary = text;
  // Only when they are a flat list. Laid out with an issuer and a year they are
  // entries in rows, and flattening them into `string[]` here would put a
  // second, thinner copy of the same section on the page.
  const flat = (key: 'certifications' | 'awards') => {
    const section = named.get(key);
    return (section?.shape ?? KNOWN_SHAPES[key]) === 'list' ? written(section?.items) : [];
  };
  const certifications = flat('certifications');
  if (certifications.length) structure.certifications = certifications;
  const awards = flat('awards');
  if (awards.length) structure.awards = awards;

  structure.sections = sections.map((section) => {
    // The four whose content is rows and facts carry order and label only — it
    // stays in the named field above, where every scorer, guard and importer
    // already reads it.
    if (STORED_ELSEWHERE.has(section.key)) return { key: section.key, label: section.label };

    const shape = section.shape ?? KNOWN_SHAPES[section.key];
    // Anything holding entries reads them back from rows, under its own key.
    // Certifications reaches this when somebody's resume lays each one out with
    // an issuer and a year rather than as a flat line.
    if (shape === 'entries' || shape === 'inline') {
      const kind = entryKindFor(section.key);
      return { ...section, entries: byKind(kind).map((e) => asSectionEntry(e, kind)) };
    }
    // Everything else keeps its content on the section. Stripping it here read
    // as an empty summary to everything downstream, and polish wrote that
    // emptiness back to the row — deleting the paragraph on the next pass,
    // which is the very failure this feature exists to fix arriving through a
    // different door.
    return section;
  });

  return structure;

  function asSectionEntry(e: EntryWithBullets, kind: string): SectionEntry {
    return {
      title: titleWithEmployment(clean(e.title), e.extra?.employment),
      org: clean(e.org),
      location: formatPlace(placeOf(e), e.location, home),
      // Formatted under the section's own key, so a certificate in progress
      // reads "Expected" and a volunteering stint reads "Present".
      dates: formatDates(datesOf(e), kind, e.datesDisplay),
      tech: clean(e.tech),
      url: clean(e.url) || undefined,
      bullets: e.bullets ?? [],
    };
  }
}

function written(values: string[] | undefined | null): string[] {
  return (values ?? []).map((v) => (v ?? '').trim()).filter(Boolean);
}

/**
 * The rail: every section this person has, in the order it prints.
 *
 * Ordered by the plan rather than by a fixed list, because the two used to
 * disagree in public — the rail read Experience, Education, Projects while the
 * PDF beside it printed Education, Projects, Work Experience, and nothing on
 * screen said which one was real.
 *
 * Expressed as what is missing rather than as a percentage: "add your first
 * job" is actionable in a way that "7% complete" is not, and a low percentage
 * on the opening screen mostly communicates how far you are from finishing.
 */
export interface SectionStatus {
  key: string;
  label: string;
  /** Which editor to open. 'contact' is authored here but never printed. */
  shape: SectionShape | 'contact';
  done: boolean;
  detail: string;
}

/**
 * @param contactSaved Whether the contact form has been saved on this visit.
 * Until it has, Contact is not shown as finished — because Polish and Download
 * are held shut until it is, and a green tick beside "Name and email set" on
 * the one section the app is waiting for tells somebody the opposite of what is
 * happening. There was nothing else on the screen saying which section to go
 * to, so the answer was "ask whoever built it".
 */
export function sectionStatus(
  structure: ResumeStructure,
  contactSaved = true,
  /**
   * Which sections have been confirmed. Undefined means "not tracked" and every
   * filled section counts as done — which is what every caller outside the
   * setup rail wants, and what the tests here assert.
   */
  confirmed?: string[],
): SectionStatus[] {
  const reachable = Boolean(structure.name && structure.contact?.email);
  const rail: SectionStatus[] = [
    {
      key: 'contact',
      label: 'Contact',
      shape: 'contact',
      done: reachable && contactSaved,
      detail: !reachable
        ? 'Name and email needed'
        : contactSaved
          ? 'Name and email set'
          : 'Not saved yet',
    },
  ];

  // The rule this used to state inline is now `ownSections`, because four other
  // things need the same answer and they were each giving their own. An extra
  // nobody has is not a to-do; one somebody HAS stays here even while empty,
  // or clearing a summary to rewrite it makes the section vanish mid-edit.
  for (const section of ownSections(structure)) {
    const content = contentFor(structure, section);
    const filled = hasContent(content);
    rail.push({
      key: section.key,
      label: section.label,
      shape: section.shape,
      done: filled && (confirmed ? confirmed.includes(section.key) : true),
      detail: detailFor(section.key, content),
    });
  }

  return rail;
}

function detailFor(key: string, content: SectionContent): string {
  switch (content.shape) {
    case 'entries':
    case 'inline': {
      const n = content.entries.length;
      if (n) return `${n} added`;
      // Projects is the one section somebody can reasonably not have and still
      // have a finished resume, so it does not read as an omission.
      return key === 'projects' ? 'Optional' : 'None yet';
    }
    case 'groups': {
      const n = content.groups.length;
      return n ? `${n} ${n === 1 ? 'group' : 'groups'}` : 'None yet';
    }
    case 'list': {
      const n = content.items.length;
      return n ? `${n} added` : 'None yet';
    }
    case 'prose': {
      const n = content.text ? content.text.split(/\n\s*\n/).filter((p) => p.trim()).length : 0;
      return n ? `${n} ${n === 1 ? 'paragraph' : 'paragraphs'}` : 'None yet';
    }
  }
}

/**
 * Enough to tailor from: someone reachable, with at least one thing they have
 * done.
 *
 * "Something they have done" used to mean a job or a project, which was the
 * whole world when those were the only sections that could hold one. A first
 * year with a degree, a tutoring post at the library and two certificates has a
 * real resume and got no Download button at all — no explanation either, since
 * this hides the buttons rather than refusing them.
 *
 * Education alone still is not enough: a degree is something you have, and the
 * rule is about something you did.
 */
export function isResumeUsable(entries: EntryWithBullets[], facts: ContactFact[]): boolean {
  const contact = readContact(facts);
  const hasSomething = entries.some((e) => e.kind !== 'education');
  return Boolean(contact.name && contact.email && hasSomething);
}
