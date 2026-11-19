import { createHmac } from 'node:crypto';
import { MAX_STORE_BYTES } from '../lib/feedback';
import { getUser } from './db/repository';

/**
 * The parts of the feedback path that need a secret, a request header or the
 * deploy — none of which belong in `lib/feedback.ts`, which the browser
 * imports for the limits.
 */

/**
 * Who may open the inbox.
 *
 * By email rather than by Clerk id, for a reason the database decides: the
 * owner's address has three user rows behind it, and an id list would have to
 * be maintained every time somebody signs in through a different provider. The
 * address comes out of our own `users` table, which is written from Clerk's
 * primary VERIFIED email — not from anything the browser said.
 *
 * Unset means nobody, and the page is a 404 rather than a locked door. That is
 * the safe direction for a feature whose whole job is to read other people's
 * words: a deploy that forgets the variable shows the inbox to no one, instead
 * of to everyone.
 */
function adminEmails(): string[] {
  return (process.env.RESUMI_ADMIN_EMAILS ?? '')
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

export async function isAdmin(userId: string | null): Promise<boolean> {
  if (!userId) return false;
  const allowed = adminEmails();
  if (!allowed.length) return false;
  try {
    const user = await getUser(userId);
    const email = user?.email?.trim().toLowerCase();
    return Boolean(email && allowed.includes(email));
  } catch (error) {
    /*
     * Never throws, and failing closed is correct at every call site.
     *
     * The inbox and the screenshot route read this to decide whether to
     * answer at all, so an error becoming `false` means a 404 — the safe
     * direction. The nav bar reads it to decide whether to offer a link, and
     * there an unhandled throw would be far worse than a missing link: the
     * bar renders on four signed-in pages, so one bad query would take all
     * four down at once. The root layout guards `syncCurrentUser` for the
     * same reason, and this became a database call on those pages the moment
     * the link was added to it.
     */
    console.error('[Resumi9] Could not check admin access; treating as not an admin.', error);
    return false;
  }
}

/**
 * The deploy this came from.
 *
 * Read on the server, because the question a report answers is "which code was
 * running", and the browser's answer to that is whatever it was last served.
 * Vercel sets the commit on every build; locally there is none, and `dev` is
 * the honest answer rather than a guess.
 */
export function appVersion(): string {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA;
  if (sha) return sha.slice(0, 12);
  return process.env.NODE_ENV === 'production' ? 'unknown' : 'dev';
}

/**
 * Who sent it, for counting only.
 *
 * A signed-in id is already a stable key and is stored as it is — it is in
 * `users` anyway. An address is not stored: it is HMAC'd, because the whole
 * IPv4 space is small enough that a plain hash of an address is an address.
 * What is kept is enough to count two requests as the same sender and not
 * enough to be a log of who visited.
 *
 * The key is a dedicated variable where one is set, and the database URL
 * otherwise — a server-only, high-entropy string that is present wherever this
 * code runs, and which an HMAC does not reveal. With neither (a build with no
 * environment at all) the counting still works; it is the irreversibility that
 * weakens, so the fallback is a literal rather than an empty string, to make a
 * silent downgrade impossible to mistake for the real thing.
 */
function senderSalt(): string {
  return process.env.FEEDBACK_SENDER_SALT || process.env.DATABASE_URL || 'resumi9-no-salt-configured';
}

export function senderKey(userId: string | null, ip: string | null): string | null {
  if (userId) return userId;
  if (!ip) return null;
  return `ip_${createHmac('sha256', senderSalt()).update(ip).digest('hex').slice(0, 32)}`;
}

/**
 * The caller's address, as far as the platform will say.
 *
 * `x-forwarded-for` is a list appended to by each hop; the client's own
 * address is the FIRST entry. Taking the last would be taking the proxy's.
 * Nothing here trusts it for anything but counting — it is a header, so a
 * sender who wants a fresh bucket can have one, which is what the global
 * backstop is for.
 */
export function callerIp(headers: Headers): string | null {
  const forwarded = headers.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  return first || headers.get('x-real-ip')?.trim() || null;
}

/**
 * How much screenshot the table may hold in total.
 *
 * Read here rather than in lib/feedback.ts because the panel imports that
 * file: a non-public environment variable is `undefined` in the browser, so
 * reading it there would give the two sides different numbers.
 */
export function storeLimitBytes(): number {
  const given = Number(process.env.FEEDBACK_STORE_LIMIT_BYTES);
  return Number.isFinite(given) && given > 0 ? given : MAX_STORE_BYTES;
}

/**
 * What the bytes actually are, rather than what the upload claimed.
 *
 * A content type on a form part is a string the sender chose. These two
 * signatures are the file formats the panel produces, and a part whose bytes
 * do not open with one of them is not stored — so the admin page cannot be
 * made to serve something else back under an image's content type.
 */
export function sniffImage(bytes: Buffer): 'image/png' | 'image/jpeg' | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  return null;
}
