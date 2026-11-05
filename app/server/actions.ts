'use server';

import { revalidatePath } from 'next/cache';
import { requireUserId } from './auth';
import {
  createRule as createRuleRow,
  deleteApplication as deleteApplicationRow,
  restoreApplication as restoreApplicationRow,
  deleteUserData,
  deleteEntry as deleteEntryRow,
  deleteRule as deleteRuleRow,
  reorderRules as reorderRulesRow,
  setRuleActive as setRuleActiveRow,
  setRuleCheck,
  listRules,
  updateRule as updateRuleRow,
  getResumeInputs,
  restoreResumeVersion as restoreResumeVersionRow,
  setApplicationStatus as setApplicationStatusRow,
  saveContactDetails as saveContactRow,
  saveMasterResume,
  saveSkillGroups,
  setOnboardingGoal as setGoalRow,
  setUserLocale,
  upsertEntry as upsertEntryRow,
  ensureSections,
  listSections,
  removeSectionAndEntries,
  clearPolishSnapshot,
  restoreEntries,
  restoreFromPolishSnapshot,
  restoreRule as restoreRuleRow,
  saveSections,
  updateSectionContent,
  type ProfileEntryRow,
  type RuleRow,
} from './db/repository';
import { buildResume, entryFromRow, type EntryWithBullets } from '../lib/buildResume';
import type { ResumeStructure } from '../lib/types';
import { profileStrength } from '../lib/profileStrength';
import { runPolish } from './polishProfile';
import { confirmSection as confirmSectionRow } from './db/repository';
import { getProfile, getUser } from './db/repository';
import { RULE_MAX_LENGTH, type RuleCheck } from '../lib/rules';
import { readRule } from '../lib/ruleIntake';
import { isKnownLocale } from '../lib/locales';
import {
  SHAPES,
  entryKindFor,
  isRemovable,
  ownSections,
  withSectionAdded,
  withSectionRemoved,
  withSectionRenamed,
} from '../lib/sections';
import type { ResumeSection, SectionShape } from '../lib/types';

/**
 * Mutations the UI can call directly.
 *
 * Every one of them starts by resolving the signed-in user server-side and
 * passes that id down — the client never says who it is, so it cannot claim to
 * be someone else. Ids arriving from the browser are always treated as a
 * request to act on something, never as proof of ownership; the repository
 * scopes by user on top.
 */

export async function saveOnboardingGoal(stage: string, targetField: string) {
  const userId = await requireUserId();

  const allowed = ['internship', 'new_grad', 'experienced'];
  if (!allowed.includes(stage)) throw new Error(`Unknown career stage: ${stage}`);

  await setGoalRow(userId, stage, targetField.trim().slice(0, 120));
  revalidatePath('/account');
}

/**
 * Which English this person's resumes are written in.
 *
 * The column existed and the prompt builder read it from the day it was added,
 * but no screen could set it — so everybody got Canadian spelling regardless of
 * where they were applying. Validated against the same list the picker offers.
 */
export async function saveLocale(locale: string) {
  const userId = await requireUserId();
  if (!isKnownLocale(locale)) throw new Error(`Unknown locale: ${locale}`);
  await setUserLocale(userId, locale);
  revalidatePath('/account');
}

/**
 * The contact block from onboarding.
 *
 * Every field is optional except the ones the account already supplied, and
 * nothing is validated beyond trimming — a resume is not a form to be policed,
 * and rejecting an unusual phone format would be worse than printing it.
 */
export async function saveContactDetails(details: {
  name: string;
  email: string;
  phone: string;
  location: string;
  linkedin: string;
  github: string;
  website: string;
}) {
  const userId = await requireUserId();

  await saveContactRow(userId, [
    { label: 'Name', value: details.name },
    { label: 'Email', value: details.email },
    { label: 'Phone', value: details.phone },
    { label: 'Location', value: details.location },
    { label: 'LinkedIn', value: details.linkedin },
    { label: 'GitHub', value: details.github },
    { label: 'Website', value: details.website },
  ]);

  revalidatePath('/setup');
}

/**
 * Re-renders and stores the master resume.
 *
 * Called after every edit rather than on demand, so the resume other pages read
 * is never out of step with what the person last typed. It is a pure function
 * of the rows, so this costs a render and a write — no model, no latency.
 */
async function refreshMasterResume(userId: string) {
  const { entryRows, factRows, sections } = await getResumeInputs(userId);
  const entries: EntryWithBullets[] = entryRows.map(entryFromRow);

  // A profile that predates the sections table has its summary only in the
  // derived blob this function is about to overwrite. Seeding it first is what
  // stops this save being the one that deletes it.
  const plan = sections.length ? sections : await ensureSections(userId);

  const structure = buildResume(entries, factRows, plan);
  await saveMasterResume(userId, structure, profileStrength(structure));

  // The polish snapshot expires here, and this is the line that stops it doing
  // damage. Every save in the app comes through this function, so "until the
  // next edit" is enforced in one place rather than remembered at fifteen. Undo
  // a polish after editing five entries and, without this, the five edits go
  // with it.
  //
  // After the write, not before: a failure above leaves both the resume and the
  // snapshot as they were rather than throwing away the way back for a save
  // that never happened.
  await clearPolishSnapshot(userId);
  return structure;
}

export interface EntryInput {
  id: string | null;
  /**
   * Which section it belongs to. One of the three the app has always had, or
   * the key of a section this person's resume actually has — a Volunteering
   * entry is filed under 'volunteering', not squeezed into experience.
   */
  kind: string;
  title: string;
  org: string;
  location: string;
  datesDisplay: string;
  tech: string;
  bullets: string[];
  dates: {
    startMonth: number | null;
    startYear: number | null;
    endMonth: number | null;
    endYear: number | null;
    isCurrent: boolean;
  };
  place: { city: string | null; region: string | null; country: string | null };
  url: string;
  extra: Record<string, string>;
}

export async function saveEntry(entry: EntryInput): Promise<string> {
  const userId = await requireUserId();

  // Still a whitelist, just no longer a constant one. Anything outside the
  // three defaults has to be a section this person actually has, so a stray
  // kind cannot create a section nothing renders and nothing can find again.
  const allowed = new Set([
    'experience',
    'education',
    'project',
    ...(await listSections(userId)).map((s) => entryKindFor(s.key)),
  ]);
  if (!allowed.has(entry.kind)) throw new Error(`Unknown entry kind: ${entry.kind}`);

  const id = await upsertEntryRow(userId, entry);
  await refreshMasterResume(userId);
  revalidatePath('/setup');
  // Returned so a newly added entry can be taken back out: undoing an edit
  // writes the old values, but undoing an ADD means removing a row that did
  // not exist a moment ago, and that needs its id.
  return id;
}

/**
 * Deletes an entry and returns the row, so the screen can offer it back.
 *
 * No confirmation in front of this any more. It used to arm itself and ask
 * "Remove for good?", which was a speed bump rather than information — one
 * visible thing is going and the person is looking at it. Undo is the real
 * protection, and the row coming back from here is what makes it possible.
 */
export async function removeEntry(entryId: string): Promise<ProfileEntryRow | null> {
  const userId = await requireUserId();
  const removed = await deleteEntryRow(userId, entryId);
  await refreshMasterResume(userId);
  revalidatePath('/setup');
  return removed;
}

/**
 * Puts a deleted entry back, in its own section and its own position.
 *
 * The row came from the browser, so it is a request and not proof: it gets the
 * same `kind` whitelist `saveEntry` has. Without it an entry can be filed under
 * a section that does not exist, where nothing renders it and nothing in the
 * rail can reach it — invisible, and unreachable afterwards.
 */
export async function restoreEntry(row: ProfileEntryRow): Promise<void> {
  const userId = await requireUserId();
  await restoreEntriesFor(userId, [row]);
  await refreshMasterResume(userId);
  revalidatePath('/setup');
}

/** The whitelist and the insert, shared by restoring one entry and a section's worth. */
async function restoreEntriesFor(userId: string, rows: ProfileEntryRow[]) {
  if (!rows.length) return;
  const allowed = new Set([
    'experience',
    'education',
    'project',
    ...(await listSections(userId)).map((s) => entryKindFor(s.key)),
  ]);
  const keep = rows.filter((row) => allowed.has(row.kind));
  // Logged rather than passed over in silence. If this ever fires, somebody
  // pressed Undo and got less back than they asked for, and the only way to
  // find out otherwise would be noticing an entry missing days later.
  if (keep.length !== rows.length) {
    console.error(
      `[Resumi9] Refused to restore ${rows.length - keep.length} entr(ies): no section to file them under.`,
    );
  }
  await restoreEntries(userId, keep);
}

export async function saveSkills(groups: { category: string; items: string }[]) {
  const userId = await requireUserId();
  await saveSkillGroups(userId, groups.slice(0, 8));
  await refreshMasterResume(userId);
  revalidatePath('/setup');
}

/**
 * Saves a section whose content has nowhere else to live.
 *
 * A summary's paragraph and a certifications list are not entries and are not
 * facts — they are the section. Everything else about editing works the same
 * way: write the row, rebuild the resume from rows, and the change is on the
 * PDF before the page finishes refreshing.
 *
 * Only sections this person already has. Creating one is a different gesture
 * with a different question attached (what is it called, what shape is it), and
 * it is not this.
 */
export async function saveSectionContent(
  key: string,
  content: { text?: string; items?: string[]; groups?: { category: string; items: string }[] },
) {
  const userId = await requireUserId();

  const mine = await listSections(userId);
  const section = mine.find((s) => s.key === key);
  if (!section) throw new Error(`Unknown section: ${key}`);

  const cleaned =
    section.shape === 'prose'
      ? { text: (content.text ?? '').trim() }
      : section.shape === 'groups'
        ? {
            // Kept when either box has something. A language with no level
            // listed is a real line; requiring both would delete it on save.
            groups: (content.groups ?? [])
              .map((g) => ({ category: (g.category ?? '').trim(), items: (g.items ?? '').trim() }))
              .filter((g) => g.category || g.items)
              .slice(0, 30),
          }
        : { items: (content.items ?? []).map((i) => i.trim()).filter(Boolean).slice(0, 30) };

  await updateSectionContent(userId, key, cleaned);
  await refreshMasterResume(userId);
  revalidatePath('/setup');
}

/**
 * Adds a section this person does not have.
 *
 * The key comes from `keyFor`, which is what makes the catalogue safe: somebody
 * choosing "Awards" gets the awards section they already have rather than a
 * second one beside it, and the same is true of anything they type themselves —
 * "Honors & Awards" and "Awards" resolve to one place.
 *
 * Returns the key so the screen can open what was just made. Without it the
 * section appears somewhere in a rail of eight and has to be hunted for.
 */
export async function addSection(label: string, shape: string): Promise<string> {
  const userId = await requireUserId();

  const name = label.trim();
  if (!name) throw new Error('A section needs a name.');
  if (!SHAPES.includes(shape as SectionShape)) throw new Error(`Unknown layout: ${shape}`);

  // The plan as it stands. An empty one is seeded from what they OWN rather
  // than from planSections, which would declare all seven and put
  // Certifications and Awards in the rail of somebody who has neither.
  const { entryRows, factRows, sections } = await getResumeInputs(userId);
  const current = sections.length
    ? sections
    : ownSections(buildResume(entryRows.map(entryFromRow), factRows)).map((s) => ({
        key: s.key,
        label: s.label,
      }));

  const next = withSectionAdded(current, name, shape as SectionShape);
  if (!next) throw new Error(`You already have a ${name} section.`);

  await saveSections(userId, next);
  await refreshMasterResume(userId);
  revalidatePath('/setup');

  return next.find((s) => !current.some((c) => c.key === s.key))!.key;
}

/**
 * Renames a section, and nothing else.
 *
 * The label is what appears on the page and in the rail; the key underneath is
 * untouched, so no entry moves and nothing has to be re-filed. Adding a section
 * from the list means taking the app's wording for a heading on somebody's own
 * resume — this is what gives it back.
 */
export async function renameSection(key: string, label: string): Promise<void> {
  const userId = await requireUserId();

  const sections = await listSections(userId);
  const next = withSectionRenamed(sections, key, label);
  if (!next) {
    throw new Error(
      sections.some((s) => s.key === key)
        ? `You already have a section called that.`
        : `No such section: ${key}`,
    );
  }

  await saveSections(userId, next);
  await refreshMasterResume(userId);
  revalidatePath('/setup');
}

/**
 * Removes a section, and everything filed under it.
 *
 * The one delete the screen still arms first, and the count is why: the entries
 * going with it are not visible from the section being removed, so "3 entries go
 * with it" is a fact nothing else on the page can tell you. Deleting a single
 * entry no longer asks, because there it is the thing being looked at.
 *
 * Everything needed to put it back comes out in the return value.
 */
export async function removeSection(key: string): Promise<{
  /** How many entries went with it. What the confirmation counted. */
  count: number;
  /** Those entries, whole, so they can come back. */
  entries: ProfileEntryRow[];
  /** The plan as it was. Restoring needs this, not the one section — see below. */
  previous: ResumeSection[];
}> {
  const userId = await requireUserId();

  // The four the conventional fallback restores. Removing one would be a button
  // that does nothing, which is worse than not offering it.
  if (!isRemovable(key)) throw new Error(`${key} cannot be removed — leave it empty instead.`);

  const sections = await listSections(userId);
  if (!sections.some((s) => s.key === key)) throw new Error(`No such section: ${key}`);

  const entries = await removeSectionAndEntries(userId, key, withSectionRemoved(sections, key));
  await refreshMasterResume(userId);
  revalidatePath('/setup');
  return { count: entries.length, entries, previous: sections };
}

/**
 * Puts a removed section back, with everything that was filed under it.
 *
 * Takes the whole previous plan rather than the one section, because removing a
 * section rewrites every row: the survivors are re-inserted with fresh ids. Put
 * the single section back on its own and the rest of the plan is left carrying
 * ids nobody holds — so the plan that existed before goes back wholesale, which
 * is what `saveSections` already does.
 *
 * Sections first, then the entries: the entry whitelist checks against sections
 * that exist, so restoring in the other order drops every entry it just saved.
 */
export async function restoreSection(
  previous: ResumeSection[],
  entries: ProfileEntryRow[],
): Promise<void> {
  const userId = await requireUserId();
  if (!previous.length) throw new Error('Nothing to restore.');

  await saveSections(userId, previous);
  await restoreEntriesFor(userId, entries);
  await refreshMasterResume(userId);
  revalidatePath('/setup');
}

/**
 * The same fields, saved from the resume editor rather than from onboarding.
 *
 * GitHub was missing from both the parameter list and the rows written here, so
 * the field collected on /setup was accepted, discarded, and read back empty on
 * the next load — silently, since nothing errors when a value simply never
 * arrives. For a software applicant that is the one link most worth having.
 */
/** Marks a section as one the person has been through. See profiles.confirmedSections. */
export async function confirmSectionReviewed(key: string) {
  const userId = await requireUserId();
  await confirmSectionRow(userId, key);
  revalidatePath('/setup');
}

export async function saveContactAndRefresh(details: {
  name: string;
  email: string;
  phone: string;
  location: string;
  linkedin: string;
  github: string;
  website: string;
}) {
  const userId = await requireUserId();
  await saveContactRow(userId, [
    { label: 'Name', value: details.name },
    { label: 'Email', value: details.email },
    { label: 'Phone', value: details.phone },
    { label: 'Location', value: details.location },
    { label: 'LinkedIn', value: details.linkedin },
    { label: 'GitHub', value: details.github },
    { label: 'Website', value: details.website },
  ]);
  await refreshMasterResume(userId);
  revalidatePath('/setup');
}


// ── Rules ──────────────────────────────────────────────────────────────────

/**
 * The instructions someone wants applied to every resume they make.
 *
 * Kept as rows the person can read, edit and switch off rather than as a blob
 * of remembered preferences: a rule that silently shapes every resume without
 * being visible is indistinguishable from the tool having an opinion of its
 * own, and the first time it produces something unexpected there is nothing to
 * look at.
 */

/** Returns the new rule's id, which is what makes adding one undoable. */
export async function addRule(text: string): Promise<string | null> {
  const userId = await requireUserId();
  const trimmed = text.trim();
  if (!trimmed) return null;
  const id = await createRuleRow(userId, trimmed.slice(0, RULE_MAX_LENGTH));
  revalidatePath('/rules');
  revalidateApplications();
  return id;
}

export async function editRule(ruleId: string, text: string) {
  const userId = await requireUserId();
  const trimmed = text.trim();
  if (!trimmed) return;
  // updateRule clears the old check: it described the sentence being replaced.
  // The caller re-derives.
  await updateRuleRow(userId, ruleId, trimmed.slice(0, RULE_MAX_LENGTH));
  revalidatePath('/rules');
  revalidateApplications();
}

export async function toggleRule(ruleId: string, active: boolean) {
  const userId = await requireUserId();
  await setRuleActiveRow(userId, ruleId, active);
  revalidatePath('/rules');
  revalidateApplications();
}

export async function removeRule(ruleId: string): Promise<RuleRow | null> {
  const userId = await requireUserId();
  const removed = await deleteRuleRow(userId, ruleId);
  revalidatePath('/rules');
  revalidateApplications();
  return removed;
}

/**
 * Works out how a rule can be checked, after it has already been saved.
 *
 * A second call on purpose. Writing a rule stays instant — the row is there
 * before this runs — and if the model is down or slow you are left with a rule
 * that works as guidance rather than with no rule at all. A preference somebody
 * took the trouble to write down must never be lost to an outage.
 *
 * Returns the conflict, if there is one, for the page to show while it is still
 * actionable. It is deliberately not stored: a saved contradiction goes stale
 * the moment either rule is edited, and a stale one is worse than none.
 */
export async function deriveRuleCheck(ruleId: string): Promise<{
  check: RuleCheck | null;
  conflict: { index: number; text: string; reason: string } | null;
}> {
  const userId = await requireUserId();

  const all = await listRules(userId);
  const rule = all.find((r) => r.id === ruleId);
  if (!rule) return { check: null, conflict: null };

  const others = all.filter((r) => r.id !== ruleId);

  try {
    const reading = await readRule(userId, rule.text, others.map((r) => r.text));
    await setRuleCheck(userId, ruleId, reading.check);
    revalidatePath('/rules');
    revalidateApplications();

    const clash = reading.conflictsWith ? others[reading.conflictsWith - 1] : null;
    return {
      check: reading.check,
      conflict:
        clash && reading.conflictReason
          ? { index: reading.conflictsWith!, text: clash.text, reason: reading.conflictReason }
          : null,
    };
  } catch (error) {
    // Guidance is a perfectly good outcome. The rule still reaches the model on
    // every tailor; it simply is not verified afterwards.
    console.error('[Resumi9] Could not read a rule; leaving it as guidance.', error);
    return { check: null, conflict: null };
  }
}

/**
 * A rules card renders on an application, so a rule change has to reach it.
 *
 * Every rule action revalidated only /rules, which was correct while rules were
 * invisible everywhere else. Without this, editing a rule leaves an open
 * application describing rules that no longer exist.
 */
function revalidateApplications() {
  revalidatePath('/applications/[id]', 'page');
}

/**
 * Takes one application off the list.
 *
 * Returns whether there is anything to offer an undo for. A second press on a
 * row mid-removal would otherwise put a toast up for a deletion it did not
 * perform, and pressing undo on THAT would restore something the person had
 * already decided twice to get rid of.
 */
export async function removeApplication(applicationId: string): Promise<boolean> {
  const userId = await requireUserId();
  const removed = await deleteApplicationRow(userId, applicationId);
  revalidatePath('/applications');
  revalidateApplications();
  return removed !== null;
}

/** Puts one back, with its posting and every resume version still attached. */
export async function restoreApplication(applicationId: string): Promise<void> {
  const userId = await requireUserId();
  await restoreApplicationRow(userId, applicationId);
  revalidatePath('/applications');
  revalidateApplications();
}

/** Puts a deleted rule back at its own position in the order. */
export async function restoreRule(row: RuleRow): Promise<void> {
  const userId = await requireUserId();
  await restoreRuleRow(userId, row);
  revalidatePath('/rules');
  revalidateApplications();
}

export async function reorderRules(orderedIds: string[]) {
  const userId = await requireUserId();
  await reorderRulesRow(userId, orderedIds);
  revalidatePath('/rules');
  revalidateApplications();
}


// ── Polish ─────────────────────────────────────────────────────────────────

/**
 * Puts the profile back as it was before the last editorial pass.
 *
 * Returns false when there is nothing to undo, which is not an error and has to
 * be said out loud rather than silently doing nothing: the snapshot is thrown
 * away by the next edit, so "I polished, then changed something, then pressed
 * Undo" is a real sequence and the honest answer is that it is too late. The
 * alternative — applying it anyway — would delete the change.
 */
export async function undoPolish(): Promise<boolean> {
  const userId = await requireUserId();
  const restored = await restoreFromPolishSnapshot(userId);
  if (restored) revalidatePath('/setup');
  return restored;
}

/**
 * Runs the editorial pass over the master resume.
 *
 * Typing your history into a form gets the facts down. It does not decide that
 * "California" reads as "CA", that your skills belong in four named groups, or
 * that your projects should sit above your jobs — those are judgments, and
 * making the person perform them in a form is making them do the work they came
 * here to hand over.
 *
 * Kept separate from saving so that typing stays instant and free. A save marks
 * the profile stale; this is what clears it.
 */
export async function polishMasterResume(): Promise<{
  warnings: string[];
  corrections: { from: string; to: string; reason: string }[];
  sections: { key: string; label: string }[];
}> {
  const userId = await requireUserId();
  const [profile, user] = await Promise.all([getProfile(userId), getUser(userId)]);

  const structure = profile?.resumeStructure as ResumeStructure | null;
  if (!structure?.name) {
    return { warnings: ['Add your name and at least one entry first.'], corrections: [], sections: [] };
  }

  const polish = await runPolish(userId, structure, user?.locale ?? null);

  revalidatePath('/setup');
  return { warnings: polish.warnings, corrections: polish.corrections, sections: polish.sections };
}


// ── Deleting everything ────────────────────────────────────────────────────

/**
 * Removes everything Resumi9 holds about this person.
 *
 * Every table referencing users cascades, so one delete takes the profile,
 * entries, facts, rules, applications, resumes, interview history and usage
 * records with it. Verified against the schema rather than assumed: ten
 * foreign keys, all cascading.
 *
 * The sign-in itself is not touched. That belongs to Clerk and is deleted from
 * Clerk's own account menu — promising to remove something we do not control
 * would be the wrong kind of reassurance.
 *
 * Nothing is archived, soft-deleted or retained. A delete that keeps a copy is
 * not a delete, and this is the page where that has to be literally true.
 */
export async function deleteEverything() {
  const userId = await requireUserId();
  await deleteUserData(userId);
  revalidatePath('/', 'layout');
}


/**
 * Records where an application now stands.
 *
 * The list of allowed values lives here rather than being trusted from the
 * client: a status arrives as a string from a browser, and an unrecognised one
 * would be written straight into the column and then read by code that
 * switches on it.
 */
const STATUSES = ['draft', 'applied', 'interviewing', 'offer', 'rejected', 'withdrawn'] as const;

export async function setApplicationStatus(applicationId: string, status: string) {
  const userId = await requireUserId();
  if (!(STATUSES as readonly string[]).includes(status)) {
    throw new Error(`Unknown application status: ${status}`);
  }
  await setApplicationStatusRow(userId, applicationId, status);
  revalidatePath('/applications');
  revalidatePath(`/applications/${applicationId}`);
}


/** Brings back an earlier version of a tailored resume, as a new version. */
export async function restoreResumeVersion(applicationId: string, resumeId: string) {
  const userId = await requireUserId();
  const restored = await restoreResumeVersionRow(userId, applicationId, resumeId);
  if (!restored) throw new Error('That version could not be found.');
  revalidatePath(`/applications/${applicationId}`);
}
