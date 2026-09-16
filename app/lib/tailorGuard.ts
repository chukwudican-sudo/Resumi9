import { parseDates } from './entryFormat';
import { patternFor, waysOfWriting } from './requirementMatch';
import type { ResumeStructure } from './types';

/**
 * What the tailoring pass is not allowed to quietly take away.
 *
 * Read the provenance before trusting the premise. This was written after a
 * tailored resume appeared to lose a fifteen-month job, and that turned out to
 * be wrong: the person had deleted the entry themselves while testing, and the
 * model had tailored faithfully from a profile that no longer held it. Entry
 * deletion is a hard delete with no audit trail, which is why it took reading
 * timestamps to find out.
 *
 * So the headline case here — a tailored resume losing a whole entry — has
 * never been observed. It is a precaution, kept because the prompt forbids it
 * (rules 2 and 3 in systemPrompt.ts), because a model that is merely asked will
 * eventually not comply, and because the cost of being wrong is asymmetric: a
 * restore that should not have happened leaves a duplicate anybody can see and
 * delete, while a deletion nobody catches is a hole in an employment history.
 *
 * Two of the things it fixes ARE observed and were verified separately:
 *
 *   - Section names. The tailor's schema has no field for `sections` and sets
 *     additionalProperties false, so the model cannot return the naming polish
 *     chose however well it behaves. Every tailored resume was losing it —
 *     visible as "WORK EXPERIENCE" on a master resume and "EXPERIENCE" on the
 *     tailored copy of the very same resume.
 *   - Dropped skills. A real polish run lost "Ms PowerPoint" from a skills
 *     list; the same recovery lives in polish.ts for the same reason.
 *
 * Reverting a changed date or a tidied employer name is likewise precautionary,
 * and is the half worth keeping most: a missing job is visible the moment
 * somebody reads their own resume, while a date moved by three months looks
 * right, reads right, and is found by a background check.
 *
 * The guard only ever moves the resume back toward the profile. It restores and
 * it reverts; it never deletes, never trims, never invents a third thing.
 */

type Experience = ResumeStructure['experience'][number];
type Project = ResumeStructure['projects'][number];
type Education = ResumeStructure['education'][number];

export interface Repair {
  /** Decides where it surfaces and how loudly. See surfaceRepairs. */
  kind: 'entry' | 'bullets' | 'field' | 'skill' | 'extra';
  /** One sentence, addressed to the person, ready to render. */
  message: string;
  /** The same event in the change log's voice. */
  logLine: string;
}

export interface TailorGuardResult {
  structure: ResumeStructure;
  repairs: Repair[];
  /**
   * Nothing in what came back could be matched to the profile.
   *
   * Not a repair — a failure. The guard's restores are a safety net under a
   * tailoring that mostly worked; when EVERY entry has to be restored, there
   * was no tailoring, and `structure` below is simply the profile again. One
   * real run did this: the model wrote a full resume (3,315 output tokens),
   * none of it arrived in a shape this file could read, and the untouched
   * profile was saved as a tailored resume with eleven "put back" warnings and
   * a credit spent. The caller refunds and says so instead.
   */
  unusable: boolean;
}

// ── comparing ──────────────────────────────────────────────────────────────

/** Letters and digits only — the same comparison polish.ts makes, for the same reason. */
function norm(text: string | null | undefined): string {
  return (text ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function asList<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * What the model returned, as an object, whatever it sent.
 *
 * A forced tool call does not guarantee the shape inside it: a nested object
 * can arrive as a JSON string holding the same thing. Everything downstream
 * reads `raw.experience` and finds nothing, so a whole tailored resume reads as
 * an empty one — which is exactly how a real tailor came to be saved as the
 * person's own untouched profile. Parsing here costs nothing and turns a silent
 * emptiness into either a resume or an honest failure.
 */
export function normaliseTailored(tailored: unknown): unknown {
  if (typeof tailored !== 'string') return tailored;
  try {
    return JSON.parse(tailored);
  } catch {
    return null;
  }
}

/**
 * A date range reduced to what it says rather than how it was typed.
 *
 * "May – Aug 2025", "May 2025 – Aug 2025" and "05/2025 – 08/2025" are one key.
 * The model is forbidden from changing dates and mostly does not, but it does
 * reformat them — and a reformat read as a deletion would put a duplicate job
 * on somebody's resume. Anything unparseable falls back to its letters, so an
 * odd range still matches itself.
 */
function dateKey(dates: string | null | undefined): string {
  const parts = parseDates(dates);
  if (!parts.startYear && !parts.endYear) return norm(dates);
  return [
    parts.startYear ?? '',
    parts.startMonth ?? '',
    parts.isCurrent ? 'now' : parts.endYear ?? '',
    parts.isCurrent ? '' : parts.endMonth ?? '',
  ].join('-');
}

type Match<T> = (source: T, tailored: T) => boolean;

/**
 * Equality on every named part, where an empty part never matches.
 *
 * Without that, two entries which both omit a location match on "" and the
 * wrong one is declared a survivor — which is the failure this module exists to
 * catch, produced by the module itself.
 */
const byParts =
  <T,>(...parts: ((item: T) => string)[]): Match<T> =>
  (a, b) =>
    parts.every((part) => {
      const key = part(a);
      return key !== '' && key === part(b);
    });

/** One name inside the other: "Resumi" tailored to "Resumi — Resume Tailoring Platform". */
const byContainedName: Match<Project> = (a, b) => {
  const x = norm(a.name);
  const y = norm(b.name);
  // Long enough that containment means something — "api" sits inside "rapidapi".
  return x.length >= 6 && y.length >= 6 && (x.includes(y) || y.includes(x));
};

/**
 * How far each field is trusted as identity, strongest first.
 *
 * Dates and employer names are the two things rule 2 forbids changing AND that
 * no tailoring decision wants to change — there is no job-specific better
 * version of "Aegon". Titles are the opposite: the model is explicitly allowed
 * to rewrite them, and did ("Wealth Manager" became "Wealth Manager (Client
 * Services & Financial Planning)"). So a title match is worthless as identity
 * and a title mismatch says nothing at all.
 *
 * Dates alone is deliberately not a rung. Two unrelated jobs sharing
 * "2023 – 2024" is ordinary; an employer rename is a rule-2 violation and rare.
 * That rung carries the location with it or it does not run.
 */
const EXPERIENCE_LADDER: Match<Experience>[] = [
  byParts((x) => norm(x.org), (x) => dateKey(x.dates)),
  byParts((x) => norm(x.org)),
  byParts((x) => dateKey(x.dates), (x) => norm(x.location)),
];

const PROJECT_LADDER: Match<Project>[] = [
  byParts((p) => norm(p.name)),
  byContainedName,
  byParts((p) => dateKey(p.dates), (p) => norm(p.tech)),
];

// Degree is never a key: composeDegree bolts the credential, honours and GPA
// onto the field of study, so the string is composite and any part can move.
const EDUCATION_LADDER: Match<Education>[] = [
  byParts((e) => norm(e.school), (e) => dateKey(e.dates)),
  byParts((e) => norm(e.school)),
];

/**
 * Pairs tailored entries back to the source entries they came from.
 *
 * Greedy, strongest rung first, and every match is consumed: a source entry
 * claims at most one tailored entry and a tailored entry answers for at most
 * one source entry. Without consumption two roles at the same employer collapse
 * onto each other and the second never reads as deleted — which is the shape of
 * a promotion, and the shape of the bug.
 *
 * A rung completes across every entry before the next is tried, so a weaker key
 * can never claim an entry a stronger one was going to want.
 */
export function pairUp<T>(source: T[], tailored: T[], ladder: Match<T>[]): Map<number, number> {
  const pairs = new Map<number, number>();
  const claimed = new Set<number>();

  for (const matches of ladder) {
    for (let s = 0; s < source.length; s += 1) {
      if (pairs.has(s)) continue;
      const t = tailored.findIndex((item, i) => !claimed.has(i) && matches(source[s], item));
      if (t === -1) continue;
      pairs.set(s, t);
      claimed.add(t);
    }
  }

  return pairs;
}

/**
 * Puts back what is missing, beside the neighbour it had.
 *
 * Not at its old index — the model has reordered by then and the index means
 * nothing. Not at the end either: appended, a fifteen-month role reads as the
 * least important thing on the page, and if it was the most recent job the
 * section stops making chronological sense.
 *
 * Beside its neighbour, because the master resume is already in the person's
 * order: buildResume sorts a section by recency when every entry is dated and
 * keeps the order they gave when they are not. Anchoring on a surviving
 * neighbour inherits whichever rule applied, without imposing a sort on a
 * section the model deliberately reordered.
 *
 * Each restored entry becomes an anchor for the next, so two consecutive
 * deletions come back in the order they were in.
 */
export function restoreMissing<T>(
  source: T[],
  tailored: T[],
  pairs: Map<number, number>,
): { entries: T[]; missing: T[] } {
  const from = new Map<number, number>();
  for (const [s, t] of pairs) from.set(t, s);

  // Slots carry where they came from rather than being tracked by identity:
  // every splice invalidates a cached index, and two entries can legitimately
  // look identical.
  const out = tailored.map((item, t) => ({ item, from: from.get(t) ?? -1 }));
  const missing: T[] = [];

  for (let s = 0; s < source.length; s += 1) {
    if (out.some((slot) => slot.from === s)) continue;
    missing.push(source[s]);

    let at = -1;
    for (let before = s - 1; before >= 0 && at < 0; before -= 1) {
      const i = out.findIndex((slot) => slot.from === before);
      if (i >= 0) at = i + 1;
    }
    for (let after = s + 1; after < source.length && at < 0; after += 1) {
      const i = out.findIndex((slot) => slot.from === after);
      if (i >= 0) at = i;
    }
    out.splice(at < 0 ? out.length : at, 0, { item: source[s], from: s });
  }

  return { entries: out.map((slot) => slot.item), missing };
}

// ── reconciling a matched pair ─────────────────────────────────────────────

/**
 * Words that describe what somebody was hired to be.
 *
 * Titles are rewritten by design and that is fine. Seniority is the exception:
 * an internship rewritten as a job is a claim about what they were hired to do,
 * and unlike everything else here it is a pure token test with no judgement in
 * it.
 */
const JUNIOR = /\b(intern|internship|co-?op|trainee|apprentice|assistant|junior|jr|student|volunteer)\b/i;

function reverted(
  kind: 'dates' | 'employer' | 'school' | 'location' | 'title',
  what: string,
  to: string,
): Repair {
  const nouns: Record<typeof kind, string> = {
    dates: 'dates',
    employer: 'employer name',
    school: 'school name',
    location: 'location',
    title: 'title',
  };
  return {
    kind: 'field',
    message:
      kind === 'title'
        ? `The title on ${what} had been changed in a way that reads more senior, so it was set back to what your profile says: ${to}.`
        : `The ${nouns[kind]} on ${what} had been changed, so ${nouns[kind] === 'dates' ? 'they were' : 'it was'} set back to what your profile says: ${to}.`,
    logLine: `${what}: ${nouns[kind]} set back to ${to}; the tailoring had changed ${nouns[kind] === 'dates' ? 'them' : 'it'}.`,
  };
}

const jobLabel = (x: { title?: string; org?: string; dates?: string }) =>
  [x.title, x.org && `at ${x.org}`].filter(Boolean).join(' ') || 'a role';

/**
 * Trimming bullets is what tailoring is for. Trimming all of them is a deletion
 * that left the sign up, and a heading with nothing under it is worse than
 * either keeping the entry or cutting it.
 */
function keepBullets(source: string[], tailored: unknown, what: string, repairs: Repair[]): string[] {
  const kept = asList<string>(tailored).filter((b) => typeof b === 'string' && b.trim());
  if (kept.length > 0 || source.length === 0) return kept;
  repairs.push({
    kind: 'bullets',
    message: `${what} came back with no bullet points at all, so the ones from your profile were kept. Trim them yourself if the resume runs long.`,
    logLine: `${what}: every bullet had been removed, leaving a heading over nothing. Restored from your profile.`,
  });
  return source;
}

// ── the pass ───────────────────────────────────────────────────────────────

/**
 * Everything the tailoring returned, checked against everything it was given.
 *
 * `tailored` is typed unknown rather than ResumeStructure on purpose: the type
 * is a claim about a tool schema, not about what actually arrives, and a
 * structure whose `experience` is a bare string would otherwise throw inside a
 * `.map` on the server — after the credit has been spent.
 */
export function validateTailored(
  source: ResumeStructure,
  tailored: unknown,
  /**
   * What the source is, in the person's words. A tailor compares against the
   * profile; an instruction edit compares against the version on screen, and
   * telling somebody their bullets were "restored from your profile" when they
   * came from the previous version is simply untrue.
   */
  options: { sourceLabel?: string } = {},
): TailorGuardResult {
  const repairs: Repair[] = [];
  const from = options.sourceLabel ?? 'your profile';
  const raw = (normaliseTailored(tailored) ?? {}) as Partial<ResumeStructure>;

  // ── experience ──
  const srcJobs = asList<Experience>(source.experience);
  const outJobs = asList<Experience>(raw.experience).filter((e) => e && typeof e === 'object');
  const jobPairs = pairUp(srcJobs, outJobs, EXPERIENCE_LADDER);

  const reconciledJobs = outJobs.map((out, t) => {
    const s = [...jobPairs].find(([, ti]) => ti === t)?.[0];
    if (s === undefined) return out;
    const src = srcJobs[s];
    const fixed: Experience = { ...out };
    const what = jobLabel(src);

    // Reverted, not merely flagged. A dropped job is visible the moment somebody
    // reads their own resume; a date quietly moved by three months looks right,
    // reads right, and is found by a background check.
    if (dateKey(out.dates) !== dateKey(src.dates)) repairs.push(reverted('dates', what, src.dates));
    fixed.dates = src.dates;
    if (norm(out.org) !== norm(src.org)) repairs.push(reverted('employer', what, src.org));
    fixed.org = src.org;
    if (norm(out.location) !== norm(src.location) && norm(src.location)) {
      repairs.push(reverted('location', what, src.location));
    }
    fixed.location = src.location;

    if (JUNIOR.test(src.title ?? '') && !JUNIOR.test(asText(out.title))) {
      repairs.push(reverted('title', what, src.title));
      fixed.title = src.title;
    }

    fixed.bullets = keepBullets(asList<string>(src.bullets), out.bullets, what, repairs);
    return fixed;
  });

  const jobs = restoreMissing(srcJobs, reconciledJobs, jobPairs);
  for (const lost of jobs.missing) {
    repairs.push({
      kind: 'entry',
      message: `The tailoring dropped your ${jobLabel(lost)}${lost.dates ? ` (${lost.dates})` : ''} and it has been put back as ${from} has it. Read it over — it will not sound like the entries around it.`,
      logLine: `${jobLabel(lost)}: this role was dropped from the tailored version. Restored from ${from}, unedited.`,
    });
  }

  // ── projects ──
  const srcProjects = asList<Project>(source.projects);
  const outProjects = asList<Project>(raw.projects).filter((p) => p && typeof p === 'object');
  const projectPairs = pairUp(srcProjects, outProjects, PROJECT_LADDER);

  const reconciledProjects = outProjects.map((out, t) => {
    const s = [...projectPairs].find(([, ti]) => ti === t)?.[0];
    if (s === undefined) return out;
    const src = srcProjects[s];
    const fixed: Project = { ...out };
    const what = src.name || 'a project';
    if (dateKey(out.dates) !== dateKey(src.dates)) repairs.push(reverted('dates', what, src.dates));
    fixed.dates = src.dates;
    // The schema asks for the link to come back untouched. Asking is not
    // enforcing, and a link is not something tailoring has an opinion about.
    fixed.url = src.url;
    fixed.bullets = keepBullets(asList<string>(src.bullets), out.bullets, what, repairs);
    return fixed;
  });

  const projects = restoreMissing(srcProjects, reconciledProjects, projectPairs);
  for (const lost of projects.missing) {
    repairs.push({
      kind: 'entry',
      message: `The tailoring dropped your ${lost.name} project and it has been put back as ${from} has it.`,
      logLine: `${lost.name}: this project was dropped from the tailored version. Restored from ${from}, unedited.`,
    });
  }

  // ── education ──
  const srcSchools = asList<Education>(source.education);
  const outSchools = asList<Education>(raw.education).filter((e) => e && typeof e === 'object');
  const schoolPairs = pairUp(srcSchools, outSchools, EDUCATION_LADDER);

  const reconciledSchools = outSchools.map((out, t) => {
    const s = [...schoolPairs].find(([, ti]) => ti === t)?.[0];
    if (s === undefined) return out;
    const src = srcSchools[s];
    const fixed: Education = { ...out };
    const what = src.school || 'your education';
    if (dateKey(out.dates) !== dateKey(src.dates)) repairs.push(reverted('dates', what, src.dates));
    fixed.dates = src.dates;
    if (norm(out.school) !== norm(src.school)) repairs.push(reverted('school', what, src.school));
    fixed.school = src.school;
    fixed.location = src.location;
    // A degree is a credential, not a pitch. There is no job-specific better
    // way to say "Bachelor of Engineering in Software Engineering".
    fixed.degree = src.degree;
    return fixed;
  });

  const schools = restoreMissing(srcSchools, reconciledSchools, schoolPairs);
  for (const lost of schools.missing) {
    repairs.push({
      kind: 'entry',
      message: `The tailoring dropped ${lost.degree || 'your degree'} at ${lost.school} and it has been put back.`,
      logLine: `${lost.school}: this qualification was dropped from the tailored version. Restored from ${from}.`,
    });
  }

  // ── skills ──
  //
  // Reordering and regrouping is licensed; dropping is not, and skills are what
  // a recruiter keyword-scans. Recovered at term level rather than group level,
  // because the grouping is the tailor's to decide and the terms are not.
  const srcSkills = asList<ResumeStructure['skills'][number]>(source.skills);
  const outSkills = asList<ResumeStructure['skills'][number]>(raw.skills)
    .filter((g) => g && typeof g === 'object' && asText(g.items).trim())
    .map((g) => ({ category: asText(g.category) || 'Skills', items: asText(g.items) }));

  /*
   * "Still there" is a reading, not a string comparison.
   *
   * This used to ask whether the exact normalised term came back. It does not
   * survive ordinary regrouping: a model that wrote "Git/GitHub" for "Git,
   * GitHub", or "Data Pipelines/ETL" for "Data Pipelines", was judged to have
   * dropped the originals — and the repair then appended them to whichever
   * group happened to be last. That is how Git, GitHub, Vercel and Cloudflare
   * Workers ended up filed under "AI & Data", and how "Data Pipelines" came to
   * be listed twice on the same resume.
   *
   * `waysOfWriting` and `patternFor` are the same readers the requirement match
   * uses, so "C++" is found, "Go" is not found inside "Google", and a term
   * inside a combined item counts as present.
   */
  const splitTerms = (items: string) => items.split(',').map((t) => t.trim()).filter(Boolean);
  const written = outSkills.map((g) => g.items).join(', ');
  const stillThere = (term: string) =>
    waysOfWriting(term).some((way) => patternFor(way).test(written));

  const skills = outSkills.length ? outSkills.map((g) => ({ ...g })) : srcSkills.map((g) => ({ ...g }));
  const lostTerms: string[] = [];

  if (outSkills.length) {
    // Group by group, so a term goes home rather than to the end. Regrouping is
    // the tailor's to decide; losing somebody's PowerPoint is not.
    for (const group of srcSkills) {
      const missing = splitTerms(asText(group.items)).filter((t) => norm(t) && !stillThere(t));
      if (!missing.length) continue;
      lostTerms.push(...missing);
      const home = skills.find((g) => norm(g.category) === norm(group.category));
      if (home) home.items = [home.items, ...missing].filter(Boolean).join(', ');
      else skills.push({ category: asText(group.category) || 'Skills', items: missing.join(', ') });
    }
  }

  if (lostTerms.length) {
    repairs.push({
      kind: 'skill',
      message: `${lostTerms.length} of your skills were missing from the tailored version and have been put back.`,
      logLine: `Skills: put back ${lostTerms.length} ${lostTerms.length === 1 ? 'term' : 'terms'} the tailoring dropped — ${lostTerms.join(', ')}.`,
    });
  }

  // ── the rest ──
  // `returned`, not `from`: `from` is now the label for where restores come
  // from, and a parameter of the same name would quietly shadow it here.
  const keepList = (returned: unknown, fallback: string[] | undefined, what: string): string[] | undefined => {
    const src = fallback ?? [];
    // Nothing on the profile means nothing on the tailored copy.
    //
    // This used to hand back whatever the model sent when there was no source
    // list to check against — and the tailor's schema still has these fields,
    // so it can fill one in. That is an invented credential on somebody's
    // resume, which is the one failure this whole guard exists to prevent.
    // Certifications stored as entries leave this field empty, so it stopped
    // being a corner case and started being everybody who has any.
    if (!src.length) return fallback;
    // Never asked for is not the same as dropped.
    //
    // The tailoring schema no longer carries these — the model was filling them
    // in, and everything it filled in was thrown away here anyway. Without this
    // line, an absent field reads as a deletion and every single tailor reports
    // "your certifications were missing and have been put back". These fields
    // were optional even before that, so an omission was never proof of a loss.
    if (from === undefined) return src;
    const out = asList<string>(from).filter((v) => typeof v === 'string' && v.trim());
    const missing = src.filter((v) => !out.some((o) => norm(o) === norm(v)));
    if (!missing.length) return out;
    repairs.push({
      kind: 'entry',
      message: `Your ${what} were missing from the tailored version and have been put back.`,
      logLine: `${what}: ${missing.length} missing ${missing.length === 1 ? 'item' : 'items'} restored from your profile.`,
    });
    return [...out, ...missing];
  };

  // Same rule for the summary: a tailored copy does not grow a section the
  // master resume does not have. The person decides what sections they have.
  const summary = source.summary?.trim() ? asText(raw.summary).trim() || source.summary : undefined;
  if (source.summary?.trim() && !asText(raw.summary).trim()) {
    repairs.push({
      kind: 'entry',
      message: 'Your summary was missing from the tailored version and has been put back.',
      logLine: `Summary: dropped by the tailoring and restored from ${from}.`,
    });
  }

  // An entry that answers to nothing in the profile is reported and kept. The
  // asymmetry is deliberate: restoring only ever adds something removable,
  // while deleting on a bad match destroys real work.
  const strays = outJobs.length - jobPairs.size;
  if (strays > 0) {
    repairs.push({
      kind: 'extra',
      message: `There ${strays === 1 ? 'is an entry' : `are ${strays} entries`} in this resume that ${strays === 1 ? 'is' : 'are'} not in your profile. Check ${strays === 1 ? 'it' : 'them'} before you send this.`,
      logLine: `${strays} experience ${strays === 1 ? 'entry does' : 'entries do'} not correspond to anything in your profile.`,
    });
  }

  return {
    repairs,
    /*
     * Not one entry answered to anything in the source.
     *
     * Every restore above fired, so `structure` below is the source copied back
     * with a pile of "we put this back" notices attached. That is not a tailored
     * resume, and saving it as one is how somebody paid a credit for their own
     * profile under a new filename.
     */
    unusable:
      jobPairs.size + projectPairs.size + schoolPairs.size === 0 &&
      srcJobs.length + srcProjects.length + srcSchools.length > 0,
    structure: {
      // Nothing the tailored copies carry that the source does not.
      name: source.name,
      contact: source.contact,
      summary,
      education: schools.entries,
      experience: jobs.entries,
      projects: projects.entries,
      skills,
      certifications: keepList(raw.certifications, source.certifications, 'certifications'),
      awards: keepList(raw.awards, source.awards, 'awards'),
      // The tailor's schema has no field for these and forbids extra ones, so
      // the model cannot return them however well it behaves — and every
      // tailored resume was silently losing the section names polish chose.
      // Visible as "WORK EXPERIENCE" on the master and "EXPERIENCE" on the
      // tailored copy of the same resume.
      sections: source.sections,
    },
  };
}

/**
 * Splits repairs into the two places the screen already has for them.
 *
 * A restore is both a thing to check before sending and an edit that was made,
 * so most go in both or the two panels contradict each other. Recovered skill
 * terms are the exception: worth recording, not worth stopping over.
 *
 * Guard lines lead the log. The point of a restore notice is lost at item
 * fourteen of sixteen.
 */
export function surfaceRepairs(repairs: Repair[]): { warnings: string[]; log: string[] } {
  return {
    warnings: repairs.filter((r) => r.kind !== 'skill').map((r) => r.message),
    log: repairs.map((r) => r.logLine),
  };
}
