export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  // Cached tokens are billed separately and are not counted in inputTokens.
  // Optional because sessions persisted before caching was added won't have them.
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd: number;
}

export type ApiErrorType = 'network' | 'auth' | 'generic' | 'timeout';

export interface ApiErrorPayload {
  type: ApiErrorType;
  message: string;
  /**
   * Whether the credit for this attempt was given back.
   *
   * Set only where the handler actually refunded, because the screen says so
   * out loud. Every failure after the spend refunds — but running out of
   * credits, and a profile too thin to tailor, are refused before anything is
   * spent, and telling somebody their credit came back when it never left is
   * the kind of small lie that costs trust in everything else on the page.
   */
  creditKept?: boolean;
}

// ── Onboarding ─────────────────────────────────────────────────────────────

/**
 * What we ask before getting out of the way.
 *
 * Deliberately two fields. Asking more up front is what drives people off, and
 * everything else about them is collected later by the thing that is already
 * good at it — the questions, or their uploaded resume.
 */
export type CareerStage = 'internship' | 'new_grad' | 'experienced';

export const CAREER_STAGE_LABELS: Record<CareerStage, string> = {
  internship: 'Looking for an internship',
  new_grad: 'New grad / early career',
  experienced: 'Experienced hire',
};

// ── Interview model ────────────────────────────────────────────────────────
// The interview collects atomic facts rather than finished bullets. Bullets are
// composed from facts at the end, which is what lets the question generator see
// that an entry is missing a number or a team size and ask about exactly that.
//
// These are shaped as rows on purpose: the persistence swap in a later
// milestone should move them to Postgres without redesigning them.

export type FactCategory =
  | 'action'      // what they did
  | 'metric'      // a number that shows size or change
  | 'scope'       // team size, users served, budget, surface owned
  | 'tooling'     // languages, frameworks, services
  | 'outcome'     // what changed as a result
  | 'context'     // constraints, why it mattered
  | 'skill'       // a capability, not tied to one entry
  | 'credential'  // degree, certification, award
  | 'preference'  // how they want the resume written
  | 'identity';   // name, contact, location

export type FactSource = 'interview' | 'resume_import' | 'linkedin' | 'github' | 'manual';

/**
 * The three the app has always had. Still meaningful — the interview scores
 * against them and the resume builder reads them by name — but no longer the
 * complete set: an entry can also belong to a section the person's own resume
 * had, filed under that section's key.
 */
export type EntryKind = 'experience' | 'project' | 'education';

export interface ProfileEntry {
  id: string;
  /** One of EntryKind, or a custom section's key. See lib/sections.ts. */
  kind: string;
  title?: string;
  org?: string;
  location?: string;
  datesDisplay?: string;
  /** 0 is most recent. Drives both resume order and question priority. */
  orderIndex: number;
  source: FactSource;
}

export interface Fact {
  id: string;
  /** null for facts that belong to the person rather than one entry. */
  entryId: string | null;
  category: FactCategory;
  text: string;
  /** Whether the text carries a real quantity. A metric fact without one does not close a metric gap. */
  hasNumber: boolean;
  confidence: number;
  source: FactSource;
  sourceTurnId: string | null;
  status: 'active' | 'archived' | 'superseded';
}

export type InterviewPhase = 'identity' | 'breadth' | 'depth' | 'skills';

export interface InterviewQuestion {
  text: string;
  /** Shown to the user so the interview explains itself. */
  why: string;
  targets: { entryId: string | null; category: FactCategory };
  kind: 'open' | 'numeric' | 'choice';
  choices?: string[];
  skippable: boolean;
}

export interface InterviewTurn {
  id: string;
  idx: number;
  question: InterviewQuestion;
  rawAnswer: string;
  skipped: boolean;
}

export interface InterviewSession {
  id: string;
  status: 'active' | 'paused' | 'completed' | 'abandoned';
  phase: InterviewPhase;
  turns: InterviewTurn[];
  pendingQuestion: InterviewQuestion | null;
  startedAt: string;
  completedAt: string | null;
}

export interface ResumeStructure {
  name: string;
  contact: { phone?: string; email?: string; linkedin?: string; github?: string; website?: string };
  summary?: string;
  education: { school: string; location: string; degree: string; dates: string; bullets?: string[] }[];
  experience: { title: string; dates: string; org: string; location: string; bullets: string[] }[];
  projects: { name: string; tech: string; dates: string; bullets: string[]; url?: string }[];
  skills: { category: string; items: string }[];
  certifications?: string[];
  awards?: string[];
  /**
   * Every section, in the order it prints, with what it is called.
   *
   * Absent means the conventional order — nothing depends on this having been
   * written. The seven keys the app knows appear here for ORDER AND LABEL ONLY;
   * their content stays in the named fields above, which is what keeps every
   * scorer, guard and importer reading the same place it always did. Any other
   * key carries its content inline, because there is nowhere else for it.
   */
  sections?: ResumeSection[];
}

/** How a section is drawn. Five of these; the template already draws all five. */
export type SectionShape = 'entries' | 'inline' | 'groups' | 'list' | 'prose';

/**
 * One row inside a custom section, in human terms rather than layout terms.
 *
 * The mapping onto the template's four heading slots is sections.ts's job —
 * whoever writes one of these should be thinking about a role and an employer,
 * not about which corner of the page each lands in.
 */
export interface SectionEntry {
  title?: string;
  org?: string;
  location?: string;
  dates?: string;
  /** What it was built with. Only meaningful for the `inline` shape. */
  tech?: string;
  url?: string;
  bullets?: string[];
}

export interface ResumeSection {
  key: string;
  label: string;
  /** Omitted for the seven known keys, which carry their own. */
  shape?: SectionShape;
  entries?: SectionEntry[];
  groups?: { category: string; items: string }[];
  items?: string[];
  text?: string;
}
