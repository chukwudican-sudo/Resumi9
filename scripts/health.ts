/**
 * What is failing, and for whom.
 *
 *   npx tsx scripts/health.ts        # the last 14 days
 *   npx tsx scripts/health.ts 90     # or however many
 *
 * Reads only. It exists because six real users' tailors failed in September
 * and the only way to find them was to infer from absence — a billed usage
 * event with no resume beside it — which took three rounds of archaeology to
 * half-answer. Which stage failed, and whether the credit went back, could
 * not be recovered at all.
 *
 * A query rather than a page, deliberately: the expected row count is single
 * digits, and a dashboard over single digits is furniture.
 *
 * `report` is separated from the queries so the printing can be exercised
 * without a database. The first real run of this script died on a SQL error
 * nobody had executed — every query is now run against the real table, empty
 * and populated, by scripts/health.selftest.ts.
 */
import postgres from 'postgres';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * How long a request of each kind is allowed to take, from the route's own
 * `maxDuration`. An attempt is only KILLED once it has outlived that — a row
 * open for thirty seconds is a tailor still running, and calling it a
 * casualty would report everything in flight as a failure.
 */
export const MAX_SECONDS: Record<string, number> = { tailor: 120, instruct: 120, compile: 60, preview: 60 };

/**
 * Plus a minute: the platform stops a function at its limit rather than at
 * the instant the limit passes, and seconds of clock skew between the app
 * and the database should not invent a corpse.
 */
export const GRACE = 60;

/** A string literal for sql.unsafe, so a kind name can never become SQL. */
const escaped = (value: string) => `'${value.replace(/'/g, "''")}'`;

/**
 * The SQL for "opened, never closed, and has outlived its route".
 *
 * One CASE, not a list of them. This was written as
 * `coalesce((case …, case …, case …), 120)`, and brackets round a
 * comma-separated list are a ROW constructor — Postgres refused the whole
 * script with "COALESCE types record and integer cannot be matched" on its
 * first real run against the table. A single CASE with one WHEN per kind
 * says what was meant.
 */
export function killedPredicate(): string {
  const whens = Object.entries(MAX_SECONDS)
    .map(([kind, seconds]) => `when ${escaped(kind)} then ${seconds}`)
    .join(' ');
  return (
    'finished_at is null and created_at < now() - make_interval(secs => ' +
    `(case kind ${whens} else 120 end) + ${GRACE})`
  );
}

export interface Totals { attempts: number; ok: number; failed: number; unfinished: number }
export interface KindRow { kind: string; n: number; failed: number; unfinished: number }
export interface StageRow { stage: string; fault: string | null; n: number; refunded: number }
export interface FailureRow {
  created_at: Date;
  kind: string;
  stage: string;
  fault: string | null;
  reason: string | null;
  refunded: boolean;
}

const pad = (s: unknown, n: number) => String(s ?? '').padEnd(n);
const num = (s: unknown, n: number) => String(s ?? '').padStart(n);

/**
 * Everything the script prints, given what it read.
 *
 * Returns whether anything here should fail a check, so the caller sets the
 * exit code in one place rather than scattering it through the printing.
 */
export function report(data: {
  days: number;
  billed: number;
  totals: Totals;
  byKind: KindRow[];
  byStage: StageRow[];
  unrefunded: FailureRow[];
  recent: FailureRow[];
  /** When the billed count starts, if it was bounded. See the caller. */
  countedFrom?: Date | null;
  log?: (line: string) => void;
}): { alarm: boolean } {
  const say = data.log ?? ((line: string) => console.log(line));
  const { totals, billed } = data;
  let alarm = false;

  say(`\n══ Resumi9 health, last ${data.days} days ══\n`);

  /*
   * An empty table means one of two things and they are opposites.
   *
   * Either nothing ran, or everything ran and the logger is broken —
   * beginAttempt swallows its own errors by design, so a failed insert is a
   * line on a server console nobody is reading. usage_events is the
   * independent witness: written by a different function on a different
   * path, so billed calls with no attempt rows is the logger quietly dead.
   * Reporting that as "no failures" would be worse than printing nothing.
   */
  if (!totals.attempts) {
    if (billed > 0) {
      say('⚠ NOT a clean bill of health.\n');
      say(`${billed} tailor/instruct model call(s) were billed in this window and NOT ONE`);
      say('opened an attempt row. Either this traffic predates the failures table,');
      say('or beginAttempt is failing silently — it swallows its own errors on purpose,');
      say("so the only symptom is this mismatch. Check the server logs for");
      say("'Could not open an attempt row', and try a shorter window to rule out");
      say('calls made before the migration.\n');
      return { alarm: true };
    }
    say('No attempts recorded, and no model calls billed either — nothing ran.\n');
    return { alarm: false };
  }

  /* The same check when the table is thin rather than empty. */
  if (billed > totals.attempts * 2 && billed - totals.attempts > 5) {
    say(`⚠ ${billed} billed tailor/instruct calls but only ${totals.attempts} attempt rows.`);
    say('   Either the window reaches back before the table existed, or the logger');
    say('   is dropping writes. Narrow the window to tell which.\n');
    alarm = true;
  }

  const rate = ((totals.failed / totals.attempts) * 100).toFixed(1);
  say(`attempts ${totals.attempts}   ok ${totals.ok}   failed ${totals.failed} (${rate}%)   unfinished ${totals.unfinished}`);
  /*
   * Unfinished is the number nothing else can show. A request the platform
   * kills runs no catch block, so it reports nothing — the row that opened
   * and never closed is the only trace it leaves.
   */
  if (totals.unfinished) {
    say(`         ${totals.unfinished} opened and never closed — killed mid-flight, not caught by any handler`);
  }

  say('\nby kind');
  for (const r of data.byKind) {
    say(`   ${pad(r.kind, 10)} ${num(r.n, 5)} attempts  ${num(r.failed, 4)} failed  ${num(r.unfinished, 4)} unfinished`);
  }

  if (data.byStage.length) {
    say('\nwhere they failed');
    for (const r of data.byStage) {
      say(`   ${pad(r.stage, 16)} ${pad(r.fault ?? '?', 9)} ${num(r.n, 4)}   refunded ${r.refunded}/${r.n}`);
    }
  }

  /*
   * A failure that took the credit is the one somebody writes in about. The
   * refund is meant to be exhaustive, so anything here is a bug.
   */
  if (data.unrefunded.length) {
    say(`\n⚠ ${data.unrefunded.length} tailor failure(s) with no refund recorded:`);
    for (const r of data.unrefunded) {
      say(`   ${r.created_at.toISOString().slice(0, 16)}  ${pad(r.stage, 16)} ${String(r.reason ?? '').slice(0, 70)}`);
    }
    alarm = true;
  }

  if (data.recent.length) {
    say('\nmost recent');
    for (const r of data.recent) {
      say(
        `   ${r.created_at.toISOString().slice(0, 16)}  ${pad(r.kind, 9)} ${pad(r.stage, 16)} ` +
        `${pad(r.fault ?? '?', 9)} ${r.refunded ? 'refunded' : '        '}  ${String(r.reason ?? '').slice(0, 64)}`,
      );
    }
  }

  say(
    `\nfor scale: ${billed} billed tailor/instruct model calls` +
    `${data.countedFrom ? ` since the first attempt row (${data.countedFrom.toISOString().slice(0, 16)})` : ' in the same window'}\n`,
  );
  return { alarm };
}

async function main() {
  const env = Object.fromEntries(
    fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
      .split('\n')
      .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
      .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]),
  );
  const sql = postgres(env.DATABASE_URL, { prepare: false, max: 1 });
  const days = Number(process.argv[2]) || 14;
  const since = `${days} days`;
  const KILLED = sql.unsafe(killedPredicate());

  /*
   * Said plainly, because the alternative is a parse_relation.c stack trace
   * for the entirely ordinary situation of the migration not being run yet.
   */
  const [present] = await sql`select to_regclass('public.failures') is not null as ok`;
  if (!present.ok) {
    console.log('\nThe `failures` table does not exist on this database yet.');
    console.log('Apply drizzle/0012_failures.sql, then run this again.\n');
    console.log('The app is safe to deploy before that: beginAttempt and endAttempt');
    console.log('swallow their own errors, so a missing table logs to the console and');
    console.log("records nothing rather than failing anybody's tailor.\n");
    await sql.end();
    return;
  }

  const [totals] = await sql`
    select count(*)::int as attempts,
           count(*) filter (where ok)::int as ok,
           count(*) filter (where ok is false)::int as failed,
           count(*) filter (where ${KILLED})::int as unfinished
    from failures where created_at > now() - ${since}::interval`;

  /*
   * Billed calls the logger could actually have seen.
   *
   * The witness is only fair from the moment the table existed. Counting
   * everything in the window made the first real run shout about 452 calls
   * made before the migration — a true statement and a useless one, and the
   * kind of false alarm that teaches people to ignore the alarm.
   *
   * So the comparison starts at the earliest attempt row. With NO rows at
   * all there is no such moment and the whole window counts, which is what
   * keeps a logger that never worked from hiding behind an empty table.
   */
  const [first] = await sql`select min(created_at) as t from failures`;
  const [billed] = first.t
    ? await sql`
        select count(*)::int as n from usage_events
        where kind in ('tailor','instruct')
          and created_at > now() - ${since}::interval
          and created_at >= ${first.t}`
    : await sql`
        select count(*)::int as n from usage_events
        where kind in ('tailor','instruct') and created_at > now() - ${since}::interval`;

  const byKind = await sql`
    select kind,
           count(*)::int as n,
           count(*) filter (where ok is false)::int as failed,
           count(*) filter (where ${KILLED})::int as unfinished
    from failures where created_at > now() - ${since}::interval
    group by kind order by failed desc, n desc`;

  const byStage = await sql`
    select stage, fault, count(*)::int as n, count(*) filter (where refunded)::int as refunded
    from failures
    where created_at > now() - ${since}::interval and ok is false
    group by stage, fault order by n desc`;

  const unrefunded = await sql`
    select created_at, kind, stage, fault, reason, refunded from failures
    where created_at > now() - ${since}::interval and ok is false and not refunded and kind = 'tailor'
    order by created_at desc limit 10`;

  const recent = await sql`
    select created_at, kind, stage, fault, reason, refunded from failures
    where created_at > now() - ${since}::interval and ok is false
    order by created_at desc limit 12`;

  const { alarm } = report({
    days,
    billed: billed.n,
    countedFrom: (first.t as Date | null) ?? null,
    totals: totals as unknown as Totals,
    byKind: byKind as unknown as KindRow[],
    byStage: byStage as unknown as StageRow[],
    unrefunded: unrefunded as unknown as FailureRow[],
    recent: recent as unknown as FailureRow[],
  });
  if (alarm) process.exitCode = 1;

  await sql.end();
}

/*
 * Only when run, never when imported.
 *
 * `report` is exported so the self-test can exercise the printing, and a
 * bare `main()` at the bottom meant importing it opened a second connection
 * and printed a whole second report into the middle of the test's output.
 * A module that does its work on import is a module nothing can reuse.
 */
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
