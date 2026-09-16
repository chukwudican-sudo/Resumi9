import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * The database, as the designs require it.
 *
 * Two things shape this schema more than anything else:
 *
 * A job search is 30-50 applications, not one. So an application is a
 * first-class row with a status and its own history, and the profile is the
 * reusable thing behind all of them.
 *
 * Nothing on a resume may be unsupported. Facts are stored atomically in the
 * person's own words and bullets cite the facts they came from, so an
 * unsupported line is detectable rather than merely unlikely.
 */

const id = () => text('id').primaryKey();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

// ── Account ────────────────────────────────────────────────────────────────

/**
 * Mirrors the Clerk user. `id` is Clerk's `sub` (`user_2ab…`), which is text
 * and NOT a uuid — Supabase's `auth.uid()` returns null for it, so any RLS
 * policy must compare against the raw `sub` claim instead. Keeping this column
 * text is what makes that possible later.
 */
export const users = pgTable('users', {
  id: id(),
  email: text('email').notNull(),
  displayName: text('display_name'),
  /** Drives spelling in generated resumes. A US applicant should not get "organise". */
  locale: text('locale').notNull().default('en-CA'),
  /** From onboarding: internship | new_grad | experienced. */
  stage: text('stage'),
  targetField: text('target_field'),

  plan: text('plan').notNull().default('free'),
  /** One credit is one generation. An entire interview costs one, regardless of length. */
  credits: integer('credits').notNull().default(10),
  creditsResetAt: timestamp('credits_reset_at', { withTimezone: true }),

  createdAt: createdAt(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

// ── Profile ────────────────────────────────────────────────────────────────

/**
 * The composed resume, which is DERIVED — entries, facts and rules are the
 * source of truth. Editing a fact marks this stale so it can be rebuilt rather
 * than drifting out of step with what the person actually said.
 */
export const profiles = pgTable('profiles', {
  id: id(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  resumeStructure: jsonb('resume_structure').notNull().default({}),
  /** Bullet index -> the fact ids supporting it. An uncited bullet is a defect. */
  bulletSources: jsonb('bullet_sources').notNull().default([]),
  /** 0-100, shown on the profile page. Predicts how much hand-editing each tailor needs. */
  strength: integer('strength').notNull().default(0),
  composedAt: timestamp('composed_at', { withTimezone: true }),
  stale: boolean('stale').notNull().default(true),
  /**
   * Sections this person has been through since their last import.
   *
   * A tick in the rail used to mean "this section has something in it", which
   * an import satisfies for every section at once — so an uploaded resume
   * arrived fully ticked before anybody had read a word of it, claiming a check
   * nobody had made.
   *
   * It cannot be derived. Whether somebody has read their own Experience
   * section leaves no trace in the data: a bullet they approved is byte for
   * byte the bullet they never opened. So it is written down when they press
   * Save or Continue, and emptied by the next import, which is the only event
   * that makes every section unread again.
   */
  confirmedSections: jsonb('confirmed_sections').notNull().default([]),
  /**
   * The profile as it stood immediately before the last editorial pass.
   *
   * Polish is the one thing here that rewrites words somebody wrote, across
   * every entry at once, and it can run without being asked for — it fires
   * automatically when Download is pressed on a stale resume. There is no row
   * to put back and no cheap reversal: applying its corrections backwards would
   * turn every "stand-ups" into "standups", including the ones written
   * correctly in the first place. So the state goes in whole, and comes back
   * whole.
   *
   * Holds entries, facts, sections and the three profile fields the pass
   * writes. One pass only — the most recent — and it is cleared by the next
   * edit, because after that it is no longer safe to apply: restoring it would
   * take the edit with it.
   */
  undoSnapshot: jsonb('undo_snapshot'),
  /** When that snapshot was taken. Null means there is nothing to undo. */
  undoAt: timestamp('undo_at', { withTimezone: true }),
  updatedAt: updatedAt(),
}, (t) => ({
  userIdx: uniqueIndex('profiles_user_idx').on(t.userId),
}));

/** A job, project or degree. Facts hang off these. */
export const profileEntries = pgTable('profile_entries', {
  id: id(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  title: text('title'),
  org: text('org'),
  /**
   * Where, in three parts.
   *
   * A resume normally prints "Toronto, ON" and adds the country only when the
   * application crosses a border — so the pieces are stored separately and the
   * rendering decides, rather than asking someone to guess the format.
   */
  city: text('city'),
  region: text('region'),
  country: text('country'),
  /** Kept for entries imported from a resume, where only a string was available. */
  location: text('location'),

  /**
   * When, as numbers.
   *
   * Free text produced a resume where one job read "May – Aug 2025" and the
   * next "Summer 2025" — inconsistency a reader notices and reads as
   * carelessness. Stored as parts, formatted in one place.
   */
  startMonth: integer('start_month'),
  startYear: integer('start_year'),
  endMonth: integer('end_month'),
  endYear: integer('end_year'),
  /** Still there, or still studying. Renders as "Present" / "Expected". */
  isCurrent: boolean('is_current').notNull().default(false),
  /** Fallback for imported entries whose dates could not be parsed. */
  datesDisplay: text('dates_display'),

  /** Where to see it. Projects mostly. */
  url: text('url'),
  /** Optional extras a section may carry — GPA, honours, employment type. */
  extra: jsonb('extra').notNull().default({}),
  /** 0 is most recent. Drives both resume order and which gaps get asked about first. */
  orderIndex: integer('order_index').notNull().default(0),
  /**
   * The lines the person wrote themselves, in their own words.
   *
   * These ARE the master resume — it renders from entries deterministically, so
   * what someone types appears immediately with no model involved and no
   * waiting. Facts are something else: detail gathered by the questions, used
   * to make tailoring better rather than to write the resume.
   */
  bullets: jsonb('bullets').notNull().default([]),
  /** Free text for what a project was built with; unused for jobs. */
  tech: text('tech'),
  source: text('source').notNull().default('interview'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => ({
  userKindIdx: index('profile_entries_user_kind_idx').on(t.userId, t.kind, t.orderIndex),
}));

/**
 * The sections this person's resume has, what they are called, and their order.
 *
 * A real table rather than a field on `profiles`, and the reason is the bug
 * this exists to fix: `profiles.resume_structure` is DERIVED — rebuilt from
 * rows on every save — so anything that lives only there is destroyed by the
 * next edit. That is not a hypothetical. Polish decided section names, wrote
 * them into that blob, and the next saveEntry wiped them; an uploaded Summary
 * showed up in the preview and vanished the first time somebody pressed Polish,
 * because no row anywhere held one.
 *
 * `content` carries the shapes that have nowhere else to live — a summary's
 * paragraph, a certifications list, a custom section's groups. Entry-shaped
 * sections keep their entries in `profile_entries` with `kind` set to this
 * row's `key`, which that column already allows: it is bare text with no
 * constraint, and the (user, kind, order) index already covers it.
 *
 * No rows means the conventional set, which is what the renderer has always
 * done — so nothing needed backfilling and an untouched profile is unaffected.
 */
export const profileSections = pgTable('profile_sections', {
  id: id(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** Matches profile_entries.kind for entry-shaped sections. */
  key: text('key').notNull(),
  /** What it is called on the page. The resume's own word for it. */
  label: text('label').notNull(),
  /** One of entries | inline | groups | list | prose. See lib/sections.ts. */
  shape: text('shape').notNull(),
  content: jsonb('content').notNull().default({}),
  /** Position on the page, 0 first. */
  orderIndex: integer('order_index').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => ({
  userKeyIdx: uniqueIndex('profile_sections_user_key_idx').on(t.userId, t.key),
  userOrderIdx: index('profile_sections_user_order_idx').on(t.userId, t.orderIndex),
}));

/**
 * One atomic thing the person told us, in their words.
 *
 * A real table rather than a jsonb array: appending to an array means
 * read-modify-write of the whole row, which loses a concurrent edit, and
 * coverage becomes a JS reduce instead of a GROUP BY. Facts are also
 * individually editable and deletable by the user, which an array cannot do.
 */
export const facts = pgTable('facts', {
  id: id(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** Null for facts about the person rather than one role — skills, contact details. */
  entryId: text('entry_id').references(() => profileEntries.id, { onDelete: 'cascade' }),
  category: text('category').notNull(),
  text: text('text').notNull(),
  /**
   * Whether the text carries a real quantity. Computed server-side, never taken
   * from the model: a metric fact without a number must not close a metric gap,
   * and that single rule is most of what makes the follow-up questions sharp.
   */
  hasNumber: boolean('has_number').notNull().default(false),
  confidence: real('confidence').notNull().default(1),
  source: text('source').notNull().default('interview'),
  sourceTurnId: text('source_turn_id'),
  status: text('status').notNull().default('active'),
  createdAt: createdAt(),
}, (t) => ({
  entryIdx: index('facts_entry_idx').on(t.userId, t.entryId, t.category),
  categoryIdx: index('facts_category_idx').on(t.userId, t.category),
}));

// ── Interview ──────────────────────────────────────────────────────────────

export const interviewSessions = pgTable('interview_sessions', {
  id: id(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('active'),
  phase: text('phase').notNull().default('identity'),
  phaseStartedAtTurn: integer('phase_started_at_turn').notNull().default(0),
  /** Stored so resuming costs no tokens — the question is already decided. */
  pendingQuestion: jsonb('pending_question'),
  /** Points the composed draft could not settle, carried back into the conversation. */
  openQuestions: jsonb('open_questions').notNull().default([]),
  turnCount: integer('turn_count').notNull().default(0),
  startedAt: createdAt(),
  updatedAt: updatedAt(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (t) => ({
  /**
   * At most one live interview per person, enforced rather than assumed.
   * Partial, so completed and abandoned sessions accumulate freely.
   */
  oneActive: uniqueIndex('interview_one_active_idx')
    .on(t.userId)
    .where(sql`${t.status} in ('active', 'paused')`),
}));

export const interviewTurns = pgTable('interview_turns', {
  id: id(),
  sessionId: text('session_id').notNull().references(() => interviewSessions.id, { onDelete: 'cascade' }),
  idx: integer('idx').notNull(),
  question: jsonb('question').notNull(),
  /** Kept verbatim even when extraction found nothing, so a bad turn loses nothing. */
  rawAnswer: text('raw_answer'),
  skipped: boolean('skipped').notNull().default(false),
  createdAt: createdAt(),
}, (t) => ({
  /** Doubles as the idempotency key — a double-submit cannot duplicate facts. */
  seq: uniqueIndex('interview_turns_seq_idx').on(t.sessionId, t.idx),
}));

// ── Applications ───────────────────────────────────────────────────────────

/**
 * The posting, archived.
 *
 * Listings come down within weeks and people need them back before an
 * interview, so the text is stored rather than linked. `requirements` is what
 * makes cross-posting analysis possible — counting demand for a skill across
 * everything someone saved, against what their profile actually says.
 */
export const jobPostings = pgTable('job_postings', {
  id: id(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  company: text('company'),
  role: text('role'),
  location: text('location'),
  description: text('description'),
  sourceUrl: text('source_url'),
  /** Normalised skill/requirement strings, extracted once at save time. */
  requirements: jsonb('requirements').notNull().default([]),
  closesAt: timestamp('closes_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => ({
  userIdx: index('job_postings_user_idx').on(t.userId, t.createdAt),
}));

/**
 * One role you are pursuing. This is the row the whole app is organised around.
 *
 * `status` replaces the old single-session flag entirely: an interrupted
 * generation is a row in a state, not a boolean in browser storage.
 */
export const applications = pgTable('applications', {
  id: id(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  postingId: text('posting_id').references(() => jobPostings.id, { onDelete: 'set null' }),
  /** draft | applied | interviewing | offer | rejected | withdrawn */
  status: text('status').notNull().default('draft'),
  appliedAt: timestamp('applied_at', { withTimezone: true }),
  /** Set when marked applied. Drives the follow-up nudge that keeps people coming back. */
  followUpDueAt: timestamp('follow_up_due_at', { withTimezone: true }),
  notes: text('notes'),
  /**
   * Deleted, but not gone.
   *
   * A hard delete would take the posting copy with it, and the form that takes
   * a posting promises the opposite in as many words: listings come down within
   * weeks and you will want it back the day before an interview. Undo also has
   * to be able to hand the whole thing back — resume versions included — and
   * re-inserting a row graph from a browser tab is not a thing to rely on.
   *
   * Null means live. Every read that lists or opens an application filters on
   * it; `restoreApplication` is the one function that deliberately does not.
   */
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => ({
  userStatusIdx: index('applications_user_status_idx').on(t.userId, t.status, t.updatedAt),
  followUpIdx: index('applications_follow_up_idx').on(t.userId, t.followUpDueAt),
}));

/**
 * A generated resume. Every version is kept.
 *
 * An instruction edit inserts a new row pointing at its parent rather than
 * mutating — cheap, and it makes undo and comparison free.
 */
export const resumes = pgTable('resumes', {
  id: id(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** Null for a general resume with no target role. */
  applicationId: text('application_id').references(() => applications.id, { onDelete: 'cascade' }),
  mode: text('mode').notNull().default('tailored'),
  structure: jsonb('structure').notNull(),
  matchScore: integer('match_score'),
  missingRequirements: jsonb('missing_requirements').notNull().default([]),
  log: jsonb('log').notNull().default([]),
  warnings: jsonb('warnings').notNull().default([]),
  estimatedPages: integer('estimated_pages'),
  version: integer('version').notNull().default(1),
  parentResumeId: text('parent_resume_id'),
  /** running | complete | failed — what the recovery banner reads instead of localStorage. */
  status: text('status').notNull().default('running'),
  /** Cached compiled PDF, keyed by content hash so an unchanged resume never recompiles. */
  pdfPath: text('pdf_path'),
  createdAt: createdAt(),
}, (t) => ({
  appIdx: index('resumes_application_idx').on(t.applicationId, t.version),
  userIdx: index('resumes_user_idx').on(t.userId, t.createdAt),
}));

// ── Rules ──────────────────────────────────────────────────────────────────

/** Persistent preferences, applied to every generation. One row each so they can be toggled. */
export const rules = pgTable('rules', {
  id: id(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  text: text('text').notNull(),
  active: boolean('active').notNull().default(true),
  /**
   * Position, and therefore priority.
   *
   * The page has always said "Applied in this order" and the model was never
   * told the order meant anything — it received a numbered list and no statement
   * that 1 outranks 2. The prompt says so now.
   */
  orderIndex: integer('order_index').notNull().default(0),
  source: text('source').notNull().default('user'),
  /**
   * The app's reading of the rule, as something it can verify. Null for most.
   *
   * Derived once by a model from the sentence somebody typed, and kept BESIDE
   * their words rather than replacing them — the point of this feature is that
   * a preference is visible and theirs. See RuleCheck in app/lib/rules.ts.
   *
   * Null means guidance: a rule with no machine-checkable reading still goes to
   * the model, and the page says plainly that nothing is being verified.
   */
  check: jsonb('check'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => ({
  userIdx: index('rules_user_idx').on(t.userId, t.orderIndex),
}));

// ── Documents ──────────────────────────────────────────────────────────────

/** Uploaded files. Bytes live in object storage; only the pointer lives here. */
export const documents = pgTable('documents', {
  id: id(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  fileName: text('file_name').notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  storagePath: text('storage_path').notNull(),
  /** Anthropic Files API id, so a PDF is uploaded once rather than on every call. */
  anthropicFileId: text('anthropic_file_id'),
  extractedAt: timestamp('extracted_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => ({
  userIdx: index('documents_user_idx').on(t.userId, t.kind),
}));

// ── Metering ───────────────────────────────────────────────────────────────

/**
 * Every model call, recorded.
 *
 * Written by the one function all Anthropic calls pass through, so a future
 * handler cannot silently skip metering. Also what the daily spend ceiling
 * reads — the mechanism that stops one script becoming a very expensive
 * morning.
 */
export const usageEvents = pgTable('usage_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  model: text('model').notNull(),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
  cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
  costUsd: numeric('cost_usd', { precision: 10, scale: 6 }).notNull(),
  resumeId: text('resume_id'),
  sessionId: text('session_id'),
  createdAt: createdAt(),
}, (t) => ({
  userIdx: index('usage_events_user_idx').on(t.userId, t.createdAt),
  /** For the global daily ceiling, which sums across all users. */
  dayIdx: index('usage_events_day_idx').on(t.createdAt),
}));
