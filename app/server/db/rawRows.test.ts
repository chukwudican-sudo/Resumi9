import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The same bug, twice, in the same file — so now it is a test.
 *
 * Drizzle's `db.execute` hands back exactly what the driver gives it, and the
 * column mapping that turns a `timestamptz` into a Date applies only to
 * schema-based selects. So a timestamp from a raw query arrives as the string
 * "2026-11-19 08:03:58.781788+00", and writing `row.created_at as Date` is a
 * promise to the typechecker rather than a conversion.
 *
 * It cost the applications list once — `from.getTime is not a function` —
 * which is why `toDate` exists and has its own test. It cost the feedback
 * inbox a second time four months later, in the same file, in a query written
 * by somebody who had the first one on screen.
 *
 * A comment did not stop it and a helper did not stop it. This does: the cast
 * is now a failing test rather than a thing to remember.
 *
 * Lint would be the better home for it. This project has no ESLint
 * configuration — `next lint` offers to create one — and adding a whole
 * toolchain at the hour this was written would have been the larger risk, so
 * it lives here. A test that reads source is a blunt instrument; a blunt
 * instrument that runs is worth more than a sharp one that does not.
 */

const ROOTS = ['app', 'scripts'];
const SOURCE = /\.tsx?$/;

function walk(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const at = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(at, found);
    else if (SOURCE.test(entry.name)) found.push(at);
  }
  return found;
}

const files = ROOTS.flatMap((root) => walk(path.join(process.cwd(), root))).map((file) => ({
  path: path.relative(process.cwd(), file),
  text: fs.readFileSync(file, 'utf8'),
}));

/** Drizzle's raw escape hatch, in either of the two shapes this codebase uses. */
const USES_RAW_EXECUTE = /\b(?:db|on|tx)\.execute\(/;

/** `as Date`, `as Date | null`, `as unknown as Date` — a claim, not a conversion. */
const CASTS_TO_DATE = /\bas\s+(?:unknown\s+as\s+)?Date\b/;

/** Comments talk ABOUT the cast; only code performs one. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');
}

test('no file that runs a raw query casts a value to Date', () => {
  const offenders: string[] = [];

  for (const file of files) {
    if (file.path.endsWith('rawRows.test.ts')) continue;
    const code = withoutComments(file.text);
    if (!USES_RAW_EXECUTE.test(code)) continue;

    for (const [index, line] of code.split('\n').entries()) {
      if (CASTS_TO_DATE.test(line)) offenders.push(`${file.path}:${index + 1}  ${line.trim()}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'A raw query returns a timestamp as a STRING. Casting it to Date compiles and then throws\n' +
      '"getTime is not a function" on the first real row. Use a schema-based select, where the\n' +
      "column mappers run, or convert it with toDate() from repository.ts. Offending lines:\n  " +
      offenders.join('\n  '),
  );
});

test('at least one file does run a raw query, so the check above is not vacuous', () => {
  /*
   * The failure mode of a source-scanning test: somebody renames `execute`,
   * the pattern stops matching anything at all, and a green test means the
   * check no longer runs rather than that nothing is wrong.
   */
  const using = files.filter((file) => USES_RAW_EXECUTE.test(withoutComments(file.text)));
  assert.ok(using.length >= 3, `expected several files using raw execute, found ${using.length}`);
});

test('toDate is still there for the queries that genuinely need it', () => {
  // The other half: the helper the first occurrence produced. A test that
  // bans the cast without keeping the alternative around invites the cast back.
  const repository = files.find((file) => file.path.endsWith('server/db/repository.ts'));
  assert.ok(repository, 'repository.ts not found');
  assert.match(repository.text, /export function toDate\(/);
});
