import { buildDefaultFilenameBase, withVersion } from '../lib/filename';
import type { ResumeStructure } from '../lib/types';
import { getApplication, getLatestResume, getProfile, getResumeVersion } from './db/repository';

/**
 * Which resume a request is about, and what its file should be called.
 *
 * Shared by the download and the preview so they cannot drift. They are the
 * same document — one is offered to save, the other is shown on screen — and
 * the fastest way to reintroduce the bug this preview work exists to kill would
 * be two places deciding separately what to render.
 *
 * Every read is scoped by userId, so naming an id belonging to somebody else
 * finds nothing rather than returning their resume.
 *
 * The `version` argument is what keeps that promise once old versions can be
 * viewed. Before it existed both callers were pinned to the latest, so they
 * agreed by accident; a preview that could show version 2 while the download
 * still handed over version 5 would be exactly the drift this file was written
 * to prevent, and silent — the filename gives no hint. So it is threaded
 * through here and both callers pass it, or neither does.
 */
export type Resolved =
  | { ok: true; structure: ResumeStructure; filename: string }
  | { ok: false; status: 404; error: string };

export async function resolveResume(
  userId: string,
  applicationId?: string | null,
  version?: number | null,
): Promise<Resolved> {
  if (applicationId) {
    const [record, resume] = await Promise.all([
      getApplication(userId, applicationId),
      version && Number.isFinite(version)
        ? getResumeVersion(userId, applicationId, version)
        : getLatestResume(userId, applicationId),
    ]);
    if (!record || !resume) {
      return {
        ok: false,
        status: 404,
        error: version
          ? `Version ${version} of that resume was not found.`
          : 'No resume found for that application.',
      };
    }
    const structure = resume.structure as ResumeStructure;
    return {
      ok: true,
      structure,
      /*
       * The version is in the name from the second one on, so a folder of
       * downloads from one application can be told apart. Before this every
       * download of every version arrived as the same name and the browser
       * numbered them in download order.
       */
      filename: `${withVersion(
        buildDefaultFilenameBase(
          structure.name ?? '',
          record.posting?.role ?? '',
          record.posting?.company ?? '',
        ),
        resume.version as number | null,
      )}.pdf`,
    };
  }

  const profile = await getProfile(userId);
  const structure = (profile?.resumeStructure as ResumeStructure | null) ?? null;
  if (!structure) {
    return { ok: false, status: 404, error: 'Your resume is empty. Add your details first.' };
  }

  return {
    ok: true,
    structure,
    filename: `${buildDefaultFilenameBase(structure.name ?? '', '', '')}.pdf`,
  };
}
