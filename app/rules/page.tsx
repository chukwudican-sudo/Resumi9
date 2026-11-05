import AppNav from '../components/AppNav';
import RulesShell, { type Rule } from '../components/rules/RulesShell';
import { requireUserId } from '../server/auth';
import { getProfile, getUser, listRules } from '../server/db/repository';
import { matchedLabels, unmatchedNames } from '../lib/pins';
import type { ResumeStructure } from '../lib/types';

/**
 * The instructions someone wants applied to every resume they make.
 *
 * These are the closest thing the tool has to memory, and they are deliberately
 * a page rather than something inferred from behaviour: a preference the app
 * worked out on its own is one the person cannot correct, and the first
 * surprising resume would have nothing to point at.
 */
export default async function RulesPage() {
  const userId = await requireUserId();
  const [rows, user, profile] = await Promise.all([listRules(userId), getUser(userId), getProfile(userId)]);

  /*
   * A rule that pins something names it in the person's own words, and those
   * words have to match an entry they actually have. One read "Always include
   * the Aegon Wealth Manager experience entry", whose name matched neither the
   * employer nor the title, and the page said "Checked" over a rule that
   * pinned nothing at all.
   *
   * Resolved on every render rather than stored with the check, so it stays
   * true after a profile edit: delete the job and the rule starts saying the
   * name matches nothing, which is what it then does.
   */
  const structure = (profile?.resumeStructure ?? null) as ResumeStructure | null;

  const rules: Rule[] = rows.map((r) => ({
    id: r.id,
    text: r.text,
    active: r.active,
    source: r.source,
    check: (r.check as Rule['check']) ?? null,
    unmatched: structure ? unmatchedNames(r.check, structure) : [],
    matched: structure ? matchedLabels(r.check, structure) : [],
  }));

  return (
    <main className="min-h-screen bg-ground font-sans text-ink">
      <AppNav active="rules" credits={user?.credits} />
      <RulesShell initialRules={rules} />
    </main>
  );
}
