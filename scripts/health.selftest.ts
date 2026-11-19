/**
 * Runs every query and every line health.ts prints, against the real table.
 *
 *   npx tsx scripts/health.selftest.ts
 *
 * It exists because the first real run of health.ts died on a SQL error:
 * `coalesce((case …, case …), 120)` — brackets round a comma-separated list
 * are a ROW constructor, and Postgres refused the lot. The queries had been
 * typechecked, reviewed and committed, and never executed. A query is not
 * code until a database has seen it.
 *
 * **It writes nothing.** The populated half runs inside a transaction that
 * always rolls back, so the rows exist only for the length of the check and
 * `failures` is as it was afterwards — which the last line verifies rather
 * than assumes.
 */
import postgres from 'postgres';
import fs from 'node:fs';
import { killedPredicate, report, type FailureRow, type KindRow, type StageRow, type Totals } from './health';

/** Whatever can run a tagged query — the pool, or a transaction inside it. */
type Queryable = postgres.Sql | postgres.TransactionSql;

const QUERIES = (sql: Queryable, KILLED: unknown, since: string) => ({
  totals: () => sql`
    select count(*)::int as attempts,
           count(*) filter (where ok)::int as ok,
           count(*) filter (where ok is false)::int as failed,
           count(*) filter (where ${KILLED as never})::int as unfinished
    from failures where created_at > now() - ${since}::interval`,
  /** The earliest attempt row, which bounds the witness below. */
  firstAttempt: () => sql`select min(created_at) as t from failures`,
  /*
   * Both shapes of the witness query, because they are different SQL and
   * the bounded one is the newer of the two. Counting everything was what
   * made the first real run shout about calls made before the table existed.
   */
  billed: () => sql`
    select count(*)::int as n from usage_events
    where kind in ('tailor','instruct') and created_at > now() - ${since}::interval`,
  billedBounded: () => sql`
    select count(*)::int as n from usage_events
    where kind in ('tailor','instruct')
      and created_at > now() - ${since}::interval
      and created_at >= (select coalesce(min(created_at), now() - ${since}::interval) from failures)`,
  byKind: () => sql`
    select kind,
           count(*)::int as n,
           count(*) filter (where ok is false)::int as failed,
           count(*) filter (where ${KILLED as never})::int as unfinished
    from failures where created_at > now() - ${since}::interval
    group by kind order by failed desc, n desc`,
  byStage: () => sql`
    select stage, fault, count(*)::int as n, count(*) filter (where refunded)::int as refunded
    from failures
    where created_at > now() - ${since}::interval and ok is false
    group by stage, fault order by n desc`,
  unrefunded: () => sql`
    select created_at, kind, stage, fault, reason, refunded from failures
    where created_at > now() - ${since}::interval and ok is false and not refunded and kind = 'tailor'
    order by created_at desc limit 10`,
  recent: () => sql`
    select created_at, kind, stage, fault, reason, refunded from failures
    where created_at > now() - ${since}::interval and ok is false
    order by created_at desc limit 12`,
});

async function main() {
  const env = Object.fromEntries(
    fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
      .split('\n')
      .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
      .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]),
  );
  const sql = postgres(env.DATABASE_URL, { prepare: false, max: 1 });
  const since = '14 days';
  let failures = 0;

  const run = async (db: Queryable, label: string) => {
    console.log(`\n── ${label}`);
    const q = QUERIES(db, db.unsafe(killedPredicate()), since);
    const out: Record<string, unknown[]> = {};
    for (const [name, query] of Object.entries(q)) {
      try {
        const rows = await query();
        out[name] = rows as unknown[];
        console.log(`   ok    ${name.padEnd(12)} ${rows.length} row(s)`);
      } catch (err) {
        failures += 1;
        const e = err as { code?: string; message?: string };
        console.log(`   FAIL  ${name.padEnd(12)} ${e.code ?? ''} ${(e.message ?? '').split('\n')[0]}`);
        out[name] = [];
      }
    }

    /*
     * And the printing, with the rows those queries actually returned —
     * `.toISOString()` on a real timestamp, padding on a real null fault.
     * Captured rather than printed so a failure here is a thrown error
     * rather than noise in the middle of the check.
     */
    const lines: string[] = [];
    try {
      const totals = (out.totals[0] ?? { attempts: 0, ok: 0, failed: 0, unfinished: 0 }) as Totals;
      const from = (out.firstAttempt[0] as { t: Date | null } | undefined)?.t ?? null;
      const billed =
        ((from ? out.billedBounded[0] : out.billed[0]) as { n: number } | undefined)?.n ?? 0;
      report({
        days: 14,
        billed,
        totals,
        byKind: out.byKind as KindRow[],
        byStage: out.byStage as StageRow[],
        unrefunded: out.unrefunded as FailureRow[],
        recent: out.recent as FailureRow[],
        countedFrom: from,
        log: (line) => lines.push(line),
      });
      console.log(`   ok    report       ${lines.length} line(s) rendered`);
    } catch (err) {
      failures += 1;
      console.log(`   FAIL  report       ${(err as Error).message}`);
    }
    return lines;
  };

  await run(sql, 'EMPTY — the real table, as it stands');

  /*
   * The populated half. Seven rows covering every branch the report has: a
   * success, failures at three stages with three faults, one refunded and
   * one not, and two still open — one older than its route's limit and one
   * well inside it, so the killed threshold is exercised in both directions.
   */
  const [owner] = await sql`select id from users where deleted_at is null order by created_at limit 1`;
  let printed: string[] = [];
  await sql
    .begin(async (tx) => {
      await tx`insert into failures (user_id, kind, stage, fault, reason, refunded, finished_at, ok, created_at) values
        (${owner.id}, 'tailor',   'done',           null,       null,                        false, now(), true,  now() - interval '1 hour'),
        (${owner.id}, 'tailor',   'guard_unusable', 'model',    'Error: No entry matched',    true,  now(), false, now() - interval '2 hours'),
        (${owner.id}, 'tailor',   'save',           'app',      'Error: insert failed',       false, now(), false, now() - interval '3 hours'),
        (${owner.id}, 'instruct', 'model',          'model',    'Error: nothing came back',   false, now(), false, now() - interval '4 hours'),
        (${owner.id}, 'compile',  'compile',        'upstream', 'LatexCompileError: busy',    false, now(), false, now() - interval '5 hours'),
        (${owner.id}, 'tailor',   'model',          null,       null,                         false, null,  null,  now() - interval '10 minutes'),
        (${owner.id}, 'tailor',   'model',          null,       null,                         false, null,  null,  now() - interval '30 seconds')`;
      printed = await run(tx, 'POPULATED — seven rows, inside a rolled-back transaction');
      throw new Error('__rollback__');
    })
    .catch((err: Error) => {
      if (err.message !== '__rollback__') throw err;
    });

  console.log('\n── what the populated run printed\n');
  for (const line of printed) console.log(line.replace(/^/gm, '  '));

  const [{ n }] = await sql`select count(*)::int as n from failures`;
  console.log(`\nrows left in failures: ${n} ${n === 0 ? '(rolled back cleanly)' : '*** THE ROLLBACK DID NOT TAKE ***'}`);
  if (n !== 0) failures += 1;

  await sql.end();
  console.log(failures ? `\n${failures} check(s) FAILED\n` : '\nevery query and the report ran clean\n');
  if (failures) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
