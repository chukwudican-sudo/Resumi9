import type { Step } from '../components/Stages';

/**
 * What each long operation is doing, in the order it does it.
 *
 * Drawn from what the code actually does rather than invented to fill time —
 * `runPolish` really does proofread, group skills, order sections and rebuild;
 * the tailor route really does polish a stale profile, call the model, run the
 * guard and save a version.
 *
 * **The clock paces them; the work decides when they finish.** `Stages` walks
 * the list on a timer and then holds on the last one until the real promise
 * resolves, so nothing ever claims to be done while it is still running. Where a
 * single model call is shown as more than one step — the middle of a tailor —
 * the split describes real parts of that call's job, and is marked as such
 * below. A wait that never moves reads as a wait that has died.
 *
 * Present tense while running, past tense once behind you. Never a bare
 * "Loading": every line says what is being done.
 */

/** Uploading a resume. The first step is measured, not timed — hence `ms: 0`. */
export const IMPORT_STEPS: Step[] = [
  { label: 'Uploading', past: 'Uploaded', ms: 0 },
  { label: 'Reading your resume', past: 'Read your resume', ms: 18_000 },
  { label: 'Sorting out your sections', past: 'Sorted out your sections', ms: 4_000 },
  { label: 'Saving it to your profile', past: 'Saved it to your profile', ms: 2_000 },
];

/** The editorial pass: two model calls in parallel, then the writes. */
export const POLISH_STEPS: Step[] = [
  { label: 'Checking your spelling', past: 'Checked your spelling', ms: 5_000 },
  { label: 'Grouping your skills', past: 'Grouped your skills', ms: 7_000 },
  { label: 'Putting your sections in order', past: 'Put your sections in order', ms: 3_000 },
  { label: 'Rebuilding your resume', past: 'Rebuilt your resume', ms: 2_500 },
];

/**
 * Download, when the resume has changed since the last pass.
 *
 * One list with the PDF on the end. Press Download, get twenty seconds of
 * spelling correction, and the polish reads as something that wandered in
 * uninvited — unless you can see where it is going.
 */
export const DOWNLOAD_STEPS: Step[] = [
  ...POLISH_STEPS,
  { label: 'Building your PDF', past: 'Built your PDF', ms: 4_000 },
];

/** Why a download is suddenly doing all that. Shown only when it is. */
export const DOWNLOAD_WHY =
  'Your resume has changed since it was last tidied up, so that happens first.';

/**
 * Tailoring, once the posting has been read.
 *
 * It no longer opens with "Reading the posting": on every path into a tailor
 * the posting was read before this began — by the form's own short wait on the
 * way in, or when the application was first saved. Ticking it again here would
 * be claiming work that is not happening.
 *
 * The last two steps are real and separate from the model call: the guard that
 * checks nothing was dropped or invented, and the write. The two before them
 * are that one call shown as two. Nothing can see inside it to know when one
 * part ends, and one line sitting still for thirty seconds reads as dead.
 */
export const TAILOR_STEPS: Step[] = [
  { label: "Matching it against what you've done", past: "Matched it against what you've done", ms: 7_000 },
  { label: 'Rewriting your experience', past: 'Rewrote your experience', ms: 15_000 },
  // What this step actually does today is check that no entry, skill or date
  // went missing. It said "nothing was invented", which nothing checked.
  { label: 'Checking nothing was dropped', past: 'Checked nothing was dropped', ms: 4_000 },
  { label: 'Saving this version', past: 'Saved this version', ms: 2_000 },
];

/**
 * The short wait on the way in: reading a pasted posting.
 *
 * Only this part is a full-window wait now, and it is about eight seconds. The
 * tailor that follows runs on the application page itself, beside what the
 * posting asks for — which cannot be shown until this has finished, because
 * this is what finds out.
 */
export const READ_POSTING_STEPS: Step[] = [
  { label: 'Reading the posting', past: 'Read the posting', ms: 4_000 },
  { label: 'Pulling out what they ask for', past: 'Pulled out what they ask for', ms: 2_000 },
];

/** One instruction against an existing resume. */
export const INSTRUCT_STEPS: Step[] = [
  { label: 'Reading what you asked for', past: 'Read what you asked for', ms: 4_000 },
  { label: 'Rewriting', past: 'Rewritten', ms: 12_000 },
  { label: 'Saving the new version', past: 'Saved the new version', ms: 2_000 },
];

/**
 * The line that appears once a wait has run long.
 *
 * One sentence doing two jobs: it is still alive, and this is not what usually
 * happens — so somebody a minute in knows whether to keep waiting or come back.
 */
export const REASSURE = 'Still going — this one is taking longer than usual, but it has not failed.';
