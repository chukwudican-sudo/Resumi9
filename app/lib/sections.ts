import type { ResumeSection, ResumeStructure, SectionShape } from './types';

/**
 * Which sections a resume has, what they are called, and what order they print.
 *
 * This exists because the app used to answer all three questions with a
 * hardcoded list of four, and everything outside that list was deleted — in the
 * extraction prompt, in the polish validator, and by simply having no field to
 * store it in. Somebody's Summary survived an upload, showed up in the preview,
 * and vanished the first time they pressed Polish, because the structure that
 * came back had nowhere to put one.
 *
 * So sections are data now. Seven keys the app still knows by name (their
 * content lives in the named fields on ResumeStructure that every scorer and
 * guard already reads); anything else carries its content inline. Both kinds
 * come out of `planSections` as the same thing: a key, a label, and a shape.
 *
 * SHAPE, NOT MEANING. There are five ways to draw a section and the LaTeX
 * template already draws all five. A Volunteering section is not a new thing to
 * render — it is `entries`, the same drawer Experience uses. That is the whole
 * reason this is affordable, and it is why nothing here asks what a section
 * *means*.
 */

/** The four `\resumeSubheading` slots, as the template lays them out. */
export interface DrawnEntry {
  /** Bold, line one, left. */
  heading: string;
  /** Line one, right. */
  headingRight: string;
  /** Italic, line two, left. */
  sub: string;
  /** Line two, right. */
  subRight: string;
  /**
   * Where to see it, printed beside the second line.
   *
   * The editor has always had a link box for every entry and only projects ever
   * printed one — so a certificate's Verify link, which every guide recommends
   * carrying, went into the database and never onto the page.
   */
  url: string;
  bullets: string[];
}

/** A `\resumeProjectHeading` — one line, pieces separated by bars, dates right. */
export interface DrawnInline {
  name: string;
  tech: string;
  url: string;
  dates: string;
  bullets: string[];
}

export type SectionContent =
  | { shape: 'entries'; entries: DrawnEntry[] }
  | { shape: 'inline'; entries: DrawnInline[] }
  | { shape: 'groups'; groups: { category: string; items: string }[] }
  | { shape: 'list'; items: string[] }
  | { shape: 'prose'; text: string };

/** A section resolved: what to call it, how to draw it, whether to expect it. */
export interface PlannedSection {
  key: string;
  label: string;
  shape: SectionShape;
  /**
   * True for the three the app has always treated as extras.
   *
   * The rail shows a core section even when it is empty — "Experience: none
   * yet" is the prompt to add one. Showing "Summary: none yet" to everybody
   * would put three new rows on a screen nobody asked to change.
   */
  optional: boolean;
}

/** The seven keys whose content lives in a named field rather than inline. */
export const KNOWN_SHAPES: Record<string, SectionShape> = {
  summary: 'prose',
  education: 'entries',
  experience: 'entries',
  projects: 'inline',
  skills: 'groups',
  certifications: 'list',
  awards: 'list',
};

/**
 * Where a section goes when nobody has said otherwise.
 *
 * This is not a new default — it is exactly what the renderer did when it had
 * summary hardcoded above the loop and certifications and awards hardcoded
 * below it. Written down so it can be departed from.
 */
export const CONVENTIONAL_ORDER: PlannedSection[] = [
  { key: 'summary', label: 'Summary', shape: 'prose', optional: true },
  { key: 'education', label: 'Education', shape: 'entries', optional: false },
  { key: 'experience', label: 'Experience', shape: 'entries', optional: false },
  { key: 'projects', label: 'Projects', shape: 'inline', optional: false },
  { key: 'skills', label: 'Technical Skills', shape: 'groups', optional: false },
  { key: 'certifications', label: 'Certifications', shape: 'list', optional: true },
  { key: 'awards', label: 'Awards', shape: 'list', optional: true },
];

const RANK = new Map(CONVENTIONAL_ORDER.map((s, i) => [s.key, i]));

export const SHAPES: SectionShape[] = ['entries', 'inline', 'groups', 'list', 'prose'];

/*
 * There is deliberately no cap on how many sections a resume may have.
 *
 * There was one — ten — decided before the catalogue existed, and the catalogue
 * then outgrew it: four core sections plus nine offered ones is thirteen, so
 * somebody could pick a section straight off the list and be refused by a limit
 * for doing exactly what the list invited. A rule that blocks its own menu is
 * not a rule.
 *
 * It was also the only cap in the app. Nothing stops thirty jobs, fifty bullets
 * or a summary of any length, and a resume runs long through those far sooner
 * than through headings. A section prints nothing until it has content, so an
 * accidental add costs nothing on the page either.
 *
 * If length ever needs guarding, the honest signal is the page count the
 * tailoring already estimates, said near the preview where length is visible —
 * not a number of headings guessed at in advance.
 */

const clean = (value: string | null | undefined): string => (value ?? '').trim();

/**
 * The whole plan, in print order, empty sections included.
 *
 * Empties are kept deliberately: the rail renders from this and needs to offer
 * the sections somebody has not filled in yet. The renderer drops them, which
 * is what it has always done.
 *
 * A stored plan does not have to be complete. Polish returns four sections and
 * has never mentioned the summary, so a key it left out is spliced back in at
 * its conventional position rather than falling off the end — which is how a
 * profile polished before any of this existed still renders in the right order.
 */
export function planSections(structure: ResumeStructure): PlannedSection[] {
  const given = (structure.sections ?? [])
    .filter((s): s is ResumeSection => Boolean(s && typeof s.key === 'string' && s.key.trim()))
    .map(resolve)
    .filter((s): s is PlannedSection => s !== null);

  // Every key appears once. A model that returns Experience twice would
  // otherwise print the same jobs twice.
  const seen = new Set<string>();
  const plan = given.filter((s) => !seen.has(s.key) && seen.add(s.key));

  const queue = CONVENTIONAL_ORDER.filter((c) => !seen.has(c.key));
  const out: PlannedSection[] = [];
  let lastRank = -1;

  for (const section of plan) {
    // A custom section has no conventional rank, so it inherits the last one
    // seen — which is to say it stays exactly where it was put.
    const rank = RANK.get(section.key);
    const effective = rank ?? lastRank;
    while (queue.length && (RANK.get(queue[0].key) ?? 0) < effective) out.push(queue.shift()!);
    out.push(section);
    if (rank !== undefined) lastRank = rank;
  }

  return [...out, ...queue];
}

/** One stored section, resolved against what the app knows. */
function resolve(section: ResumeSection): PlannedSection | null {
  const key = section.key.trim();
  const conventional = CONVENTIONAL_ORDER.find((c) => c.key === key);

  // A known key keeps its shape whatever the row claims. Nothing should be able
  // to make Education render as a paragraph.
  //
  // Certifications and Awards are the exception, and a real resume is why: one
  // lists them flat, the next lays each out with an issuer underneath and the
  // year on the right. Both are correct, and forcing the flat one on somebody
  // throws away the issuer and the year they wrote down.
  const fixed = FLEXIBLE.has(key) ? undefined : KNOWN_SHAPES[key];
  const declared = SHAPES.includes(section.shape!) ? section.shape! : undefined;
  const shape = fixed ?? declared ?? KNOWN_SHAPES[key] ?? inferShape(section);
  if (!shape) return null;

  return {
    key,
    label: clean(section.label) || conventional?.label || titleCase(key),
    shape,
    optional: conventional ? conventional.optional : true,
  };
}

/**
 * What shape a section is, read off its content rather than asked for.
 *
 * A model told to report its own structure does not reliably do it — this
 * codebase has a guard file and a change log full of that lesson. But content
 * cannot lie about its own arrangement: rows with an organisation under the
 * title are laid out like jobs; lines that all read "Label: a, b, c" are
 * grouped skills; a paragraph is a paragraph.
 */
export function inferShape(section: {
  entries?: unknown[];
  groups?: unknown[];
  items?: unknown[];
  lines?: string[];
  text?: string;
}): SectionShape | null {
  const entries = (section.entries ?? []) as ShapeProbe[];
  if (entries.length) {
    // A second line under the title is what separates a job from a project.
    if (entries.some((e) => clean(e.org) || clean(e.sub))) return 'entries';
    // Neither, when they are labels rather than things somebody did.
    if (readsAsPairs(entries)) {
      return entries.some((e) => (e.bullets ?? []).some((b) => clean(b))) ? 'groups' : 'list';
    }
    return 'inline';
  }

  if ((section.groups ?? []).length) return 'groups';

  const lines = [...((section.lines as string[]) ?? []), ...((section.items as string[]) ?? [])]
    .map(clean)
    .filter(Boolean);
  if (lines.length) return readsAsGroups(lines) ? 'groups' : 'list';

  if (clean(section.text)) return 'prose';
  return null;
}

interface ShapeProbe {
  title?: string;
  org?: string;
  sub?: string;
  tech?: string;
  url?: string;
  dates?: string;
  bullets?: string[];
}

/**
 * Whether these are labels with values, not things somebody did.
 *
 * A Languages section written as a name with its level underneath extracts as
 * rows with a title and one short line — structurally identical to a project
 * with one bullet. Read as a project it printed "English" with a date column
 * beside it, which is not a thing a language has.
 *
 * So the test is what a label/value pair cannot have: a date, a stack, a link,
 * a second bullet, or a title long enough to be a project name. Two or more,
 * because one pair is not a pattern.
 */
function readsAsPairs(entries: ShapeProbe[]): boolean {
  if (entries.length < 2) return false;
  return entries.every((e) => {
    const title = clean(e.title);
    if (!title || title.length > 40 || title.split(/\s+/).length > 4) return false;
    if (clean(e.dates) || clean(e.tech) || clean(e.url)) return false;
    const written = (e.bullets ?? []).map(clean).filter(Boolean);
    // One value, and a value rather than a sentence about work.
    return written.length <= 1 && written.every((b) => b.length <= 60);
  });
}

/**
 * Whether every line is "Label: items" — a skills block written out flat.
 *
 * A single labelled line is more likely an award ("Dean's List: Fall 2024")
 * than a group of one, so one line only counts when it actually lists things.
 */
function readsAsGroups(lines: string[]): boolean {
  const parsed = lines.map((line) => /^([^:]{1,40}):\s*(\S.*)$/.exec(line));
  if (parsed.some((m) => m === null)) return false;
  return lines.length > 1 || parsed[0]![2].includes(',');
}

/**
 * Whether an entry in this section is expected to be described.
 *
 * The line is between things you DID and things you HOLD. A job, a project, a
 * volunteering role are actions, and an action with nothing under it prints a
 * heading over blank space. A certificate and an award are complete with a
 * name, an issuer and a year — there is nothing missing about one that has no
 * bullets, and saying so puts a warning on a finished section.
 *
 * Education is exempt for its own reason: coursework is worth listing but a
 * degree without it is still a degree.
 *
 * Deliberately NOT the same question as which sections the strength score
 * counts. That is about which numbers move the score; this is about which
 * entries would print broken.
 */
export function expectsBullets(kind: string): boolean {
  return kind !== 'education' && !FLEXIBLE.has(kind);
}

/**
 * The sections this person actually has.
 *
 * One answer to a question the app was giving three. `planSections` returns all
 * seven whatever the profile holds, because it describes where things go rather
 * than what exists; polish filtered by content; the rail used a third rule. That
 * was survivable while sections only ever arrived from an upload, and stops
 * being survivable the moment somebody can add one — five things need to agree
 * on whether a section is there: the rail, what may be offered to add, the cap,
 * what a first add seeds from, and what polish is allowed to return.
 *
 * The rule is the rail's, because it was the only one that was right: a section
 * is theirs if they DECLARED it (there is a row), or it has something in it, or
 * it is one of the four every resume is expected to carry.
 *
 * Declared-but-empty matters most. It is a section somebody just added and has
 * not filled in, or one they cleared to rewrite — and the version of this that
 * filtered by content deleted both on the next polish.
 */
export function ownSections(structure: ResumeStructure): PlannedSection[] {
  const declared = new Set((structure.sections ?? []).map((s) => s?.key).filter(Boolean));
  return planSections(structure).filter(
    (section) =>
      !section.optional ||
      declared.has(section.key) ||
      hasContent(contentFor(structure, section)),
  );
}

/**
 * The content of one planned section, in the form its drawer wants.
 *
 * Known keys read the named fields — the ones every scorer, guard and importer
 * already reads — so widening the plan did not move anybody's experience out
 * from under them. Custom keys read the inline content, because there is
 * nowhere else for it to be.
 */
export function contentFor(structure: ResumeStructure, section: PlannedSection): SectionContent {
  const inline = (structure.sections ?? []).find((s) => s?.key === section.key);

  switch (section.key) {
    case 'summary':
      return { shape: 'prose', text: clean(structure.summary) };

    case 'education':
      // Education fills the four slots differently from experience: the school
      // is bold with the location beside it, the degree italic with the dates.
      // That is how this template has always drawn it and it is not a bug.
      return {
        shape: 'entries',
        entries: (structure.education ?? []).map((e) => ({
          heading: clean(e.school),
          headingRight: clean(e.location),
          sub: clean(e.degree),
          subRight: clean(e.dates),
          url: '',
          bullets: written(e.bullets),
        })),
      };

    case 'experience':
      return {
        shape: 'entries',
        entries: (structure.experience ?? []).map((x) => ({
          heading: clean(x.title),
          headingRight: clean(x.dates),
          sub: clean(x.org),
          subRight: clean(x.location),
          url: '',
          bullets: written(x.bullets),
        })),
      };

    case 'projects':
      return {
        shape: 'inline',
        entries: (structure.projects ?? []).map((p) => ({
          name: clean(p.name),
          tech: clean(p.tech),
          url: clean(p.url),
          dates: clean(p.dates),
          bullets: written(p.bullets),
        })),
      };

    case 'skills':
      return {
        shape: 'groups',
        groups: (structure.skills ?? [])
          .filter((s) => clean(s?.items))
          .map((s) => ({ category: clean(s.category), items: clean(s.items) })),
      };

    case 'certifications':
    case 'awards': {
      // Flat, when that is what the resume had: the named field holds it and
      // every scorer and guard already reads it there. Anything else is laid
      // out on the section itself, like a section the app has no name for.
      if (section.shape === 'list') {
        const named = written(section.key === 'certifications' ? structure.certifications : structure.awards);
        if (named.length) return { shape: 'list', items: named };
      }
      return fromInline(section.shape, inline);
    }

    default:
      return fromInline(section.shape, inline);
  }
}

/** A custom section's own content, carried on the plan entry itself. */
function fromInline(shape: SectionShape, section: ResumeSection | undefined): SectionContent {
  switch (shape) {
    case 'entries':
      return {
        shape: 'entries',
        entries: (section?.entries ?? []).map((e) => ({
          // The experience convention — role and dates on top, organisation and
          // place underneath. Volunteering, leadership and activities all read
          // that way, which is what makes one drawer enough.
          heading: clean(e.title),
          headingRight: clean(e.dates),
          sub: clean(e.org),
          subRight: clean(e.location),
          url: clean(e.url),
          bullets: written(e.bullets),
        })),
      };
    case 'inline':
      return {
        shape: 'inline',
        entries: (section?.entries ?? []).map((e) => ({
          name: clean(e.title),
          tech: clean(e.tech),
          url: clean(e.url),
          dates: clean(e.dates),
          bullets: written(e.bullets),
        })),
      };
    case 'groups':
      return {
        shape: 'groups',
        // A label with nothing beside it is kept. "English" on its own is a
        // real line on a real resume — plenty of people list a language and
        // stop — and dropping it because the second box is empty would delete
        // something somebody typed. Skills is stricter, and guards that itself.
        groups: (section?.groups ?? [])
          .filter((g) => clean(g?.category) || clean(g?.items))
          .map((g) => ({ category: clean(g.category), items: clean(g.items) })),
      };
    case 'list':
      return { shape: 'list', items: written(section?.items) };
    case 'prose':
      return { shape: 'prose', text: clean(section?.text) };
  }
}

/** Whether a section has anything to show. */
export function hasContent(content: SectionContent): boolean {
  switch (content.shape) {
    case 'entries':
      return content.entries.some((e) => e.heading || e.sub || e.bullets.length);
    case 'inline':
      return content.entries.some((e) => e.name || e.bullets.length);
    case 'groups':
      return content.groups.length > 0;
    case 'list':
      return content.items.length > 0;
    case 'prose':
      return content.text.length > 0;
  }
}

function written(values: string[] | undefined | null): string[] {
  return (values ?? []).map(clean).filter(Boolean);
}

/**
 * The sections somebody is offered when they ask to add one.
 *
 * Named things rather than layouts, because a layout is the app's problem. Each
 * carries the shape it should have, so the word never reaches the screen —
 * "Summary" is a paragraph and "Certifications" has an issuer and a year, and
 * nobody should have to be told that to pick one.
 *
 * Certifications and Awards are `entries` rather than the flat `list` their
 * named field holds: somebody adding one by hand has an issuer and a year to
 * type, and both keys are FLEXIBLE precisely so the shape can be theirs.
 */
export interface Addable {
  label: string;
  shape: SectionShape;
  /** What goes in it, in the fewest words that distinguish it. */
  detail: string;
}

export const ADDABLE: Addable[] = [
  { label: 'Summary', shape: 'prose', detail: 'a paragraph at the top' },
  { label: 'Certifications', shape: 'entries', detail: 'name, issuer, year' },
  { label: 'Awards', shape: 'entries', detail: 'name, issuer, year' },
  { label: 'Languages', shape: 'groups', detail: 'language and how well you speak it' },
  { label: 'Volunteer Experience', shape: 'entries', detail: 'role, organisation, dates, bullets' },
  // Its own row rather than folded into volunteering: unpaid work for an
  // organisation and the clubs somebody belongs to are different things, and a
  // resume that separates them did so on purpose.
  { label: 'Extracurricular & Community Activities', shape: 'entries', detail: 'clubs, societies, activities' },
  { label: 'Publications', shape: 'inline', detail: 'title, where, when' },
  { label: 'Interests', shape: 'list', detail: 'a short list' },
  { label: 'References', shape: 'list', detail: 'names, or available on request' },
];

/** How the five layouts are described to somebody naming their own section. */
export const LAYOUTS: { shape: SectionShape; label: string; detail: string }[] = [
  { shape: 'entries', label: 'Like a job', detail: 'role, organisation, dates, and bullets' },
  { shape: 'inline', label: 'Like a project', detail: 'name, what it was built with, a link' },
  { shape: 'groups', label: 'Label and value', detail: 'like your skills — "Languages: Python, Go"' },
  { shape: 'list', label: 'A plain list', detail: 'one line each, no dates' },
  { shape: 'prose', label: 'A paragraph', detail: 'like a summary' },
];

/**
 * Sections that can actually be removed.
 *
 * Not a policy. `planSections` splices any missing conventional key straight
 * back, so deleting one of the four would be a button that does nothing —
 * they are left empty instead, which already stops them printing. The other
 * three conventional keys come back too, but as optional-and-empty they are
 * hidden from the rail and dropped by the renderer, so removing them works.
 */
export function isRemovable(key: string): boolean {
  return !STORED_ELSEWHERE.has(key);
}

/**
 * The plan with one section added, or null when they already have it.
 *
 * A known key goes to its conventional position — a summary belongs at the top
 * of a resume, not at the bottom of it, and appending would be the app pleading
 * ignorance about something it knows. Anything else goes last, where it was
 * asked for.
 */
export function withSectionAdded(
  sections: ResumeSection[],
  label: string,
  shape: SectionShape,
): ResumeSection[] | null {
  const taken = sections.map((s) => s.key);
  const key = keyFor(label, taken);
  if (taken.includes(key)) return null;

  const section: ResumeSection = {
    key,
    label: label.trim(),
    shape: KNOWN_SHAPES[key] && !FLEXIBLE.has(key) ? KNOWN_SHAPES[key] : shape,
  };

  const rank = RANK.get(key);
  if (rank === undefined) return [...sections, section];

  // After the last section that conventionally precedes this one.
  let at = 0;
  sections.forEach((s, i) => {
    const other = RANK.get(s.key);
    if (other !== undefined && other < rank) at = i + 1;
  });
  return [...sections.slice(0, at), section, ...sections.slice(at)];
}

/**
 * The plan with one section renamed, or null when the name is not usable.
 *
 * The KEY never changes. It is an internal id nobody sees, every entry is filed
 * under it, and re-filing all of them on each rename would be work with nothing
 * to show for it — so "Volunteer Experience" renamed to "Community Work" keeps
 * `volunteer_experience` underneath and simply prints differently.
 *
 * Refused when the new name resolves to a DIFFERENT section they already have:
 * renaming their volunteering to "Awards" beside a real awards section would
 * put two identical headings on one resume with different things under them.
 */
export function withSectionRenamed(
  sections: ResumeSection[],
  key: string,
  label: string,
): ResumeSection[] | null {
  const name = label.trim();
  if (!name) return null;
  if (!sections.some((s) => s.key === key)) return null;

  const resolved = keyFor(name);
  if (resolved !== key && sections.some((s) => s.key === resolved)) return null;

  return sections.map((s) => (s.key === key ? { ...s, label: name } : s));
}

/** The plan without one section. */
export function withSectionRemoved(sections: ResumeSection[], key: string): ResumeSection[] {
  return sections.filter((s) => s.key !== key);
}

/** Where a moved section lands. */
export type Landing = 'before' | 'after' | 'start' | 'end';

/**
 * The plan with one section moved, or null when the move cannot be made.
 *
 * Takes the PLANNED order rather than the stored list, and this is the whole
 * point of it. A stored list does not have to be complete — the summary is
 * routinely absent from it and placed by the rank table at print time — so a
 * move applied to the stored list cannot move the section somebody is actually
 * looking at. "Move the summary below education" was a no-op for exactly that
 * reason: there was no summary in the list to move.
 *
 * It returns the order in full, every section written down explicitly. From
 * then on that resume's order is stated rather than inferred, which is what
 * makes the move survive the next read: two places deciding order is how a
 * section somebody deliberately placed drifts back to where convention wanted
 * it. Empty sections are kept, as `planSections` keeps them — the renderer
 * drops them, and the rail needs them to offer what has not been filled in.
 */
export function withSectionMoved(
  planned: PlannedSection[],
  key: string,
  where: Landing,
  target: string | null,
): ResumeSection[] | null {
  const from = planned.findIndex((s) => s.key === key);
  if (from < 0) return null;
  if ((where === 'before' || where === 'after') && (!target || target === key)) return null;

  const rest = planned.filter((s) => s.key !== key);
  const moved = planned[from];

  let at: number;
  if (where === 'start') at = 0;
  else if (where === 'end') at = rest.length;
  else {
    const beside = rest.findIndex((s) => s.key === target);
    if (beside < 0) return null;
    at = where === 'before' ? beside : beside + 1;
  }

  const order = [...rest.slice(0, at), moved, ...rest.slice(at)];
  // Nothing actually moved. Saving a version whose only change is "we put it
  // back where it already was" is worse than saying so.
  if (order.every((s, i) => s.key === planned[i].key)) return null;

  return order.map((s) => ({ key: s.key, label: s.label, shape: s.shape }));
}

/**
 * A stable key for a section named by whatever the resume called it.
 *
 * Keys are what `profile_entries.kind` holds, so they have to survive a round
 * trip and stay recognisable in a database. A label that names one of the seven
 * gets canonicalised — a resume saying "Work Experience" must not create a
 * second experience section beside the real one — and everything else is
 * slugged from what it was called.
 */
const SYNONYMS: Record<string, string> = {
  work_experience: 'experience',
  professional_experience: 'experience',
  employment: 'experience',
  employment_history: 'experience',
  work_history: 'experience',
  relevant_experience: 'experience',
  academic_background: 'education',
  technical_projects: 'projects',
  personal_projects: 'projects',
  selected_projects: 'projects',
  technical_skills: 'skills',
  core_competencies: 'skills',
  professional_summary: 'summary',
  objective: 'summary',
  profile: 'summary',
  about_me: 'summary',
  certificates: 'certifications',
  licenses: 'certifications',
  licences: 'certifications',
  honors: 'awards',
  honours: 'awards',
  achievements: 'awards',
};

/**
 * Keys a section may not claim.
 *
 * 'contact' is pinned at the top of the setup rail and is authored there rather
 * than printed as a section. A resume heading that slugged to it would put two
 * rail items under one key: React would warn about the duplicate, and the
 * section would be permanently unreachable because the pinned one matches
 * first. The extraction prompt says not to return a contact section; this makes
 * it not matter if it does.
 */
const RESERVED = new Set(['contact']);

/**
 * Words that belong to a section, for headings the synonym table cannot list.
 *
 * "Awards & Honors" is one heading out of a hundred spellings of the same
 * section — "Honors & Awards", "Awards and Recognition", "Scholarships &
 * Awards" — and an exact-match table will always be one spelling behind. So a
 * heading matches a section when EVERY word in it belongs to that section.
 *
 * EXPERIENCE IS DELIBERATELY ABSENT. A qualifier changes what that section is:
 * "Volunteer Experience" and "Research Experience" are their own sections, not
 * the person's job history, and folding them in would merge somebody's
 * volunteering into their employment. Compound experience headings stay in the
 * exact table above, where each one is a decision rather than a rule.
 */
const VOCABULARY: [string, Set<string>][] = [
  ['summary', new Set(['summary', 'objective', 'profile', 'about', 'me', 'qualifications', 'professional', 'career', 'personal', 'statement'])],
  ['education', new Set(['education', 'academic', 'academics', 'background', 'training', 'schooling'])],
  ['projects', new Set(['projects', 'project', 'technical', 'personal', 'selected', 'portfolio', 'side'])],
  ['skills', new Set(['skills', 'skill', 'abilities', 'competencies', 'proficiencies', 'technical', 'core', 'expertise'])],
  ['certifications', new Set(['certifications', 'certification', 'certificates', 'certificate', 'licenses', 'license', 'licences', 'licence', 'credentials'])],
  ['awards', new Set(['awards', 'award', 'honors', 'honours', 'honor', 'honour', 'achievements', 'achievement', 'recognition', 'scholarships', 'distinctions'])],
];

/** Words that carry no meaning of their own in a heading. */
const JOINERS = new Set(['and', 'or', 'of', 'the', 'my', 'a', 'in']);

export function keyFor(label: string, taken: Iterable<string> = []): string {
  const slug = clean(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48)
    .replace(/_+$/, '');

  const canonical = KNOWN_SHAPES[slug] ? slug : SYNONYMS[slug];
  if (canonical) return canonical;
  if (!slug) return 'section';

  // Every word in the heading belonging to one section means it IS that
  // section, however it is spelled. One word outside means it is not: that is
  // what keeps "Volunteer Experience" out of somebody's job history.
  const words = slug.split('_').filter((w) => w && !JOINERS.has(w));
  if (words.length) {
    for (const [key, vocabulary] of VOCABULARY) {
      if (words.every((w) => vocabulary.has(w))) return key;
    }
  }

  // Two sections that slug the same would otherwise share a kind, and their
  // entries would pool into whichever one rendered first.
  const used = new Set([...taken, ...RESERVED]);
  if (!used.has(slug)) return slug;
  for (let n = 2; ; n += 1) {
    const candidate = `${slug}_${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * The `profile_entries.kind` an entry-shaped section stores its rows under.
 *
 * Only one section disagrees with its own key: the Projects section is
 * 'projects' and its rows have always been 'project'. Not worth a migration,
 * very much worth being written down in one place.
 */
export function entryKindFor(sectionKey: string): string {
  return sectionKey === 'projects' ? 'project' : sectionKey;
}

/**
 * A `profile_sections` row as the resume wants it.
 *
 * Lives beside the rest of this module rather than at the call site, for the
 * same reason `entryFromRow` does: the last two columns added to an entry were
 * both silently dropped by a hand-written conversion, and saved fine right up
 * until they were read back.
 *
 * Entry-shaped sections carry no content here — their entries are rows in
 * `profile_entries`, keyed by this section's key, and `buildResume` puts them
 * back. Only the shapes with nowhere else to live travel in `content`.
 */
export function sectionFromRow(row: {
  key: string;
  label: string;
  shape: string;
  content: unknown;
  orderIndex: number;
}): ResumeSection {
  const content = (row.content ?? {}) as Partial<ResumeSection>;
  const shape = SHAPES.includes(row.shape as SectionShape) ? (row.shape as SectionShape) : undefined;
  return {
    key: row.key,
    label: row.label,
    ...(shape ? { shape } : {}),
    ...(content.entries ? { entries: content.entries } : {}),
    ...(content.groups ? { groups: content.groups } : {}),
    ...(content.items ? { items: content.items } : {}),
    ...(content.text ? { text: content.text } : {}),
  };
}

/**
 * The keys whose content is held somewhere else entirely.
 *
 * Education, experience and projects are rows in `profile_entries`; skills are
 * facts. Their section row records order and label and nothing more — storing a
 * copy of the content beside the real one is how the two drift apart, which is
 * the failure this whole module exists to stop.
 */
export const STORED_ELSEWHERE = new Set(['education', 'experience', 'projects', 'skills']);

/**
 * Known keys whose shape the resume decides rather than the app.
 *
 * A Certifications section is a flat list on one resume and a list of things
 * with an issuer and a year on the next. Both belong on a page; only one fits
 * `string[]`.
 */
export const FLEXIBLE = new Set(['certifications', 'awards']);

/** The other direction: what belongs in the row's `content` column. */
export function contentOf(section: ResumeSection): Record<string, unknown> {
  // Skills used to land here as `{"groups": []}` — an empty stub beside a
  // profile full of skills, reading as a claim that there were none.
  if (STORED_ELSEWHERE.has(section.key)) return {};

  switch (shapeOf(section)) {
    // Rows, not jsonb — see sectionFromRow.
    case 'entries':
    case 'inline':
      return {};
    case 'groups':
      return { groups: section.groups ?? [] };
    case 'list':
      return { items: section.items ?? [] };
    case 'prose':
      return { text: section.text ?? '' };
    default:
      return {};
  }
}

/**
 * What shape to store for a section, when it did not say.
 *
 * A known key knows its own shape and must be written down as that shape.
 * Defaulting to 'entries' put "this is a list of jobs" next to Projects and
 * Skills in the database — invisible, because the renderer looks the shape up
 * again for known keys rather than trusting the column, and wrong for anything
 * that reads the column and believes it.
 */
export function shapeOf(section: ResumeSection): SectionShape {
  return section.shape ?? KNOWN_SHAPES[section.key] ?? 'entries';
}

function titleCase(key: string): string {
  return key
    .split('_')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
