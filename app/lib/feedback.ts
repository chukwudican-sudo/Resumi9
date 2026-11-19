/**
 * What a piece of feedback is, and what the browser is allowed to send.
 *
 * Pure and isomorphic on purpose — the panel in the browser and the route on
 * the server both enforce these, and the two have to agree. The browser's copy
 * is a courtesy so somebody is told before they wait for an upload; the
 * server's copy is the actual limit.
 *
 * Nothing here reads a resume, a posting or a bullet. The message is whatever
 * the person chose to type, and everything else is the shape of their window.
 * The one thing deliberately NOT captured is the console log: it is the most
 * commonly recommended field in every in-app-feedback guide, and in this app a
 * console error can quote a bullet — see `sanitise` in lib/failures.ts for the
 * same rule applied to the failures table.
 */

/** What the person says this is. First is the default, because most of it is. */
export const KINDS = ['bug', 'idea', 'confusing', 'other'] as const;
export type Kind = (typeof KINDS)[number];

/** How each kind is offered, in the order the chips appear. */
export const KIND_LABELS: Record<Kind, string> = {
  bug: 'Something broke',
  idea: 'An idea',
  confusing: 'Confusing',
  other: 'Something else',
};

export const isKind = (value: unknown): value is Kind =>
  typeof value === 'string' && (KINDS as readonly string[]).includes(value);

/**
 * Long enough for somebody to describe what they expected and what happened —
 * which is what the message has to carry, since a screenshot is evidence
 * rather than a report.
 */
export const MAX_MESSAGE = 4000;

/** Short, because an empty box with a Send button is an accident waiting. */
export const MIN_MESSAGE = 2;

export const MAX_EMAIL = 200;
export const MAX_URL = 500;
export const MAX_AGENT = 300;

export const MAX_SHOTS = 3;

/**
 * Per image and per submission, after the browser has shrunk them.
 *
 * The per-submission total matters more than it looks: a serverless request
 * body is capped around 4.5 MB on the platform this runs on, and a request
 * over that is refused before any of this code sees it — which would read to
 * the person as the feedback form being broken.
 *
 * The shrink loop in the panel guarantees the per-image figure or attaches
 * nothing at all: it scales to a long edge of MAX_EDGE and steps the JPEG
 * quality down until the result fits. A 1600px screenshot of this app lands
 * around 200-400 KB; the ceiling exists for the dense ones.
 */
export const MAX_SHOT_BYTES = 2_000_000;
export const MAX_TOTAL_BYTES = 3_500_000;

/**
 * And across the whole table, which is the only cap that bounds anything.
 *
 * Per-submission limits bound ONE report. Nothing in them stops a thousand
 * reports, and the database this runs on has 500 MB in total — shared with
 * every resume, every bullet and every posting in the app. Two hundred
 * megabytes is roughly six hundred screenshots, far past what a tester round
 * produces, and leaves more than half the database to the product.
 *
 * Past it, a report is still stored. The screenshots are not, and the person
 * is told so — dropping somebody's words because an unrelated table is full
 * would be the wrong thing to protect.
 *
 * Override with FEEDBACK_STORE_LIMIT_BYTES; see server/feedback.ts.
 */
export const MAX_STORE_BYTES = 200_000_000;

/** PNG and JPEG only. A screenshot is one of the two. */
export const SHOT_TYPES = ['image/png', 'image/jpeg'] as const;
export const isShotType = (value: string): boolean =>
  (SHOT_TYPES as readonly string[]).includes(value);

/**
 * The application the person was looking at, read off the page they sent from.
 *
 * Taken from the URL rather than passed as a field, so it cannot disagree with
 * where they actually were — and checked against their own applications on the
 * server before it is stored, so a made-up id becomes a null rather than a
 * pointer to somebody else's row.
 */
export function applicationIdFrom(pageUrl: string | null | undefined): string | null {
  if (!pageUrl) return null;
  const match = /\/applications\/([^/?#]+)/.exec(pageUrl);
  const id = match?.[1];
  if (!id || id === 'new' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  return id;
}

/** A string cut to fit its column, with nothing clever about where. */
export const trimTo = (value: string, max: number): string =>
  value.length <= max ? value : value.slice(0, max);

/**
 * How much feedback one person may send, and how often.
 *
 * Eight in ten minutes. A tester working through a list of problems sends
 * three or four in a sitting, so this is well above honest use and still low
 * enough that a script posting in a loop stops being free immediately. The
 * window is rolling and counted in the database, because a serverless function
 * has no memory between requests to count in.
 */
export const RATE_WINDOW_MINUTES = 10;
export const RATE_PER_SENDER = 8;

/**
 * And across everybody, as a backstop.
 *
 * The per-sender limit is keyed on a signed-in id or a hashed address, and
 * addresses are cheap to change. This is the number that bounds the damage
 * when somebody bothers to.
 */
export const RATE_GLOBAL_PER_HOUR = 300;
