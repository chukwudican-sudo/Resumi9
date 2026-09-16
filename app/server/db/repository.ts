import { and, desc, eq, inArray, isNotNull, isNull, lte, notInArray, sql } from 'drizzle-orm';
import { db } from './client';
import type { ResumeStructure } from '../../lib/types';
import { MONTHLY_CREDITS, nextReset } from '../../lib/credits';
import { splitEmployment } from '../../lib/employment';
import { entriesFromStructure, factsFromStructure, sectionsFromStructure } from '../../lib/importRows';
import { contentOf, sectionFromRow, shapeOf } from '../../lib/sections';
import type { ResumeSection } from '../../lib/types';
import {
  applications,
  documents,
  facts,
  interviewSessions,
  interviewTurns,
  jobPostings,
  profileEntries,
  profileSections,
  profiles,
  resumes,
  rules,
  usageEvents,
  users,
} from './schema';

/**
 * Every database read and write in the app.
 *
 * The rule that matters: **every exported function takes `userId` as its first
 * parameter and scopes its query by it.** The server holds a service-role
 * connection that bypasses row-level security, so a single forgotten
 * `where user_id` is a cross-tenant leak — one person's work history shown to
 * another. Concentrating every query here makes that a reviewable surface
 * rather than something spread across dozens of route handlers.
 *
 * Nothing outside this directory may import `./client`.
 */

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 22)}`;
}

/**
 * Rows as they come out of the database, and as they go back in.
 *
 * These are what a delete hands back and what a restore takes: the whole row,
 * so putting it back is putting the same thing back rather than making a new
 * one that resembles it.
 */
export type ProfileEntryRow = typeof profileEntries.$inferSelect;
export type RuleRow = typeof rules.$inferSelect;
export type FactRow = typeof facts.$inferSelect;
export type ProfileSectionRow = typeof profileSections.$inferSelect;


// ── Users ──────────────────────────────────────────────────────────────────

/** Called from the Clerk webhook. Idempotent: Clerk retries deliveries. */
export async function upsertUser(userId: string, email: string, displayName?: string) {
  const [row] = await db
    .insert(users)
    .values({ id: userId, email, displayName })
    .onConflictDoUpdate({
      target: users.id,
      set: { email, displayName },
    })
    .returning();
  return row;
}

export async function getUser(userId: string) {
  await resetCreditsIfDue(userId);
  const [row] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  return row ?? null;
}

export async function setOnboardingGoal(userId: string, stage: string, targetField: string) {
  await db.update(users).set({ stage, targetField }).where(eq(users.id, userId));
}

/**
 * Which English the resumes come out in.
 *
 * The column has been read by the prompt builder since it was added, but
 * nothing could ever write it, so every account sat on the en-CA default and an
 * applicant in Texas got "organise" and "licence" with no way to say otherwise.
 * Validated against SPELLING by the action that calls this.
 */
export async function setUserLocale(userId: string, locale: string) {
  await db.update(users).set({ locale }).where(eq(users.id, userId));
}

/**
 * Starts a new month if this account's is over.
 *
 * One statement, and the where clause carries the condition. Read-then-write
 * would let two tabs both decide a reset is due and both grant a month, which
 * is the same race the spend below is written to avoid.
 *
 * Lazy rather than scheduled: it runs on a row that is being read anyway, so
 * there is no cron job to deploy, monitor, or discover has silently stopped.
 */
export async function resetCreditsIfDue(userId: string): Promise<void> {
  await db
    .update(users)
    .set({ credits: MONTHLY_CREDITS, creditsResetAt: nextReset() })
    .where(
      and(
        eq(users.id, userId),
        // Null covers every account created before resets existed.
        sql`(${users.creditsResetAt} is null or ${users.creditsResetAt} <= now())`,
      ),
    );
}

/**
 * Spends one credit, atomically.
 *
 * The check and the decrement are one statement on purpose: doing them as a
 * read then a write lets two concurrent generations both pass a check for the
 * last remaining credit. Returns null when there was nothing left to spend.
 */
export async function spendCredit(userId: string): Promise<number | null> {
  // A month that has rolled over is granted before the spend, so somebody
  // returning after a gap is not told they are out on their first attempt.
  await resetCreditsIfDue(userId);

  const [row] = await db
    .update(users)
    .set({ credits: sql`${users.credits} - 1` })
    .where(and(eq(users.id, userId), sql`${users.credits} > 0`))
    .returning({ credits: users.credits });
  return row?.credits ?? null;
}

/**
 * Gives one back, after a generation that produced nothing.
 *
 * The spend has to come first — the comment above says why — which means a
 * failure between the spend and the finished resume has already taken the
 * credit. Reserve, then release: the same shape as any other atomic hold.
 *
 * Capped at the monthly allowance so a refund can never hand out more than a
 * month is worth, whatever else has gone wrong. Only refund where nothing was
 * produced; a refund after a saved resume is a free generation.
 */
export async function refundCredit(userId: string): Promise<void> {
  await db
    .update(users)
    .set({ credits: sql`least(${users.credits} + 1, ${MONTHLY_CREDITS})` })
    .where(eq(users.id, userId));
}

// ── Profile ────────────────────────────────────────────────────────────────

export async function getProfile(userId: string) {
  const [row] = await db.select().from(profiles).where(eq(profiles.userId, userId)).limit(1);
  return row ?? null;
}

/**
 * Records that somebody has been through a section.
 *
 * Append-only within an import: confirming twice is the common case (Save, then
 * Continue) and must not produce two entries or a lost one.
 */
export async function confirmSection(userId: string, key: string) {
  const profile = await getProfile(userId);
  const current = ((profile?.confirmedSections as string[] | null) ?? []);
  if (current.includes(key)) return;
  await db
    .update(profiles)
    .set({ confirmedSections: [...current, key], updatedAt: new Date() })
    .where(eq(profiles.userId, userId));
}

export async function getProfileEntries(userId: string) {
  return db
    .select()
    .from(profileEntries)
    .where(eq(profileEntries.userId, userId))
    .orderBy(profileEntries.kind, profileEntries.orderIndex);
}

/**
 * Records what the account already tells us, so the interview never asks for it.
 *
 * Someone who signed in with Google has handed over their name and email
 * already. Opening a conversation by asking for either is the fastest way to
 * signal that nothing is being paid attention to — and it violates the one rule
 * the interview leans on hardest, on its very first question.
 *
 * Written once, at account creation. Anything the person later corrects
 * supersedes these rather than colliding with them.
 *
 * **Idempotent for real, by asking.** It used to lean on `onConflictDoNothing`,
 * which guarded nothing at all: the conflict target is the primary key and
 * `newId('fact')` mints a new one every call, so a second call inserted a
 * SECOND `Name:` fact rather than doing nothing. That was survivable only
 * because exactly one caller existed and it ran once, inside the branch that
 * creates the user row. It is called from the Clerk webhook now too, and Clerk
 * retries deliveries.
 *
 * Existing labels are left alone rather than updated. A name changed in Clerk
 * is not a licence to rewrite the name on somebody's resume.
 */
export async function seedIdentityFacts(userId: string, name: string | null, email: string | null) {
  const already = await db
    .select({ text: facts.text })
    .from(facts)
    .where(and(eq(facts.userId, userId), eq(facts.category, 'identity')));
  const has = (label: string) => already.some((f) => f.text.startsWith(`${label}: `));

  const rows: (typeof facts.$inferInsert)[] = [];
  if (name?.trim() && !has('Name')) {
    rows.push({
      id: newId('fact'), userId, entryId: null,
      category: 'identity', text: `Name: ${name.trim()}`,
      hasNumber: false, confidence: 1, source: 'manual', sourceTurnId: null,
    });
  }
  if (email?.trim() && !has('Email')) {
    rows.push({
      id: newId('fact'), userId, entryId: null,
      category: 'identity', text: `Email: ${email.trim()}`,
      hasNumber: false, confidence: 1, source: 'manual', sourceTurnId: null,
    });
  }
  if (rows.length) await db.insert(facts).values(rows);
}

/**
 * Saves the contact block someone filled in during onboarding.
 *
 * Stored as identity facts rather than columns so composing reads them the same
 * way it reads everything else — one path from "something the person told us"
 * to "a line on the resume", with no second mechanism to keep in step.
 *
 * Replaces rather than appends: this is a form someone can come back and
 * correct, and two conflicting phone numbers is worse than none.
 */
export async function saveContactDetails(
  userId: string,
  details: { label: string; value: string }[],
) {
  await db.transaction(async (tx) => {
    // Same reasoning as skills below: the form holds the whole set, so a
    // source-scoped delete would leave older copies to be rendered alongside.
    await tx
      .delete(facts)
      .where(and(eq(facts.userId, userId), eq(facts.category, 'identity')));

    const rows = details
      .filter((d) => d.value.trim())
      .map((d) => ({
        id: newId('fact'),
        userId,
        entryId: null,
        category: 'identity',
        text: `${d.label}: ${d.value.trim()}`,
        hasNumber: false,
        confidence: 1,
        source: 'manual' as const,
        sourceTurnId: null,
      }));

    if (rows.length) await tx.insert(facts).values(rows);

    // The resume no longer reflects what we know about them.
    await tx.update(profiles).set({ stale: true }).where(eq(profiles.userId, userId));
  });
}

/** How much the profile knows, for the reassurance line before tailoring. */
export async function countFacts(userId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(facts)
    .where(and(eq(facts.userId, userId), eq(facts.status, 'active')));
  return row?.n ?? 0;
}

export async function getActiveFacts(userId: string) {
  return db
    .select()
    .from(facts)
    .where(and(eq(facts.userId, userId), eq(facts.status, 'active')));
}

/**
 * What somebody has told us that is not on their resume.
 *
 * Everything except identity and skills — those two already reach the page
 * through buildResume, and these do not reach it at all. They are the answers
 * to the strengthen questions: an achievement, a number, the size of a team.
 *
 * Handed to the tailor as extra source material rather than written into the
 * entries. The entries are what the person typed and a model does not get to
 * edit them; but an answer given once should keep paying out on every job after
 * it, which is exactly what the panel that collects them promises.
 */
export async function getSupportingFacts(userId: string) {
  return db
    .select({ category: facts.category, text: facts.text, entryId: facts.entryId })
    .from(facts)
    .where(
      and(
        eq(facts.userId, userId),
        eq(facts.status, 'active'),
        notInArray(facts.category, ['identity', 'skill']),
      ),
    )
    .limit(80);
}

/**
 * Saves the composed resume and clears the stale flag.
 *
 * `stale` is set again whenever a fact changes, so the profile page can offer a
 * rebuild rather than quietly showing a resume that no longer matches what the
 * person has told us.
 */
export async function saveComposedProfile(
  userId: string,
  resumeStructure: unknown,
  bulletSources: unknown,
  strength: number,
) {
  await db
    .insert(profiles)
    .values({
      id: newId('prof'),
      userId,
      resumeStructure: resumeStructure as object,
      bulletSources: bulletSources as object,
      strength,
      composedAt: new Date(),
      stale: false,
    })
    .onConflictDoUpdate({
      target: profiles.userId,
      set: {
        resumeStructure: resumeStructure as object,
        bulletSources: bulletSources as object,
        strength,
        composedAt: new Date(),
        stale: false,
        updatedAt: new Date(),
      },
    });
}

/**
 * Replaces the profile with one read out of an uploaded resume.
 *
 * The entries become real rows, not just JSON inside the profile, because the
 * questions later need something to attach facts to — that is what lets an
 * uploaded resume be topped up rather than merely stored.
 *
 * A transaction: a half-written profile with no entries would show someone a
 * resume the rest of the app cannot reason about.
 */
export async function replaceProfileFromResume(
  userId: string,
  structure: ResumeStructure,
  strength: number,
  fileName: string,
) {
  await db.transaction(async (tx) => {
    await tx.delete(profileEntries).where(
      and(eq(profileEntries.userId, userId), eq(profileEntries.source, 'resume_import')),
    );

    // Bullets, skills and contact details used to be dropped on the floor here.
    //
    // Only headings were written — a title, an organisation, a date string —
    // while the lines under each job, the skills and the phone number stayed in
    // the structure blob and never became rows. Since /setup reads rows, an
    // uploaded resume produced a setup screen listing job titles with nothing
    // beneath them, an empty Contact and an empty Skills, which is what a new
    // user sees as "it did not import anything".
    //
    // Worse than empty: the preview rendered from the blob and looked complete,
    // so nothing seemed wrong until the first save rebuilt the resume from
    // these rows and the bullets disappeared for good.
    //
    // The mapping lives in lib/importRows.ts, pure and tested, because dropping
    // a column here is invisible until somebody's resume comes back thinner
    // than the file they uploaded.
    const sections = structure.sections ?? [];
    const rows = entriesFromStructure(structure, sections).map((e) => ({
      id: newId('entry'),
      userId,
      source: 'resume_import',
      ...e,
    }));
    if (rows.length) await tx.insert(profileEntries).values(rows);

    // The sections themselves, so the arrangement survives the first save.
    //
    // This is the half that had nowhere to go. The extractor pulled a summary
    // out of an uploaded resume and it went into the blob below, where the next
    // rebuild — any save, or the polish that runs before the first tailor —
    // overwrote it, because the rebuild reads rows and no row held a summary.
    await tx.delete(profileSections).where(eq(profileSections.userId, userId));
    const sectionRowsToWrite = sectionRows(userId, sections);
    if (sectionRowsToWrite.length) await tx.insert(profileSections).values(sectionRowsToWrite);

    // Skills and contact are facts, not entries, and neither was ever written.
    // Replaced wholesale rather than scoped by source, matching what
    // saveSkillGroups and saveContactDetails do — the imported file is the
    // complete set, so anything left behind would render as a duplicate.
    await tx.delete(facts).where(
      and(eq(facts.userId, userId), inArray(facts.category, ['skill', 'identity'])),
    );

    const factRows = factsFromStructure(structure).map((f) => ({
      id: newId('fact'),
      userId,
      entryId: null,
      category: f.category,
      text: f.text,
      hasNumber: false,
      confidence: 1,
      source: 'resume_import',
      sourceTurnId: null,
    }));
    if (factRows.length) await tx.insert(facts).values(factRows);

    await tx
      .insert(profiles)
      .values({
        id: newId('prof'), userId,
        resumeStructure: structure as object,
        bulletSources: [],
        strength,
        composedAt: new Date(),
        // Nothing here has been read yet — see profiles.confirmedSections.
        confirmedSections: [],
        // Stale on purpose. The rows above are now the source of truth and the
        // resume renders from them, so claiming a finished editorial pass over
        // a file we have just read would be a lie — and it would stop the one
        // pass that would tidy the import from ever running.
        stale: true,
      })
      .onConflictDoUpdate({
        target: profiles.userId,
        set: {
          resumeStructure: structure as object,
          strength,
          composedAt: new Date(),
          stale: true,
          // Emptied, not kept: these are somebody's confirmations of a resume
          // that has just been replaced.
          confirmedSections: [],
          // Whatever the last editorial pass overwrote, it overwrote on a
          // profile that no longer exists. Offering to restore it here would
          // put somebody's previous resume back over the one they just
          // uploaded.
          undoSnapshot: null,
          undoAt: null,
          updatedAt: new Date(),
        },
      });

    await tx.insert(documents).values({
      id: newId('doc'), userId, kind: 'source_resume',
      fileName, mimeType: 'application/pdf', sizeBytes: 0,
      storagePath: '(not retained)', extractedAt: new Date(),
    });
  });
}

/**
 * This person's sections, in the order they print.
 *
 * Empty for almost everybody, and that is the designed state rather than a
 * migration that has not run: no rows means the conventional set, which is what
 * the renderer already falls back to. Rows appear when an upload writes them,
 * when polish reorders them, or when somebody edits one.
 */
export async function listSections(userId: string): Promise<ResumeSection[]> {
  const rows = await db
    .select()
    .from(profileSections)
    .where(eq(profileSections.userId, userId))
    .orderBy(profileSections.orderIndex);
  return rows.map(sectionFromRow);
}

/**
 * Replaces the whole set, in the order given.
 *
 * Wholesale rather than merged, because the caller always holds the complete
 * plan — an upload has just read the file, polish has just decided the order —
 * and a section left behind would print twice or print in the wrong place.
 *
 * Order is the array's, not the caller's arithmetic. Passing an index around
 * separately is how two sections end up sharing position 3.
 */
export async function saveSections(userId: string, sections: ResumeSection[]) {
  await db.transaction(async (tx) => {
    await tx.delete(profileSections).where(eq(profileSections.userId, userId));
    const rows = sectionRows(userId, sections);
    if (rows.length) await tx.insert(profileSections).values(rows);
  });
}

/**
 * A section and everything filed under it, in one transaction.
 *
 * Separate from saveSections because the two deletes must succeed or fail
 * together: the plan without the section, and the entries the section held.
 * Either alone leaves the profile describing something that is not there.
 */
export async function removeSectionAndEntries(
  userId: string,
  key: string,
  remaining: ResumeSection[],
): Promise<ProfileEntryRow[]> {
  // Full rows rather than a count, because a count cannot be undone. It also
  // cannot be a single row and a single section: this rewrites the WHOLE plan,
  // minting fresh ids for the survivors, so putting the section back means
  // writing the previous plan again — which the caller holds — alongside these.
  let removed: ProfileEntryRow[] = [];
  await db.transaction(async (tx) => {
    removed = await tx
      .delete(profileEntries)
      .where(and(eq(profileEntries.userId, userId), eq(profileEntries.kind, key)))
      .returning();

    await tx.delete(profileSections).where(eq(profileSections.userId, userId));
    const rows = sectionRows(userId, remaining);
    if (rows.length) await tx.insert(profileSections).values(rows);
  });
  return removed;
}

/**
 * Sections for a profile that predates them, derived from what it already has.
 *
 * Called only when there are no rows. A profile imported before this table
 * existed keeps its summary, certifications and awards in
 * `profiles.resume_structure` with nothing behind them — and that blob is
 * DERIVED, rebuilt from rows after every save, so the first edit deletes them.
 * That is the exact loss this feature fixes, and without this it is fixed for
 * new uploads only: everyone already using the app would lose their summary the
 * next time they saved anything.
 *
 * Returns [] when there is nothing worth keeping. No rows means the
 * conventional set, which for a profile with none of these is already right —
 * seeding it would be four rows saying what the fallback says for free.
 */
export async function ensureSections(userId: string): Promise<ResumeSection[]> {
  const profile = await getProfile(userId);
  const structure = profile?.resumeStructure as ResumeStructure | null;
  if (!structure) return [];

  const worthKeeping =
    Boolean(structure.summary?.trim()) ||
    (structure.certifications ?? []).some((c) => c?.trim()) ||
    (structure.awards ?? []).some((a) => a?.trim()) ||
    (structure.sections ?? []).length > 0;
  if (!worthKeeping) return [];

  // The order it was last given, by label, so a polished profile keeps the
  // arrangement somebody already saw rather than reverting to the conventional
  // one. No extras: a section outside the seven was never stored, so there is
  // nothing to recover — those are gone and only a re-upload brings them back.
  const seeded = sectionsFromStructure(structure, [], (structure.sections ?? []).map((s) => s.label));
  if (!seeded.length) return [];

  await saveSections(userId, seeded);
  return seeded;
}

/**
 * The same spelling fixes, applied to content that lives on the section itself.
 *
 * Entries are rows and `applyCorrectionsToEntries` already reaches every one of
 * them. A summary's paragraph, a certifications list and a language's level are
 * not rows — they are jsonb on the section — so a correction found in them had
 * nowhere to land. Proofreading text that cannot then be corrected is worse
 * than not reading it: the pass reports a fix on screen that never happened.
 */
export async function applyCorrectionsToSections(
  userId: string,
  corrections: { from: string; to: string }[],
): Promise<number> {
  if (!corrections.length) return 0;

  const rows = await db.select().from(profileSections).where(eq(profileSections.userId, userId));

  // Escaped because a correction is text somebody typed, not a pattern we
  // wrote, and whole-word so "SQL" never rewrites the middle of "PostgreSQL".
  const patterns = corrections.map((c) => ({
    pattern: new RegExp(`\\b${c.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'),
    to: c.to,
  }));
  const fix = (text: string) => patterns.reduce((acc, p) => acc.replace(p.pattern, p.to), text);

  let changed = 0;
  for (const row of rows) {
    const content = (row.content ?? {}) as {
      text?: string;
      items?: string[];
      groups?: { category: string; items: string }[];
    };
    const next: typeof content = {};
    if (typeof content.text === 'string') next.text = fix(content.text);
    if (Array.isArray(content.items)) next.items = content.items.map((i) => (typeof i === 'string' ? fix(i) : i));
    if (Array.isArray(content.groups)) {
      next.groups = content.groups.map((g) => ({ category: fix(g?.category ?? ''), items: fix(g?.items ?? '') }));
    }

    // The label too: it is on the page in capitals at the top of the section.
    const label = fix(row.label);

    if (JSON.stringify(next) === JSON.stringify(content) && label === row.label) continue;
    await db
      .update(profileSections)
      .set({ content: next, label, updatedAt: new Date() })
      .where(and(eq(profileSections.userId, userId), eq(profileSections.id, row.id)));
    changed += 1;
  }
  return changed;
}

/**
 * Rewrites one section's content, leaving its name and position alone.
 *
 * Merged into whatever is there rather than replacing the row, so editing a
 * summary cannot silently reset the order somebody's resume was imported with.
 * Updates nothing if the section is not theirs, which is the same protection
 * upsertEntry gets from carrying the userId in its where clause.
 */
export async function updateSectionContent(
  userId: string,
  key: string,
  content: Record<string, unknown>,
) {
  await db
    .update(profileSections)
    .set({ content, updatedAt: new Date() })
    .where(and(eq(profileSections.userId, userId), eq(profileSections.key, key)));
}

function sectionRows(userId: string, sections: ResumeSection[]) {
  const seen = new Set<string>();
  return sections
    .filter((s) => {
      const key = s?.key?.trim();
      // The unique index would reject a duplicate and take the whole
      // transaction with it, which on the import path means losing the resume.
      if (!key || !s.label?.trim() || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((s, i) => ({
      id: newId('sect'),
      userId,
      key: s.key.trim(),
      label: s.label.trim(),
      shape: shapeOf(s),
      content: contentOf(s),
      orderIndex: i,
    }));
}

/**
 * The whole profile as it stands, kept so one editorial pass can be taken back.
 *
 * Polish writes across `profile_entries`, `facts` and `profile_sections` at
 * once, and there is no row to put back afterwards. Reversing its corrections
 * is not an option either: applying them backwards would turn EVERY
 * "stand-ups" into "standups", including the ones somebody wrote correctly
 * themselves. So the state goes in whole and comes back whole.
 */
interface PolishSnapshot {
  entries: ProfileEntryRow[];
  facts: FactRow[];
  sections: ProfileSectionRow[];
  /** The three fields the pass writes on `profiles` itself. */
  profile: { resumeStructure: unknown; strength: number; stale: boolean };
}

/**
 * Taken immediately before the pass applies anything, never before the model
 * calls — a pass that fails on the call has changed nothing and should leave no
 * snapshot behind claiming otherwise.
 */
export async function snapshotForPolish(userId: string): Promise<void> {
  const [entryRows, factRows, sectionRowsRead, profile] = await Promise.all([
    db.select().from(profileEntries).where(eq(profileEntries.userId, userId)),
    db.select().from(facts).where(eq(facts.userId, userId)),
    db.select().from(profileSections).where(eq(profileSections.userId, userId)),
    getProfile(userId),
  ]);

  const snapshot: PolishSnapshot = {
    entries: entryRows,
    facts: factRows,
    sections: sectionRowsRead,
    profile: {
      resumeStructure: profile?.resumeStructure ?? {},
      strength: profile?.strength ?? 0,
      stale: profile?.stale ?? true,
    },
  };

  await db
    .update(profiles)
    .set({ undoSnapshot: snapshot, undoAt: new Date() })
    .where(eq(profiles.userId, userId));
}

/**
 * Puts all of it back, and returns false when there is nothing to put back.
 *
 * `stale` is restored along with the rest, and that is not a detail: the resume
 * was stale before the pass ran, and coming back from an undo still claiming to
 * be polished would stop the next pass ever running.
 *
 * Facts are deleted before entries because they reference them. The other order
 * is a foreign-key violation that takes the whole transaction with it.
 */
export async function restoreFromPolishSnapshot(userId: string): Promise<boolean> {
  const profile = await getProfile(userId);
  const snapshot = profile?.undoSnapshot as PolishSnapshot | null;
  if (!snapshot || !profile?.undoAt) return false;

  await db.transaction(async (tx) => {
    await tx.delete(facts).where(eq(facts.userId, userId));
    await tx.delete(profileEntries).where(eq(profileEntries.userId, userId));
    await tx.delete(profileSections).where(eq(profileSections.userId, userId));

    if (snapshot.entries?.length) {
      await tx.insert(profileEntries).values(snapshot.entries.map((r) => entryValues(userId, r)));
    }
    if (snapshot.facts?.length) {
      await tx.insert(facts).values(snapshot.facts.map((r) => factValues(userId, r)));
    }
    if (snapshot.sections?.length) {
      await tx.insert(profileSections).values(snapshot.sections.map((r) => sectionValues(userId, r)));
    }

    await tx
      .update(profiles)
      .set({
        resumeStructure: snapshot.profile?.resumeStructure ?? {},
        strength: snapshot.profile?.strength ?? 0,
        stale: snapshot.profile?.stale ?? true,
        // Spent. A snapshot left behind would let the same pass be undone twice,
        // the second time over whatever came after it.
        undoSnapshot: null,
        undoAt: null,
      })
      .where(eq(profiles.userId, userId));
  });

  return true;
}

/**
 * Throws the snapshot away.
 *
 * Called after every save, and this is the part that would otherwise cause real
 * damage: polish, edit five entries, then undo, and without this the five edits
 * go with it. The snapshot is honest from the pass until the next thing the
 * person changes, and not one moment longer.
 */
export async function clearPolishSnapshot(userId: string): Promise<void> {
  await db
    .update(profiles)
    .set({ undoSnapshot: null, undoAt: null })
    .where(and(eq(profiles.userId, userId), isNotNull(profiles.undoAt)));
}

/** Column by column, and the timestamps re-made — see entryValues. */
function factValues(userId: string, row: FactRow) {
  return {
    id: row.id,
    userId,
    entryId: row.entryId,
    category: row.category,
    text: row.text,
    hasNumber: row.hasNumber,
    confidence: row.confidence,
    source: row.source,
    sourceTurnId: row.sourceTurnId,
    status: row.status,
    createdAt: toDate(row.createdAt) ?? new Date(),
  };
}

function sectionValues(userId: string, row: ProfileSectionRow) {
  return {
    id: row.id,
    userId,
    key: row.key,
    label: row.label,
    shape: row.shape,
    content: row.content,
    orderIndex: row.orderIndex,
    createdAt: toDate(row.createdAt) ?? new Date(),
    updatedAt: toDate(row.updatedAt) ?? new Date(),
  };
}

/**
 * Says the resume no longer matches the rows behind it.
 *
 * Also throws away the polish snapshot, in the same statement. Somebody has
 * changed something, which is exactly the moment the copy taken before the last
 * pass stops being safe to apply: restoring it now would take the change with
 * it. Erring towards clearing is deliberate — clearing too eagerly costs an
 * undo, and clearing too late destroys work.
 *
 * **The editorial pass must never route through here.** It writes across the
 * same tables straight after taking its snapshot, and calling this from inside
 * it would delete the snapshot it had just taken — leaving a pass that reports
 * an undo it cannot perform. Nothing on that path does today: it goes through
 * applyCorrections*, saveSkillGroups, saveSections and saveMasterResume, none
 * of which touch this.
 */
export async function markProfileStale(userId: string) {
  await db
    .update(profiles)
    .set({ stale: true, undoSnapshot: null, undoAt: null })
    .where(eq(profiles.userId, userId));
}

// ── Rules ──────────────────────────────────────────────────────────────────

/**
 * Every rule, including the switched-off ones.
 *
 * The page needs those: turning a rule off is how someone parks it without
 * losing the wording they worked out, and a rule that vanished when disabled
 * would make the toggle indistinguishable from delete.
 */
export async function listRules(userId: string) {
  return db.select().from(rules).where(eq(rules.userId, userId)).orderBy(rules.orderIndex);
}

export async function createRule(userId: string, text: string): Promise<string> {
  // New rules go last: order carries meaning once the prompt reads them in
  // sequence, and inserting at the top would silently reprioritise the others.
  const [last] = await db
    .select({ orderIndex: rules.orderIndex })
    .from(rules)
    .where(eq(rules.userId, userId))
    .orderBy(desc(rules.orderIndex))
    .limit(1);

  const [row] = await db
    .insert(rules)
    .values({
      id: newId('rule'),
      userId,
      text: text.trim(),
      orderIndex: (last?.orderIndex ?? -1) + 1,
    })
    .returning({ id: rules.id });
  return row.id;
}

export async function updateRule(userId: string, ruleId: string, text: string) {
  await db
    .update(rules)
    // The check goes with the text it was derived from. Left behind, it would
    // keep enforcing the sentence somebody just replaced — a rule reading
    // "never say utilised" still failing resumes over "spearheaded".
    .set({ text: text.trim(), check: null, updatedAt: new Date() })
    .where(and(eq(rules.userId, userId), eq(rules.id, ruleId)));
}

/**
 * Stores the app's reading of a rule. Null clears it.
 *
 * Separate from updateRule because they happen at different moments: the rule is
 * written and saved at once, and the reading arrives a few seconds later. A
 * model outage must never stop somebody writing down a preference.
 */
export async function setRuleCheck(userId: string, ruleId: string, check: unknown) {
  await db
    .update(rules)
    .set({ check: check ?? null, updatedAt: new Date() })
    .where(and(eq(rules.userId, userId), eq(rules.id, ruleId)));
}

export async function setRuleActive(userId: string, ruleId: string, active: boolean) {
  await db
    .update(rules)
    .set({ active, updatedAt: new Date() })
    .where(and(eq(rules.userId, userId), eq(rules.id, ruleId)));
}

export async function deleteRule(userId: string, ruleId: string): Promise<RuleRow | null> {
  const [row] = await db
    .delete(rules)
    .where(and(eq(rules.userId, userId), eq(rules.id, ruleId)))
    .returning();
  return row ?? null;
}

/**
 * Puts a deleted rule back where it was in the order.
 *
 * `createRule` appends, which for a rule is not a detail: the prompt reads them
 * in sequence, so restoring one to the bottom silently reprioritises the rest.
 * The row already carries its `orderIndex`, so it goes back into its own place.
 */
export async function restoreRule(userId: string, row: RuleRow): Promise<boolean> {
  const inserted = await db
    .insert(rules)
    .values({
      id: row.id,
      userId,
      text: row.text,
      active: row.active,
      orderIndex: row.orderIndex,
      source: row.source,
      createdAt: toDate(row.createdAt) ?? new Date(),
      updatedAt: toDate(row.updatedAt) ?? new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: rules.id });
  return inserted.length > 0;
}

/**
 * Writes a new order for the ids given.
 *
 * Every statement carries the userId, so an id belonging to someone else
 * updates nothing rather than reordering their rules.
 */
export async function reorderRules(userId: string, orderedIds: string[]) {
  await Promise.all(
    orderedIds.map((ruleId, index) =>
      db
        .update(rules)
        .set({ orderIndex: index, updatedAt: new Date() })
        .where(and(eq(rules.userId, userId), eq(rules.id, ruleId))),
    ),
  );
}

export async function getActiveRules(userId: string) {
  return db
    .select()
    .from(rules)
    .where(and(eq(rules.userId, userId), eq(rules.active, true)))
    .orderBy(rules.orderIndex);
}

// ── The setup form ─────────────────────────────────────────────────────────

/**
 * Everything the form edits: entries with their own bullets, plus the identity
 * and skill facts that make up the contact block and skills section.
 */
export async function getResumeInputs(userId: string) {
  const [entryRows, factRows, sectionRowsRead] = await Promise.all([
    db
      .select()
      .from(profileEntries)
      .where(eq(profileEntries.userId, userId))
      .orderBy(profileEntries.kind, profileEntries.orderIndex),
    db
      .select({ category: facts.category, text: facts.text })
      .from(facts)
      .where(and(eq(facts.userId, userId), eq(facts.status, 'active'))),
    // Read here rather than by a second call from every caller. This is the one
    // "everything the resume is made of" query, and a caller that forgot the
    // third piece would rebuild somebody's resume without their sections and
    // save the result — which is the exact shape of the bug this feature fixes.
    db
      .select()
      .from(profileSections)
      .where(eq(profileSections.userId, userId))
      .orderBy(profileSections.orderIndex),
  ]);
  return { entryRows, factRows, sections: sectionRowsRead.map(sectionFromRow) };
}

/**
 * Adds or updates one entry.
 *
 * The id comes from the client, which means it is a request to edit something
 * rather than proof of owning it — the where clause carries the userId, so a
 * borrowed id updates nothing rather than someone else's history.
 */
export async function upsertEntry(
  userId: string,
  entry: {
    id: string | null;
    kind: string;
    title: string;
    org: string;
    location: string;
    datesDisplay: string;
    tech: string;
    bullets: string[];
    dates: {
      startMonth: number | null; startYear: number | null;
      endMonth: number | null; endYear: number | null; isCurrent: boolean;
    };
    place: { city: string | null; region: string | null; country: string | null };
    url: string;
    extra: Record<string, string>;
  },
): Promise<string> {
  const bullets = entry.bullets.map((b) => b.trim()).filter(Boolean);

  if (entry.id) {
    const [row] = await db
      .update(profileEntries)
      .set({
        title: entry.title, org: entry.org, location: entry.location,
        datesDisplay: entry.datesDisplay, tech: entry.tech, url: entry.url,
        city: entry.place.city, region: entry.place.region, country: entry.place.country,
        startMonth: entry.dates.startMonth, startYear: entry.dates.startYear,
        endMonth: entry.dates.endMonth, endYear: entry.dates.endYear,
        isCurrent: entry.dates.isCurrent,
        extra: entry.extra,
        bullets, updatedAt: new Date(),
      })
      .where(and(eq(profileEntries.userId, userId), eq(profileEntries.id, entry.id)))
      .returning({ id: profileEntries.id });
    if (row) {
      await markProfileStale(userId);
      return row.id;
    }
    // Fell through: the id was not theirs. Treated as a new entry rather than
    // an error, so a stale tab cannot silently discard what someone just typed.
  }

  const [{ next }] = await db
    .select({ next: sql<number>`coalesce(max(${profileEntries.orderIndex}) + 1, 0)::int` })
    .from(profileEntries)
    .where(and(eq(profileEntries.userId, userId), eq(profileEntries.kind, entry.kind)));

  const id = newId('entry');
  await db.insert(profileEntries).values({
    id, userId, kind: entry.kind,
    title: entry.title, org: entry.org, location: entry.location,
    datesDisplay: entry.datesDisplay, tech: entry.tech, url: entry.url,
    city: entry.place.city, region: entry.place.region, country: entry.place.country,
    startMonth: entry.dates.startMonth, startYear: entry.dates.startYear,
    endMonth: entry.dates.endMonth, endYear: entry.dates.endYear,
    isCurrent: entry.dates.isCurrent,
    extra: entry.extra,
    bullets, orderIndex: next, source: 'manual',
  });
  await markProfileStale(userId);
  return id;
}

/**
 * Applies spelling corrections to the entries themselves.
 *
 * The correction has to land on the data, not on the rendered resume. Fixing
 * "San Fransisco" in the generated PDF leaves the Experience entry still
 * spelling it wrong, and the resume is rebuilt from those entries on the next
 * save — so the typo comes back, and it was never fixed anywhere it mattered.
 *
 * Whole words only. A substring replace would turn a correction of "ap" into
 * damage spread across every field that happens to contain those letters.
 *
 * Dates and urls are deliberately not included. A "correction" to a date is a
 * change of fact rather than of spelling, and a url looks misspelled to any
 * spellchecker — "fixing" github.com/chukwudican-sudo produces a dead link on
 * a resume, which is worse than the typo it was trying to solve.
 */
export async function applyCorrectionsToEntries(
  userId: string,
  corrections: { from: string; to: string }[],
): Promise<number> {
  if (!corrections.length) return 0;

  const rows = await db.select().from(profileEntries).where(eq(profileEntries.userId, userId));
  const fields = ['title', 'org', 'location', 'city', 'region', 'country', 'tech'] as const;

  // Built once rather than per field per row, and escaped because a correction
  // is text somebody typed, not a pattern we wrote.
  const patterns = corrections.map((c) => ({
    pattern: new RegExp(`\\b${c.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'),
    to: c.to,
  }));
  const fix = (text: string) => patterns.reduce((acc, p) => acc.replace(p.pattern, p.to), text);

  let changed = 0;

  for (const row of rows) {
    const patch: Record<string, unknown> = {};

    for (const field of fields) {
      const before = row[field];
      if (!before) continue;
      const after = fix(before);
      if (after !== before) patch[field] = after;
    }

    // Bullets too. This is where a typo actually lives — a misspelling in a
    // sentence someone wrote about their own work is far more likely than one
    // in a company name, and it is the more embarrassing of the two.
    const bullets = (row.bullets as string[] | null) ?? [];
    const fixedBullets = bullets.map(fix);
    if (fixedBullets.some((b, i) => b !== bullets[i])) patch.bullets = fixedBullets;

    // GPA, honours, the credential. Text somebody typed, so text that can be
    // misspelled.
    const extra = (row.extra as Record<string, string> | null) ?? null;
    if (extra) {
      const fixedExtra = Object.fromEntries(
        Object.entries(extra).map(([k, v]) => [k, typeof v === 'string' ? fix(v) : v]),
      );
      if (JSON.stringify(fixedExtra) !== JSON.stringify(extra)) patch.extra = fixedExtra;
    }

    if (Object.keys(patch).length) {
      await db
        .update(profileEntries)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(eq(profileEntries.userId, userId), eq(profileEntries.id, row.id)));
      changed += 1;
    }
  }

  return changed;
}

/**
 * The same corrections, applied to the skills.
 *
 * Skills are facts rather than entry columns, so they are not reached by the
 * loop above — which meant a misspelled skill was carried through the grouping
 * and printed exactly as typed.
 */
/**
 * Moves a job type out of a title and into the chip that owns it.
 *
 * People write "Operations & Client Engagement (Full-Time)" because a resume
 * has nowhere else to put it. Here there is somewhere else, so the title
 * becomes just the title and the chip carries the type — and the chip wins when
 * the two disagree, since it is the field that exists for the purpose.
 */
export async function normaliseEmploymentTitles(userId: string): Promise<number> {
  const rows = await db
    .select()
    .from(profileEntries)
    .where(and(eq(profileEntries.userId, userId), eq(profileEntries.kind, 'experience')));

  let changed = 0;
  for (const row of rows) {
    if (!row.title) continue;
    const { title, employment } = splitEmployment(row.title);
    if (title === row.title) continue;

    const extra = (row.extra as Record<string, string> | null) ?? {};
    await db
      .update(profileEntries)
      .set({
        title,
        // Only filled in when empty. A chip that was set deliberately is not
        // overruled by something typed into a title.
        extra: extra.employment ? extra : { ...extra, ...(employment ? { employment } : {}) },
        updatedAt: new Date(),
      })
      .where(and(eq(profileEntries.userId, userId), eq(profileEntries.id, row.id)));
    changed += 1;
  }
  return changed;
}

export async function applyCorrectionsToSkillFacts(
  userId: string,
  corrections: { from: string; to: string }[],
): Promise<number> {
  if (!corrections.length) return 0;

  const rows = await db
    .select({ id: facts.id, text: facts.text })
    .from(facts)
    .where(and(eq(facts.userId, userId), eq(facts.category, 'skill')));

  const patterns = corrections.map((c) => ({
    pattern: new RegExp(`\\b${c.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'),
    to: c.to,
  }));

  let changed = 0;
  for (const row of rows) {
    const after = patterns.reduce((acc, p) => acc.replace(p.pattern, p.to), row.text);
    if (after === row.text) continue;
    await db
      .update(facts)
      .set({ text: after })
      .where(and(eq(facts.userId, userId), eq(facts.id, row.id)));
    changed += 1;
  }
  return changed;
}

/**
 * Deletes an entry and hands back the row, so it can be offered back.
 *
 * The row is the whole point of the return value. Without it a mistaken delete
 * left nothing at all — working out which job had gone meant reading timestamps
 * in the database, and putting it back meant retyping it.
 */
export async function deleteEntry(
  userId: string,
  entryId: string,
): Promise<ProfileEntryRow | null> {
  const [row] = await db
    .delete(profileEntries)
    .where(and(eq(profileEntries.userId, userId), eq(profileEntries.id, entryId)))
    .returning();
  if (!row) return null;
  await markProfileStale(userId);
  return row;
}

/**
 * Puts deleted entries back exactly as they were.
 *
 * Deliberately not routed through `upsertEntry`, which is the obvious-looking
 * shortcut and the wrong one: that path mints a fresh id, forces
 * `source: 'manual'` and appends to the end of the section. An undone entry
 * would come back as a different thing, in a different place — the person
 * pressed Undo, so the correct outcome is the row that was there.
 *
 * `userId` is the server's, never the row's: these rows have been out to the
 * browser and back, so the id in one is a request rather than proof.
 *
 * onConflictDoNothing makes a second call harmless. A double-fired restore
 * would otherwise be a duplicate insert, and an id that belongs to somebody
 * else quietly does nothing instead of anything worse.
 */
export async function restoreEntries(userId: string, rows: ProfileEntryRow[]): Promise<number> {
  if (!rows.length) return 0;
  const inserted = await db
    .insert(profileEntries)
    .values(rows.map((row) => entryValues(userId, row)))
    .onConflictDoNothing()
    .returning({ id: profileEntries.id });
  if (inserted.length) await markProfileStale(userId);
  return inserted.length;
}

/**
 * The row, column by column.
 *
 * Spreading it would be shorter and wrong twice over: an extra key the client
 * invented becomes an unknown column and takes the insert down, and a timestamp
 * that arrived as a string rather than a Date is exactly the mismatch a type
 * annotation cannot catch — the type claims Date, the wire delivers a string.
 */
function entryValues(userId: string, row: ProfileEntryRow) {
  return {
    id: row.id,
    userId,
    kind: row.kind,
    title: row.title,
    org: row.org,
    city: row.city,
    region: row.region,
    country: row.country,
    location: row.location,
    startMonth: row.startMonth,
    startYear: row.startYear,
    endMonth: row.endMonth,
    endYear: row.endYear,
    isCurrent: row.isCurrent,
    datesDisplay: row.datesDisplay,
    url: row.url,
    extra: row.extra,
    orderIndex: row.orderIndex,
    bullets: row.bullets,
    tech: row.tech,
    source: row.source,
    createdAt: toDate(row.createdAt) ?? new Date(),
    updatedAt: toDate(row.updatedAt) ?? new Date(),
  };
}

/** Replaces the skills block. Grouped as `Category: items`. */
export async function saveSkillGroups(
  userId: string,
  groups: { category: string; items: string }[],
) {
  await db.transaction(async (tx) => {
    // Every skill fact goes, not only the ones this form wrote.
    //
    // Scoping the delete to source='manual' left the interview's copies behind,
    // so saving the form added a second copy of skills that were already there
    // and the resume printed each one twice. The form is shown every skill fact
    // regardless of origin, so what it saves is the complete set — anything
    // still in the table afterwards is a duplicate by definition.
    await tx
      .delete(facts)
      .where(and(eq(facts.userId, userId), eq(facts.category, 'skill')));

    const seen = new Set<string>();
    const rows = groups
      .filter((g) => {
        const key = `${g.category.trim()}|${g.items.trim()}`;
        if (!g.items.trim() || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((g) => ({
        id: newId('fact'), userId, entryId: null,
        category: 'skill', text: `${g.category.trim() || 'Skills'}: ${g.items.trim()}`,
        hasNumber: false, confidence: 1, source: 'manual' as const, sourceTurnId: null,
      }));

    if (rows.length) await tx.insert(facts).values(rows);
    await tx.update(profiles).set({ stale: true }).where(eq(profiles.userId, userId));
  });
}

/** Stores the deterministic render so other pages can read one shape. */
/**
 * Stores the rendered master resume.
 *
 * `stale` says whether the resume still needs the editorial pass, and the
 * caller has to say which it is. It used to be hardcoded false, which meant
 * saving an entry marked the resume as freshly polished — so editing your
 * resume declared it did not need polishing, and polish could never run at the
 * one moment it was needed. A typo typed into a bullet went straight through to
 * the PDF, and the flag said everything was fine.
 */
export async function saveMasterResume(
  userId: string,
  structure: unknown,
  strength: number,
  stale = true,
) {
  await db
    .insert(profiles)
    .values({
      id: newId('prof'), userId,
      resumeStructure: structure as object, bulletSources: [],
      strength, composedAt: new Date(), stale,
    })
    .onConflictDoUpdate({
      target: profiles.userId,
      set: {
        resumeStructure: structure as object,
        strength, composedAt: new Date(), stale, updatedAt: new Date(),
      },
    });
}

/** Records what someone said in answer to the job-specific questions. */
export async function addFactsFromAnswers(
  userId: string,
  rows: { entryId: string | null; category: string; text: string; hasNumber: boolean }[],
) {
  if (rows.length === 0) return;
  await db.insert(facts).values(
    rows.map((r) => ({
      id: newId('fact'), userId, entryId: r.entryId,
      category: r.category, text: r.text, hasNumber: r.hasNumber,
      confidence: 1, source: 'interview' as const, sourceTurnId: null,
    })),
  );

  // Every other fact writer in this file does this and this one did not, so an
  // answer given to the strengthen questions never triggered a rebuild — the
  // rows landed and the resume carried on as though nothing had been said.
  //
  // Through markProfileStale rather than its own update, so it also expires the
  // polish snapshot. Answering a strengthen question adds facts; undoing a
  // polish replaces every fact from the copy; the two together would delete the
  // answers somebody had just given.
  await markProfileStale(userId);
}

// ── Interview ──────────────────────────────────────────────────────────────

/** The live session, if there is one. At most one exists per person. */
export async function getActiveInterview(userId: string) {
  const [row] = await db
    .select()
    .from(interviewSessions)
    .where(and(eq(interviewSessions.userId, userId), inArray(interviewSessions.status, ['active', 'paused'])))
    .limit(1);
  return row ?? null;
}

export async function getInterviewTurns(sessionId: string) {
  return db
    .select()
    .from(interviewTurns)
    .where(eq(interviewTurns.sessionId, sessionId))
    .orderBy(interviewTurns.idx);
}

/**
 * Starts an interview, or returns the one already running.
 *
 * The check-then-insert is not enough on its own: two requests can both find no
 * session and both try to create one — which React's development double-invoke
 * makes reliable rather than rare. The partial unique index is what actually
 * enforces "one live interview per person", so the conflict is expected and the
 * loser simply reads back the winner's row.
 */
export async function startInterview(userId: string, openQuestions: string[] = []) {
  const existing = await getActiveInterview(userId);
  if (existing) return existing;

  const [row] = await db
    .insert(interviewSessions)
    .values({ id: newId('sess'), userId, openQuestions })
    .onConflictDoNothing()
    .returning();

  return row ?? (await getActiveInterview(userId));
}

/**
 * Records one completed turn and everything it produced, in a transaction.
 *
 * All of it or none: a turn whose facts were saved but whose question was not
 * would ask the same thing again on the next load, and one whose question was
 * saved without its facts would silently lose what the person just said.
 */
export async function saveInterviewTurn(
  userId: string,
  sessionId: string,
  turn: {
    idx: number;
    question: unknown;
    rawAnswer: string;
    skipped: boolean;
  } | null,
  newEntries: { id: string; kind: string; title?: string; org?: string; location?: string; datesDisplay?: string; orderIndex: number }[],
  newFacts: { id: string; entryId: string | null; category: string; text: string; hasNumber: boolean; confidence: number; sourceTurnId: string | null }[],
  session: { phase: string; phaseStartedAtTurn: number; pendingQuestion: unknown; finished: boolean },
) {
  await db.transaction(async (tx) => {
    if (turn) {
      await tx
        .insert(interviewTurns)
        .values({
          id: newId('turn'),
          sessionId,
          idx: turn.idx,
          question: turn.question as object,
          rawAnswer: turn.rawAnswer,
          skipped: turn.skipped,
        })
        // The unique (session, idx) index makes a double-submit a no-op rather
        // than a duplicated turn.
        .onConflictDoNothing();
    }

    if (newEntries.length) {
      await tx.insert(profileEntries).values(
        newEntries.map((e) => ({
          id: e.id, userId, kind: e.kind,
          title: e.title, org: e.org, location: e.location, datesDisplay: e.datesDisplay,
          orderIndex: e.orderIndex, source: 'interview' as const,
        })),
      );
    }

    if (newFacts.length) {
      await tx.insert(facts).values(
        newFacts.map((f) => ({
          id: f.id, userId, entryId: f.entryId,
          category: f.category, text: f.text,
          hasNumber: f.hasNumber, confidence: f.confidence,
          source: 'interview' as const, sourceTurnId: f.sourceTurnId,
        })),
      );

      // Undoing a polish puts every fact back from the copy, so a copy older
      // than these answers would delete them. Only the snapshot goes — `stale`
      // is left alone, because whether an interview should trigger a rebuild is
      // a separate question this is not the place to answer.
      await tx
        .update(profiles)
        .set({ undoSnapshot: null, undoAt: null })
        .where(eq(profiles.userId, userId));
    }

    await tx
      .update(interviewSessions)
      .set({
        phase: session.phase,
        phaseStartedAtTurn: session.phaseStartedAtTurn,
        pendingQuestion: session.pendingQuestion as object,
        turnCount: turn ? turn.idx + 1 : 0,
        status: session.finished ? 'completed' : 'active',
        completedAt: session.finished ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(interviewSessions.id, sessionId));

    // Anything new the person said makes the composed resume out of date.
    await tx.update(profiles).set({ stale: true }).where(eq(profiles.userId, userId));
  });
}

// ── Applications ───────────────────────────────────────────────────────────

/** The applications list, newest first, with its posting joined in. */
export async function listApplications(userId: string) {
  return db
    .select({
      application: applications,
      posting: jobPostings,
    })
    .from(applications)
    .leftJoin(jobPostings, eq(applications.postingId, jobPostings.id))
    .where(and(eq(applications.userId, userId), isNull(applications.deletedAt)))
    .orderBy(desc(applications.updatedAt));
}

export async function getApplication(userId: string, applicationId: string) {
  const [row] = await db
    .select({ application: applications, posting: jobPostings })
    .from(applications)
    .leftJoin(jobPostings, eq(applications.postingId, jobPostings.id))
    .where(
      and(eq(applications.userId, userId), eq(applications.id, applicationId), isNull(applications.deletedAt)),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Takes an application out of the list, keeping everything it holds.
 *
 * Soft, because undo has to be able to hand the whole thing back — the posting
 * copy, every resume version, the status and its dates — and because the form
 * that takes a posting promises to keep it for exactly the moment you need it
 * again. See the note on `applications.deletedAt`.
 */
export async function deleteApplication(userId: string, applicationId: string) {
  const now = new Date();
  const [row] = await db
    .update(applications)
    .set({ deletedAt: now, updatedAt: now })
    .where(
      and(eq(applications.userId, userId), eq(applications.id, applicationId), isNull(applications.deletedAt)),
    )
    .returning({ id: applications.id });
  // Null when it was already gone, so a double-press cannot offer an undo for
  // something this call did not do.
  return row?.id ?? null;
}

/**
 * Puts one back.
 *
 * The one write that deliberately ignores `deletedAt` — everything else in this
 * file filters on it, which is what makes this function the only way back.
 */
export async function restoreApplication(userId: string, applicationId: string) {
  await db
    .update(applications)
    .set({ deletedAt: null, updatedAt: new Date() })
    .where(and(eq(applications.userId, userId), eq(applications.id, applicationId)));
}

/**
 * Marks an application sent and starts the follow-up clock.
 *
 * Seven days is the point at which a follow-up is normal rather than pushy,
 * and applications mostly die of silence rather than rejection.
 */
/**
 * Moves an application to wherever it now stands.
 *
 * The six states have existed since the schema was written and only one of them
 * was reachable, so `nextAction` — which knows what to say about an interview,
 * an offer and a rejection — could never run past "applied".
 *
 * The dates move with the status rather than being set once. Reaching "applied"
 * starts the follow-up clock; passing it clears the clock, because chasing a
 * company that has already replied is the wrong advice. Going back to draft
 * clears both, so a mistake leaves nothing behind.
 */
export async function setApplicationStatus(
  userId: string,
  applicationId: string,
  status: string,
  followUpDays = 7,
): Promise<void> {
  const now = new Date();

  const dates =
    status === 'applied'
      ? { appliedAt: now, followUpDueAt: new Date(now.getTime() + followUpDays * 86_400_000) }
      : status === 'draft'
        ? { appliedAt: null, followUpDueAt: null }
        // Interviewing, offer, rejected, withdrawn: they have replied, or it is
        // over. Either way there is nothing left to chase.
        : { followUpDueAt: null };

  await db
    .update(applications)
    .set({ status, ...dates, updatedAt: now })
    .where(and(eq(applications.userId, userId), eq(applications.id, applicationId)));
}

export async function markApplied(userId: string, applicationId: string, followUpDays = 7) {
  const now = new Date();
  const due = new Date(now.getTime() + followUpDays * 24 * 60 * 60 * 1000);
  await db
    .update(applications)
    .set({ status: 'applied', appliedAt: now, followUpDueAt: due, updatedAt: now })
    .where(and(eq(applications.userId, userId), eq(applications.id, applicationId)));
}

/** Applications whose follow-up is due and which have not moved on. */
export async function getDueFollowUps(userId: string) {
  return db
    .select({ application: applications, posting: jobPostings })
    .from(applications)
    .leftJoin(jobPostings, eq(applications.postingId, jobPostings.id))
    .where(
      and(
        eq(applications.userId, userId),
        isNull(applications.deletedAt),
        eq(applications.status, 'applied'),
        isNotNull(applications.followUpDueAt),
        lte(applications.followUpDueAt, new Date()),
      ),
    );
}

/**
 * Saves a posting and opens an application against it, together.
 *
 * One transaction: an application pointing at a posting that failed to save
 * would show as a row with no job attached, which is worse than not creating it.
 */
export async function createApplication(
  userId: string,
  posting: {
    company: string | null;
    role: string | null;
    location: string | null;
    description: string | null;
    sourceUrl: string | null;
    requirements: string[];
  },
): Promise<string> {
  const postingId = newId('post');
  const applicationId = newId('app');

  await db.transaction(async (tx) => {
    await tx.insert(jobPostings).values({
      id: postingId,
      userId,
      company: posting.company,
      role: posting.role,
      location: posting.location,
      description: posting.description,
      sourceUrl: posting.sourceUrl,
      requirements: posting.requirements,
    });
    await tx.insert(applications).values({
      id: applicationId,
      userId,
      postingId,
      status: 'draft',
    });
  });

  return applicationId;
}

/**
 * The applications list with everything the page needs, in one query.
 *
 * The match score comes from the newest resume for each application, pulled in
 * a lateral join rather than a second round trip per row — a job search is
 * thirty to fifty of these and N+1 would show.
 */
/**
 * A raw driver value into a Date.
 *
 * db.execute returns exactly what postgres-js hands back, and Drizzle's column
 * mapping only applies to schema-based selects — so a timestamp from a raw
 * query arrives as the string "2026-09-05 16:59:06.596+00". The type on the
 * query below used to claim Date, TypeScript believed the annotation, and the
 * first comparison to run against a real date threw "from.getTime is not a
 * function" on the page listing every application.
 */
export function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export async function listApplicationsForDisplay(userId: string) {
  // Declared as the driver actually returns them, then converted below. The
  // previous annotation was a wish rather than a description.
  const rows = await db.execute<{
    id: string;
    status: string;
    applied_at: string | null;
    follow_up_due_at: string | null;
    closes_at: string | null;
    company: string | null;
    role: string | null;
    location: string | null;
    match_score: number | null;
    has_resume: boolean;
  }>(sql`
    select
      a.id, a.status, a.applied_at, a.follow_up_due_at,
      p.closes_at, p.company, p.role, p.location,
      r.match_score,
      (r.id is not null) as has_resume
    from ${applications} a
    left join ${jobPostings} p on p.id = a.posting_id
    left join lateral (
      select id, match_score
      from ${resumes}
      where application_id = a.id
      order by version desc
      limit 1
    ) r on true
    where a.user_id = ${userId} and a.deleted_at is null
    order by a.updated_at desc
  `);

  return rows.map((row) => ({
    ...row,
    applied_at: toDate(row.applied_at),
    follow_up_due_at: toDate(row.follow_up_due_at),
    closes_at: toDate(row.closes_at),
  }));
}

/** Counts per status, for the filter chips. */
export async function countApplicationsByStatus(userId: string) {
  const rows = await db
    .select({ status: applications.status, count: sql<number>`count(*)::int` })
    .from(applications)
    .where(and(eq(applications.userId, userId), isNull(applications.deletedAt)))
    .groupBy(applications.status);
  return Object.fromEntries(rows.map((r) => [r.status, r.count])) as Record<string, number>;
}

// ── Resumes ────────────────────────────────────────────────────────────────

/** The newest version for an application. */
/**
 * One named version of an application's resume.
 *
 * Browsing history used to mean restoring: the picker's only action copied the
 * chosen version forward, so looking at what you had was indistinguishable from
 * changing what you have, and the list grew every time somebody was curious.
 */
export async function getResumeVersion(userId: string, applicationId: string, version: number) {
  const [row] = await db
    .select()
    .from(resumes)
    .where(
      and(
        eq(resumes.userId, userId),
        eq(resumes.applicationId, applicationId),
        eq(resumes.version, version),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * How many edits have been spent since the last real tailor.
 *
 * The allowance is per tailor rather than per application or per version. Per
 * application would punish tailoring again — a credit spent on a fresh resume
 * arriving with no edits left to refine it. Per version is not a cap at all,
 * since every edit creates a version and the counter would refill itself. Per
 * tailor cannot run away because a refill costs a credit, so the real bound is
 * credits, which is already what this product meters.
 */
export async function countInstructedSince(userId: string, applicationId: string): Promise<number> {
  const rows = await db
    .select({ version: resumes.version, mode: resumes.mode })
    .from(resumes)
    .where(and(eq(resumes.userId, userId), eq(resumes.applicationId, applicationId)))
    .orderBy(desc(resumes.version));

  let spent = 0;
  for (const row of rows) {
    if (row.mode === 'tailored') break;
    if (row.mode === 'instructed') spent += 1;
  }
  return spent;
}

// Note for whoever adds the recovery banner: there is no status predicate here.
// Every insert hardcodes 'complete' today, so nothing is broken — but the moment
// a placeholder row is written before a model returns, it becomes "the latest"
// for the preview, the download and every panel that reads this.
export async function getLatestResume(userId: string, applicationId: string) {
  const [row] = await db
    .select()
    .from(resumes)
    .where(and(eq(resumes.userId, userId), eq(resumes.applicationId, applicationId)))
    .orderBy(desc(resumes.version))
    .limit(1);
  return row ?? null;
}

/**
 * Records a generated resume against its application.
 *
 * A new row per version rather than an update: it makes comparison and undo
 * free, and it means an instruction edit can never destroy the thing it was
 * meant to improve.
 */
/**
 * Every version of the resume written for one application.
 *
 * They have always been stored — each tailor keeps the last one and records
 * which it came from — and there has never been a way to see them. Somebody
 * whose second attempt came out worse than the first had no way back.
 */
export async function listResumeVersions(userId: string, applicationId: string) {
  return db
    .select({
      id: resumes.id,
      version: resumes.version,
      matchScore: resumes.matchScore,
      createdAt: resumes.createdAt,
    })
    .from(resumes)
    .where(and(eq(resumes.userId, userId), eq(resumes.applicationId, applicationId)))
    .orderBy(desc(resumes.version));
}

/**
 * Brings an older version back as the newest one.
 *
 * Copied forward rather than deleting what came after. Restoring is then just
 * another version, so it is itself undoable — and someone who restores by
 * mistake has lost nothing.
 */
export async function restoreResumeVersion(
  userId: string,
  applicationId: string,
  resumeId: string,
): Promise<string | null> {
  const [source] = await db
    .select()
    .from(resumes)
    .where(and(eq(resumes.userId, userId), eq(resumes.id, resumeId)))
    .limit(1);

  // Scoped by userId, so an id belonging to somebody else finds nothing rather
  // than copying their resume into this application.
  if (!source || source.applicationId !== applicationId) return null;

  const previous = await getLatestResume(userId, applicationId);
  const id = newId('res');

  await db.insert(resumes).values({
    id,
    userId,
    applicationId,
    mode: source.mode,
    structure: source.structure as object,
    matchScore: source.matchScore,
    missingRequirements: source.missingRequirements as string[],
    log: [`Restored from version ${source.version}.`],
    warnings: source.warnings as string[],
    estimatedPages: source.estimatedPages,
    version: (previous?.version ?? 0) + 1,
    parentResumeId: source.id,
    status: 'complete',
  });

  await db
    .update(applications)
    .set({ updatedAt: new Date() })
    .where(and(eq(applications.userId, userId), eq(applications.id, applicationId)));

  return id;
}

export async function saveResume(
  userId: string,
  applicationId: string,
  data: {
    structure: unknown;
    matchScore: number | null;
    missingRequirements: string[];
    log: string[];
    warnings: string[];
    estimatedPages: number | null;
    /** 'instructed' when this version came from somebody's own instruction. */
    mode?: string;
  },
): Promise<string> {
  const previous = await getLatestResume(userId, applicationId);
  const id = newId('res');

  await db.insert(resumes).values({
    id,
    userId,
    applicationId,
    mode: data.mode ?? 'tailored',
    structure: data.structure as object,
    matchScore: data.matchScore,
    missingRequirements: data.missingRequirements,
    log: data.log,
    warnings: data.warnings,
    estimatedPages: data.estimatedPages,
    version: (previous?.version ?? 0) + 1,
    parentResumeId: previous?.id ?? null,
    status: 'complete',
  });

  await db
    .update(applications)
    .set({ updatedAt: new Date() })
    .where(and(eq(applications.userId, userId), eq(applications.id, applicationId)));

  return id;
}

// ── Insights ───────────────────────────────────────────────────────────────

export interface SkillGap {
  requirement: string;
  /** How many of this person's saved postings ask for it. */
  demand: number;
}

/**
 * Requirements asked for repeatedly across saved postings that the profile
 * never mentions.
 *
 * This is the one piece of advice the app can give that a resume tool normally
 * cannot: it needs both sides — every posting the person saved, and everything
 * they have said about themselves — and both are already stored. Counting is
 * done in SQL because the postings table is the only place the demand exists.
 */
export async function getSkillGaps(userId: string, minDemand = 2): Promise<SkillGap[]> {
  const demand = await db.execute<{ requirement: string; demand: number }>(sql`
    select lower(req) as requirement, count(distinct ${jobPostings.id})::int as demand
    from ${jobPostings}, jsonb_array_elements_text(${jobPostings.requirements}) as req
    where ${jobPostings.userId} = ${userId}
      and exists (
        select 1 from ${applications} a
        where a.posting_id = ${jobPostings.id} and a.deleted_at is null
      )
    group by 1
    having count(distinct ${jobPostings.id}) >= ${minDemand}
    order by demand desc
  `);

  const rows = Array.from(demand as Iterable<{ requirement: string; demand: number }>);
  if (rows.length === 0) return [];

  // Compare against what the person has actually said, not against the composed
  // resume — tailoring may have dropped a skill from one resume that the person
  // genuinely has, and telling them it is missing would be wrong.
  const known = await db
    .select({ text: facts.text })
    .from(facts)
    .where(and(eq(facts.userId, userId), eq(facts.status, 'active')));

  const haystack = known.map((f) => f.text.toLowerCase()).join(' \n ');
  return rows.filter((r) => !haystack.includes(r.requirement));
}

// ── Deletion ───────────────────────────────────────────────────────────────

/**
 * Removes everything belonging to a person.
 *
 * Every table cascades from `users`, so one delete is the whole graph. Called
 * from the Clerk webhook on user.deleted and from the self-serve delete path —
 * a tool people trust with their work history has to make leaving easy.
 */
export async function deleteUserData(userId: string) {
  await db.delete(users).where(eq(users.id, userId));
}

export { newId };

// ── Metering ───────────────────────────────────────────────────────────────

/**
 * Records one model call.
 *
 * Written after every call rather than on a sampled or batched basis: this
 * table is what the spend ceiling reads, and a ceiling computed from an
 * incomplete record is not a ceiling.
 */
export async function recordUsage(
  userId: string,
  event: {
    kind: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
    resumeId?: string | null;
    sessionId?: string | null;
  },
) {
  await db.insert(usageEvents).values({
    userId,
    kind: event.kind,
    model: event.model,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    cacheReadTokens: event.cacheReadTokens,
    cacheWriteTokens: event.cacheWriteTokens,
    // numeric() takes a string; passing a float would round-trip through
    // double and lose fractions of a cent across thousands of rows.
    costUsd: event.costUsd.toFixed(6),
    resumeId: event.resumeId ?? null,
    sessionId: event.sessionId ?? null,
  });
}

/**
 * What has been spent, and how hard this person has been going.
 *
 * One query rather than two because it runs before every model call, and the
 * point of a cost guard is undermined if the guard itself is expensive.
 *
 * A rolling 24 hours, not a calendar day: a calendar day has a moment when the
 * budget resets, and anyone who notices can wait for it.
 */
export async function getUsageWindow(userId: string): Promise<{
  spentLast24hUsd: number;
  userCallsLastMinute: number;
  userSpentLast24hUsd: number;
}> {
  const [row] = await db.execute(sql`
    select
      coalesce(sum(cost_usd), 0)::float8 as spent_24h,
      coalesce(count(*) filter (
        where user_id = ${userId} and created_at >= now() - interval '1 minute'
      ), 0)::int as user_calls_1m,
      coalesce(sum(cost_usd) filter (where user_id = ${userId}), 0)::float8 as user_spent_24h
    from usage_events
    where created_at >= now() - interval '24 hours'
  `) as unknown as [{ spent_24h: number; user_calls_1m: number; user_spent_24h: number }];

  return {
    spentLast24hUsd: Number(row?.spent_24h ?? 0),
    userCallsLastMinute: Number(row?.user_calls_1m ?? 0),
    userSpentLast24hUsd: Number(row?.user_spent_24h ?? 0),
  };
}
