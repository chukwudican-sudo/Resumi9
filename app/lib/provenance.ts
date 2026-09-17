import type { ResumeStructure } from './types';

/**
 * Which bullet on the profile each tailored bullet came from.
 *
 * The guard can tell you an ENTRY survived — it pairs Droady to Droady by
 * employer and dates. Nothing could tell you where a SENTENCE came from, and
 * that is where the tailoring goes wrong: five reviewed resumes each carried
 * rewrites that were faithful for most of a sentence and then added a clause
 * nobody earned. "Backend lead on a 3-person team" came back "…, working both
 * independently and collaboratively". "Set up an automated CI pipeline" came
 * back "…, using Git-based version control throughout" — Git is on the resume,
 * just not in that bullet.
 *
 * Three revisions of the prompt did not stop either one, because both read as
 * reasonable to whoever wrote them. So the model is asked to say, per bullet,
 * which source bullets it is rewriting, and the answer is checked against them.
 *
 * It buys a second thing: a bullet the model did not change comes back as its
 * id alone, with no text. That is most bullets on most resumes, and output
 * tokens are the whole of the wait.
 */

/** A bullet on the profile, as the model is shown it. */
export interface SourceBullet {
  id: string;
  text: string;
  /** Which entry it belongs to — the test for a fact that moved. */
  entry: string;
}

export interface SourceIndex {
  bullets: Map<string, SourceBullet>;
  /** Supporting facts, which are evidence too, keyed the same way. */
  facts: Map<string, { id: string; text: string; entry: string | null }>;
  /**
   * Entry id to what identifies that entry on a finished resume.
   *
   * A name alone is not enough and used to be all this held: two roles at the
   * same employer are one name and two jobs. It matters now because the cut
   * ranking names whole entries as well as bullets, and dropping the wrong one
   * takes a job off somebody's resume.
   */
  entries: Map<string, SourceEntry>;
}

/** Enough of an entry to find it again once the ids have been stripped. */
export interface SourceEntry {
  kind: Kind;
  /** Employer, project name, or school. */
  name: string;
  dates: string;
}

/**
 * One thing the ranking says may go.
 *
 * Bullets and whole entries in a single list, because that is the judgement
 * being asked for: dropping one irrelevant project is usually better than
 * thinning three good jobs, and only something that has read the posting can
 * say which. Education never appears here — it is not cuttable at any rank.
 */
export type CutTarget =
  | { kind: 'bullet'; text: string }
  | { kind: 'entry'; section: 'experience' | 'projects'; name: string; dates: string };

/** One tailored bullet, with what it says it came from. */
export interface ResolvedBullet {
  /** The entry it now sits in, by source id where that could be worked out. */
  entry: string;
  /** What it says on the finished resume. */
  text: string;
  /** False when the model returned the id alone, meaning "unchanged". */
  changed: boolean;
  /**
   * The ids it named, whether or not they resolved.
   *
   * Kept beside `evidence` rather than folded into it because the two answer
   * different questions. `evidence` is what the source SAID, which is what the
   * honesty check compares against; this is what the model POINTED AT, which is
   * how a ranking of ids — least relevant first, for cutting — finds the
   * sentence it is talking about on the finished page.
   */
  from: string[];
  /** The source bullets and facts it named, in the entry it sits in. */
  evidence: string[];
  /** It named a source belonging to a different entry: a fact that moved. */
  moved: boolean;
  /** It named nothing that exists. */
  unsourced: boolean;
}

type Kind = 'experience' | 'projects' | 'education';

const ENTRY_PREFIX: Record<Kind, string> = { experience: 'e', projects: 'p', education: 'd' };

const nameOf = (kind: Kind, entry: any): string =>
  (kind === 'experience' ? entry.org : kind === 'projects' ? entry.name : entry.school) || 'an entry';

/**
 * The profile as the model sees it: every entry and bullet carrying an id.
 *
 * Ids are short on purpose (`e0`, `e0.b1`, `f3`). They are repeated in every
 * bullet that comes back, and a long one would cost more than it explains.
 */
export function annotate(
  structure: ResumeStructure,
  facts: { text: string; entryId?: string | null }[] = [],
): { profile: Record<string, unknown>; index: SourceIndex } {
  const index: SourceIndex = { bullets: new Map(), facts: new Map(), entries: new Map() };
  const profile: Record<string, unknown> = {
    summary: structure.summary,
    skills: structure.skills,
  };

  for (const kind of ['experience', 'projects', 'education'] as Kind[]) {
    profile[kind] = (structure[kind] ?? []).map((entry: any, i: number) => {
      const id = `${ENTRY_PREFIX[kind]}${i}`;
      index.entries.set(id, {
        kind,
        name: nameOf(kind, entry),
        dates: typeof entry.dates === 'string' ? entry.dates : '',
      });
      return {
        ...entry,
        id,
        bullets: (entry.bullets ?? []).map((text: string, j: number) => {
          const bulletId = `${id}.b${j}`;
          index.bullets.set(bulletId, { id: bulletId, text, entry: id });
          return { id: bulletId, text };
        }),
      };
    });
  }

  // Facts carry the entry they were answered about, which the tailor route used
  // to drop. Without it a fact about one job is evidence for every job.
  profile.facts = facts.map((fact, k) => {
    const id = `f${k}`;
    const entry = fact.entryId ?? null;
    index.facts.set(id, { id, text: fact.text, entry });
    return { id, text: fact.text };
  });

  return { profile, index };
}

/**
 * The tailored structure with its bullets back to plain strings, and a record
 * of where each one came from.
 *
 * Tolerant of a bullet that arrives as a bare string: the schema asks for an
 * object, and a schema is a request. A bare string simply has no evidence, and
 * the honesty check treats it as what it is.
 */
export function resolveTailored(
  raw: unknown,
  index: SourceIndex,
): { structure: Record<string, unknown>; bullets: ResolvedBullet[] } {
  const source = (raw ?? {}) as Record<string, any>;
  const structure: Record<string, unknown> = { ...source };
  const bullets: ResolvedBullet[] = [];

  for (const kind of ['experience', 'projects', 'education'] as Kind[]) {
    if (!Array.isArray(source[kind])) continue;

    structure[kind] = source[kind].map((entry: any) => {
      const entryId = typeof entry?.id === 'string' ? entry.id : '';
      const resolved: string[] = [];

      for (const bullet of Array.isArray(entry?.bullets) ? entry.bullets : []) {
        if (typeof bullet === 'string') {
          if (bullet.trim()) {
            resolved.push(bullet);
            bullets.push({ entry: entryId, text: bullet, changed: true, from: [], evidence: [], moved: false, unsourced: true });
          }
          continue;
        }

        const from: string[] = Array.isArray(bullet?.from) ? bullet.from.filter((f: unknown) => typeof f === 'string') : [];
        const named = from.map((id) => index.bullets.get(id) ?? index.facts.get(id)).filter(Boolean) as {
          text: string;
          entry: string | null;
        }[];

        // A fact carries the entry it was answered about; a fact with no entry
        // is about the person and belongs anywhere.
        const own = named.filter((n) => n.entry === null || n.entry === entryId);
        const text = typeof bullet?.text === 'string' && bullet.text.trim() ? bullet.text.trim() : own[0]?.text ?? '';
        if (!text) continue;

        resolved.push(text);
        bullets.push({
          entry: entryId,
          text,
          changed: Boolean(typeof bullet?.text === 'string' && bullet.text.trim()),
          from,
          evidence: own.map((n) => n.text),
          moved: named.length > own.length,
          unsourced: named.length === 0,
        });
      }

      const { id, ...withoutId } = entry ?? {};
      return { ...withoutId, bullets: resolved };
    });
  }

  return { structure, bullets };
}

/**
 * A ranking of source ids turned into the sentences now on the page.
 *
 * The model ranks what it wrote, by the ids it was given. By the time anything
 * cuts, two passes have been over those sentences: the honesty check may have
 * put the person's own wording back where a rewrite claimed too much, and the
 * guard may have restored a whole entry from the profile. So an id cannot be
 * followed to the model's text and used — it has to be followed to whatever
 * actually survived in its place.
 *
 * `reverted` maps a rewrite to what replaced it, which is exactly the shape the
 * honesty check already produces. A bullet replaced by nothing is dropped here:
 * it is not on the resume to cut.
 */
export function cutTargets(
  ranking: unknown,
  bullets: ResolvedBullet[],
  index: SourceIndex,
  reverted: Map<string, string> = new Map(),
): CutTarget[] {
  if (!Array.isArray(ranking)) return [];

  const targets: CutTarget[] = [];
  const seenText = new Set<string>();
  const seenEntry = new Set<string>();

  for (const id of ranking) {
    if (typeof id !== 'string' || !id.trim()) continue;

    // An entry id means the whole job or project may go.
    const entry = index.entries.get(id);
    if (entry) {
      // Education is never cut, however it is ranked. A degree is not something
      // anybody wants traded for a line of space.
      if (entry.kind === 'education' || !entry.name.trim() || seenEntry.has(id)) continue;
      seenEntry.add(id);
      targets.push({ kind: 'entry', section: entry.kind, name: entry.name, dates: entry.dates });
      continue;
    }

    const bullet = bullets.find((b) => b.from.includes(id));
    if (!bullet) continue;
    const text = reverted.has(bullet.text) ? reverted.get(bullet.text)! : bullet.text;
    // Ranked twice, or merged from two sources the model listed separately.
    if (!text.trim() || seenText.has(text)) continue;
    seenText.add(text);
    targets.push({ kind: 'bullet', text });
  }

  return targets;
}
