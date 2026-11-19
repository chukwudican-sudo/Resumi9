/**
 * What a failure is allowed to say about itself.
 *
 * A failure log that carries somebody's work history is a second copy of
 * their resume in a table nobody audits, and error messages are full of it:
 * a LaTeX log quotes the line it choked on, a Postgres error quotes the
 * parameters it was given, and a validation error quotes the bullet. None of
 * that is needed to know what broke.
 *
 * So `reason` is reduced to the error's class and a short, scrubbed first
 * line. The scrub is deliberately blunt — it throws away anything that COULD
 * be somebody's text rather than trying to recognise what is. A reason that
 * says less than it could is a cost; a reason holding a stranger's bullet is
 * a different kind of thing entirely.
 */

/** How far an attempt got. `done` is the only one that is not a failure. */
export type Stage =
  | 'limits'
  | 'model'
  | 'unreadable'
  | 'guard_unusable'
  | 'honesty_emptied'
  | 'fit'
  | 'compile'
  | 'save'
  | 'done';

/**
 * Who should act.
 *
 * `user` is not a fault at all — an unfinished profile, a page rule nothing
 * can satisfy — and it is here so those can be counted separately rather
 * than inflating a failure rate nobody can act on.
 */
export type Fault = 'app' | 'model' | 'user' | 'upstream';

/** Everything that is never part of a reason, however an error phrases it. */
const SCRUB: [RegExp, string][] = [
  // Quoted text of any length: the commonest way a bullet reaches a message.
  [/"[^"]{12,}"/g, '"…"'],
  [/'[^']{12,}'/g, "'…'"],
  [/[“”][^“”]{12,}[“”]/g, '“…”'],
  // Postgres and drizzle quote the statement and its parameters.
  [/\bparams:[\s\S]*$/i, 'params: …'],
  [/\bFailed query:[\s\S]*$/i, 'Failed query: …'],
  // A LaTeX log quotes the source line that broke the compile.
  [/\bl\.\d+[^\n]*/g, 'l.… …'],
  [/\\[a-zA-Z@]+\{[^}]*\}/g, '\\…{…}'],
  // JSON fragments carry whole structures.
  [/\{[\s\S]*\}/g, '{…}'],
  [/\[[\s\S]{24,}\]/g, '[…]'],
  // A URL can carry an id or a query somebody typed.
  [/https?:\/\/\S+/g, '<url>'],
];

/**
 * One short line, with anything that could be the person's own text removed.
 *
 * Capped hard at 200 characters after scrubbing, because the scrub cannot be
 * complete: a message that embeds a bullet without quoting it would survive
 * every rule above, and a truncated leak is still a leak. The cap is the
 * backstop, the rules are the intent, and the length is chosen so a class
 * name and a sentence fit and a paragraph does not.
 */
export function sanitise(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  const raw = error instanceof Error ? error.message : String(error ?? '');

  let line = raw.split('\n')[0] ?? '';
  for (const [pattern, replacement] of SCRUB) line = line.replace(pattern, replacement);

  line = line.replace(/\s+/g, ' ').trim();
  if (line.length > 200) line = `${line.slice(0, 199)}…`;

  return line ? `${name}: ${line}` : name;
}

/**
 * Whose problem it is, read off the error rather than guessed at the call site.
 *
 * Only the shapes the app actually throws are named. Anything else is `app`,
 * because an error nobody classified is one nobody has looked at, and
 * flattering it to `upstream` would hide exactly the thing this table is for.
 */
export function faultOf(error: unknown, stage: Stage): Fault {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : '';

  if (/Capacity|RateLimit|Overloaded|APIConnection|Timeout|Abort/i.test(name)) return 'upstream';
  if (/busy/i.test(message) && stage === 'compile') return 'upstream';
  if (stage === 'limits') return 'user';
  if (stage === 'unreadable' || stage === 'guard_unusable' || stage === 'honesty_emptied') return 'model';
  return 'app';
}
