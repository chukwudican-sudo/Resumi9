import SetupShell from '../components/setup/SetupShell';
import type { Contact } from '../components/setup/ContactSection';
import { entryFromRow, type EntryWithBullets } from '../lib/buildResume';
import type { ResumeStructure } from '../lib/types';
import { requireUserId } from '../server/auth';
import { getProfile, getResumeInputs, getUser } from '../server/db/repository';

/** Where a resume gets built and edited. Everything here is typed by hand. */
export default async function SetupPage() {
  const userId = await requireUserId();
  const [{ entryRows, factRows, sections }, user, profile] = await Promise.all([
    getResumeInputs(userId),
    getUser(userId),
    getProfile(userId),
  ]);

  const entries: EntryWithBullets[] = entryRows.map(entryFromRow);

  const pick = (label: string) =>
    factRows
      .find((f) => f.category === 'identity' && f.text.startsWith(`${label}: `))
      ?.text.slice(label.length + 2) ?? '';

  const contact: Contact = {
    name: pick('Name') || user?.displayName || '',
    email: pick('Email') || user?.email || '',
    phone: pick('Phone'),
    location: pick('Location'),
    linkedin: pick('LinkedIn'),
    github: pick('GitHub'),
    website: pick('Website'),
  };

  // The polished structure is what the person should see once the editorial
  // pass has run; until then the deterministic build is the honest preview.
  const polished = profile && !profile.stale ? (profile.resumeStructure as ResumeStructure) : null;

  return (
    <SetupShell
      initialEntries={entries}
      initialFacts={factRows}
      initialContact={contact}
      initialSections={sections}
      polished={polished}
      stale={profile?.stale ?? true}
      initialConfirmed={(profile?.confirmedSections as string[] | undefined) ?? []}
      // Changes on every save, which is what the preview keys its rebuild off.
      // Counting entries would miss an edit to one that already existed.
      savedAt={profile?.updatedAt?.toISOString() ?? ''}
    />
  );
}
