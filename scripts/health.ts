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
 */
import postgres from 'postgres';
import fs from 'node:fs';

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

  const pad = (s: unknown, n: number) => String(s ?? '').padEnd(n);
  const num = (s: unknown, n: number) => String(s ?? '').padStart(n);

  /*
   * How long a request of each kind is allowed to take, from the route's own
   * `maxDuration`. An attempt is only KILLED once it has outlived that — a
   * row open for thirty seconds is a tailor still running, and calling it a
   * casualty would report every request in flight as a failure.
   *
   * Plus a minute, because the platform stops a function at its limit rather
   * than at the instant the limit passes, and a clock skew of seconds
   * between the app and the database should not invent a corpse.
   */
  const MAX_SECONDS: Record<string, number> = { tailor: 120, instruct: 120, compile: 60, preview: 60 };
  const GRACE = 60;
  const killedAfter = `greatest(coalesce((${Object.entries(MAX_SECONDS)
    .map(([k, v]) => `case when kind = '${k}' then ${v} end`)
    .join(', ')}), 120) + ${GRACE}, 0)`;
  /** True for a row that opened, never closed, and has outlived its route. */
  const KILLED = sql.unsafe(
    `finished_at is null and created_at < now() - make_interval(secs => ${killedAfter})`,
  );

  console.log(`\n══ Resumi9 health, last ${days} days ══\n`);

  /*
   * Said plainly, because the alternative is a parse_relation.c stack trace
   * for the entirely ordinary situation of the migration not being run yet.
   */
  const [present] = await sql`select to_regclass('public.failures') is not null as ok`;
  if (!present.ok) {
    console.log('The `failures` table does not exist on this database yet.');
    console.log('Apply drizzle/0012_failures.sql, then run this again.\n');
    console.log('The app is safe to deploy before that: beginAttempt and endAttempt');
    console.log('swallow their own errors, so a missing table logs to the console and');
    console.log('records nothing rather than failing anybody\'s tailor.\n');
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
   * An empty table means one of two things and they are opposites.
   *
   * Either nothing ran, or everything ran and the logger is broken —
   * beginAttempt swallows its own errors by design, so a failed insert is a
   * line on a server console nobody is reading. usage_events is the
   * independent witness: it is written by a different function on a
   * different path, so a tailor there with no attempt row here is the
   * logger being quietly dead. Reporting that as "no failures" would be
   * worse than printing nothing at all.
   */
  const [billed] = await sql`
    select count(*)::int as n from usage_events
    where kind in ('tailor','instruct') and created_at > now() - ${since}::interval`;

  if (!totals.attempts) {
    if (billed.n > 0) {
      console.log(`⚠ NOT a clean bill of health.\n`);
      console.log(`${billed.n} tailor/instruct model call(s) were billed in this window and NOT ONE`);
      console.log('opened an attempt row. Either the migration has not reached this database');
      console.log('or beginAttempt is failing silently — it swallows its own errors on purpose,');
      console.log('so the only symptom is this mismatch. Check the server logs for');
      console.log("'Could not open an attempt row'.\n");
      process.exitCode = 1;
      await sql.end();
      return;
    }
    console.log('No attempts recorded, and no model calls billed either — nothing ran.\n');
    await sql.end();
    return;
  }

  /*
   * The same check when the table is merely thin rather than empty: far
   * fewer attempts than billed calls is the logger dropping writes.
   */
  if (billed.n > totals.attempts * 2 && billed.n - totals.attempts > 5) {
    console.log(`⚠ ${billed.n} billed tailor/instruct calls but only ${totals.attempts} attempt rows.`);
    console.log('   The logger is dropping writes; the numbers below undercount.\n');
    process.exitCode = 1;
  }

  const rate = ((totals.failed / totals.attempts) * 100).toFixed(1);
  console.log(`attempts ${totals.attempts}   ok ${totals.ok}   failed ${totals.failed} (${rate}%)   unfinished ${totals.unfinished}`);
  /*
   * Unfinished is the number nothing else can show. A request the platform
   * kills runs no catch block, so it never reports anything — the row that
   * opened and never closed is the only trace it leaves.
   */
  if (totals.unfinished) {
    console.log(`         ${totals.unfinished} opened and never closed — killed mid-flight, not caught by any handler`);
  }

  const byKind = await sql`
    select kind,
           count(*)::int as n,
           count(*) filter (where ok is false)::int as failed,
           count(*) filter (where ${KILLED})::int as unfinished
    from failures where created_at > now() - ${since}::interval
    group by kind order by failed desc, n desc`;
  console.log('\nby kind');
  for (const r of byKind as any[]) {
    console.log(`   ${pad(r.kind, 10)} ${num(r.n, 5)} attempts  ${num(r.failed, 4)} failed  ${num(r.unfinished, 4)} unfinished`);
  }

  const byStage = await sql`
    select stage, fault, count(*)::int as n, count(*) filter (where refunded)::int as refunded
    from failures
    where created_at > now() - ${since}::interval and ok is false
    group by stage, fault order by n desc`;
  if (byStage.length) {
    console.log('\nwhere they failed');
    for (const r of byStage as any[]) {
      console.log(`   ${pad(r.stage, 16)} ${pad(r.fault ?? '?', 9)} ${num(r.n, 4)}   refunded ${r.refunded}/${r.n}`);
    }
  }

  /*
   * A failure that took the credit is the one somebody writes in about. The
   * refund is meant to be exhaustive, so anything here is a bug.
   */
  const unrefunded = await sql`
    select kind, stage, reason, created_at from failures
    where created_at > now() - ${since}::interval and ok is false and not refunded and kind = 'tailor'
    order by created_at desc limit 10`;
  if (unrefunded.length) {
    console.log(`\n⚠ ${unrefunded.length} tailor failure(s) with no refund recorded:`);
    for (const r of unrefunded as any[]) {
      console.log(`   ${r.created_at.toISOString().slice(0, 16)}  ${pad(r.stage, 16)} ${String(r.reason ?? '').slice(0, 70)}`);
    }
  }

  const recent = await sql`
    select created_at, kind, stage, fault, reason, refunded from failures
    where created_at > now() - ${since}::interval and ok is false
    order by created_at desc limit 12`;
  if (recent.length) {
    console.log('\nmost recent');
    for (const r of recent as any[]) {
      console.log(`   ${r.created_at.toISOString().slice(0, 16)}  ${pad(r.kind, 9)} ${pad(r.stage, 16)} ${pad(r.fault ?? '?', 9)} ${r.refunded ? 'refunded' : '        '}  ${String(r.reason ?? '').slice(0, 64)}`);
    }
  }

  /*
   * The denominator the table cannot see. Until every route writes an
   * attempt row for its successes too, a failure rate computed from this
   * table alone flatters itself.
   */
  console.log(`\nfor scale: ${billed.n} billed tailor/instruct model calls in the same window\n`);

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
