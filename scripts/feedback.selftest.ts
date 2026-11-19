/**
 * Every feedback query, and a real image round-trip, against the real database.
 *
 *   npx tsx scripts/feedback.selftest.ts          # against the live tables
 *   npx tsx scripts/feedback.selftest.ts --dry    # and apply 0013 first
 *
 * It exists for the same reason scripts/health.selftest.ts does: the first
 * real run of health.ts died on a SQL error nobody had executed, because the
 * queries had been typechecked, reviewed and committed and never run. A query
 * is not code until a database has seen it. An upload is not code until bytes
 * have gone in and come back out.
 *
 * Unlike that one, this calls the APP'S OWN functions rather than restating
 * their SQL — `saveFeedback`, `listFeedbackAcrossUsers` and the rest, exactly
 * as the route and the inbox call them. Restated SQL can drift from the real
 * query; this cannot.
 *
 * **IT WRITES NOTHING, IN EITHER MODE.** Everything runs inside one
 * transaction that always rolls back, and every repository call is handed
 * that transaction rather than the pool.
 *
 * That last part is the whole correctness of this file, and it was wrong
 * once. The transaction used to be opened with a raw `begin` on the shared
 * connection, and the functions under test still used the pool — so
 * `saveFeedback`'s own `db.transaction()` issued a second `begin` that
 * Postgres ignored and a `commit` that ended the OUTER one. A `--dry` run
 * committed the migration it was meant to be proving. Handed the transaction,
 * drizzle makes that nested call a SAVEPOINT instead, whose release cannot
 * end anything but itself.
 *
 * The second thing that cost a round trip: **`now()` is frozen to the start
 * of the transaction.** A row inserted in here has `created_at` exactly equal
 * to `now()`, which is inside even a zero-length window — so a time window
 * cannot be tested with a freshly inserted row. The attempts below are given
 * explicit ages for that reason.
 *
 * One thing a rollback does NOT undo: a sequence. The `failures` ids this
 * burns through are gone for good, which costs nothing but is worth knowing
 * before somebody reads the table and wonders about the gaps.
 */
import fs from 'node:fs';
import { deflateSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { sql } from 'drizzle-orm';
import { db } from '../app/server/db/client';
import {
  countFeedbackAcrossUsers,
  countFeedbackFrom,
  getFeedbackShotAcrossUsers,
  hasApplication,
  latestAttemptFor,
  listFeedbackAcrossUsers,
  markFeedbackSeen,
  saveFeedback,
  storedShotBytes,
  type Executor,
} from '../app/server/db/repository';
import { sniffImage, storeLimitBytes } from '../app/server/feedback';
import { MAX_SHOT_BYTES, MAX_STORE_BYTES, MAX_TOTAL_BYTES } from '../app/lib/feedback';

/** The app's own .env.local, since a script has no Next.js to load it. */
function loadEnv(): void {
  if (process.env.DATABASE_URL) return;
  const file = new URL('../.env.local', import.meta.url);
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('=') || line.trim().startsWith('#')) continue;
    const at = line.indexOf('=');
    const key = line.slice(0, at).trim();
    if (!process.env[key]) process.env[key] = line.slice(at + 1).trim().replace(/^["']|["']$/g, '');
  }
}

const dry = process.argv.includes('--dry');
let failed = 0;
const ok = (label: string, condition: boolean, detail = '') => {
  console.log(`   ${condition ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!condition) failed += 1;
};

/** Thrown at the end of the transaction, so there is only one way out of it. */
class Rollback extends Error {}

/**
 * A real PNG, written out by hand.
 *
 * Nothing in this project can encode an image — no canvas, no image library —
 * and a buffer with a PNG header and noise behind it would pass every check
 * in the code while proving nothing about the bytes a browser can display.
 * So: signature, IHDR, one deflated IDAT, IEND, with a CRC on each chunk. The
 * result opens in a viewer, which is the point.
 */
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([head, typed, crc]);
}

function png(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // 8 bits per channel
  ihdr[9] = 2;   // truecolour RGB
  // A gradient rather than a flat fill, so the deflated size is realistic
  // rather than a few hundred bytes of run-length.
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const at = row + 1 + x * 3;
      raw[at] = (x * 255) / width;
      raw[at + 1] = (y * 255) / height;
      raw[at + 2] = (x ^ y) & 0xff;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Everything, against whichever executor it is handed. */
async function checks(tx: Executor, stamp: number): Promise<void> {
  const userId = `user_fbselftest_${stamp}`;
  const applicationId = `app_fbselftest_${stamp}`;

  await tx.execute(sql`
    insert into users (id, email, display_name)
    values (${userId}, ${`${userId}@selftest.invalid`}, 'Feedback self-test')`);
  await tx.execute(sql`
    insert into applications (id, user_id, status) values (${applicationId}, ${userId}, 'draft')`);

  /*
   * Two attempts, with explicit ages rather than defaults.
   *
   * `now()` is the transaction's start time, so a row inserted here and a row
   * inserted a microsecond later carry the SAME created_at — which makes
   * every window inclusive and every ordering a coin toss. Ages stated
   * outright are the only way either can be tested from in here.
   */
  const [older] = (await tx.execute(sql`
    insert into failures (user_id, application_id, kind, stage, fault, reason, refunded, finished_at, ok, created_at)
    values (${userId}, ${applicationId}, 'tailor', 'guard_unusable', 'model', 'Error: came back unusable', true, now(), false, now() - interval '3 hours')
    returning id`)) as unknown as [{ id: number }];
  const [newer] = (await tx.execute(sql`
    insert into failures (user_id, application_id, kind, stage, fault, reason, refunded, finished_at, ok, created_at)
    values (${userId}, null, 'instruct', 'model', 'model', 'Error: nothing came back', false, now(), false, now() - interval '10 minutes')
    returning id`)) as unknown as [{ id: number }];
  const old = Number(older.id);
  const recent = Number(newer.id);

  // ── the reads the route does before it writes ───────────────────────────
  console.log('\n── what the route reads before it stores anything');
  ok('hasApplication finds their own', await hasApplication(userId, applicationId, tx));
  ok("hasApplication refuses somebody else's", (await hasApplication('user_someone_else', applicationId, tx)) === false);

  /*
   * The window and the ordering, which were both untested until a `--dry`
   * run reported the window broken. It was not: the row was simply the same
   * age as `now()`. These four cases pin the behaviour down.
   */
  const inShortWindow = await latestAttemptFor(userId, applicationId, 120, tx);
  ok('a 2-hour window excludes the 3-hour-old attempt', inShortWindow === recent,
    `got ${inShortWindow}, wanted the 10-minute-old ${recent}`);
  const inLongWindow = await latestAttemptFor(userId, applicationId, 240, tx);
  ok('a 4-hour window prefers the one on the same application', inLongWindow === old,
    `got ${inLongWindow}, wanted the matching ${old}`);
  const noApplication = await latestAttemptFor(userId, null, 240, tx);
  ok('and with no application, the most recent of any', noApplication === recent, `got ${noApplication}`);
  ok('a 5-minute window reaches neither', (await latestAttemptFor(userId, applicationId, 5, tx)) === null);
  ok('somebody with no attempts gets null', (await latestAttemptFor('user_nobody', null, 120, tx)) === null);

  // ── storing it, with a real image ───────────────────────────────────────
  console.log('\n── storing it');
  const image = png(900, 600);
  ok('the generated PNG is a PNG', sniffImage(image) === 'image/png', `${image.byteLength} bytes`);

  const signedOut = await saveFeedback({
    userId: null, applicationId: null, kind: 'idea',
    message: 'Self-test: a signed-out visitor with no account and no screenshot.',
    email: 'stranger@selftest.invalid', pageUrl: 'https://www.resumi9.com/',
    userAgent: 'selftest', viewport: '1512x982 @2x', appVersion: 'selftest',
    attemptId: null, sender: 'ip_selftest', shots: [],
  }, tx);
  ok('a row with no owner at all is stored', Boolean(signedOut.id), signedOut.id);
  /*
   * Aged by hand, for the same reason the attempts above were: both reports
   * are written inside this transaction and so carry an identical
   * `created_at`, which makes "newest first" untestable and — before the
   * tiebreak went into the query — genuinely undefined.
   */
  await tx.execute(sql`update feedback set created_at = now() - interval '5 minutes' where id = ${signedOut.id}`);

  const small = png(40, 40);
  const signedIn = await saveFeedback({
    userId, applicationId, kind: 'bug',
    message: 'Self-test: signed in, on an application, with two screenshots.\nSecond line.',
    email: null, pageUrl: `https://www.resumi9.com/applications/${applicationId}`,
    userAgent: 'selftest', viewport: '1512x982 @2x', appVersion: 'selftest',
    attemptId: recent, sender: userId,
    shots: [
      { contentType: 'image/png', bytes: image },
      { contentType: 'image/png', bytes: small },
    ],
  }, tx);
  ok('a row with two screenshots is stored', Boolean(signedIn.id), signedIn.id);
  // The proof that saveFeedback's own transaction became a savepoint: if its
  // commit had ended the outer transaction, everything from here on would be
  // running outside one — and the rollback at the end would find nothing.
  ok('and did not end the transaction it was handed',
    (await tx.execute(sql`select txid_current_if_assigned() is not null as inside`) as unknown as [{ inside: boolean }])[0].inside);

  // ── the rate limit's queries ────────────────────────────────────────────
  console.log('\n── the rate limit');
  ok('countFeedbackFrom counts this sender', (await countFeedbackFrom(userId, 10, tx)) === 1);
  ok('and nobody else', (await countFeedbackFrom('ip_nobody', 10, tx)) === 0);
  const global = await countFeedbackAcrossUsers(60, tx);
  ok('countFeedbackAcrossUsers sees both', global >= 2, `${global} in the last hour`);

  // ── how much room is left ───────────────────────────────────────────────
  console.log('\n── the store cap');
  const stored = await storedShotBytes(tx);
  ok('storedShotBytes is the sum of what went in', stored >= image.byteLength + small.byteLength,
    `${stored} bytes held`);
  ok('a full submission cannot fill the store on its own', MAX_TOTAL_BYTES * 50 < storeLimitBytes(),
    `${storeLimitBytes()} byte ceiling, ${MAX_TOTAL_BYTES} per submission`);
  ok('the ceiling leaves most of the database to the product', MAX_STORE_BYTES < 300_000_000);
  ok('one image can never exceed one submission', MAX_SHOT_BYTES <= MAX_TOTAL_BYTES);

  // ── the inbox ───────────────────────────────────────────────────────────
  console.log('\n── the inbox');
  const list = await listFeedbackAcrossUsers(200, tx);
  const mine = list.find((row) => row.id === signedIn.id);
  const theirs = list.find((row) => row.id === signedOut.id);
  ok('both rows come back', Boolean(mine && theirs));
  ok('newest first', list.findIndex((r) => r.id === signedIn.id) < list.findIndex((r) => r.id === signedOut.id));
  ok('and the order is stable when two share a timestamp',
    (await listFeedbackAcrossUsers(200, tx)).map((r) => r.id).join() === list.map((r) => r.id).join());
  ok('the account email is joined on, to reply to', mine?.accountEmail === `${userId}@selftest.invalid`, String(mine?.accountEmail));
  ok('a signed-out row shows the address they typed', theirs?.email === 'stranger@selftest.invalid');
  ok('a signed-out row has no account email', theirs?.accountEmail === null);
  ok('the failed attempt is joined on', mine?.attempt?.stage === 'model', JSON.stringify(mine?.attempt));
  ok('both screenshots are listed', mine?.shots.length === 2, `${mine?.shots.length}`);
  ok('and their sizes, without reading the bytes', mine?.shots.some((s) => s.byteSize === image.byteLength) === true);
  ok('a row with no screenshots lists none', theirs?.shots.length === 0);
  ok('newlines survive the round trip', mine?.message.includes('\nSecond line.') === true);

  // ── the bytes ───────────────────────────────────────────────────────────
  console.log('\n── the image, byte for byte');
  const big = mine!.shots.find((s) => s.byteSize === image.byteLength)!;
  const read = await getFeedbackShotAcrossUsers(big.id, tx);
  ok('the shot comes back', Boolean(read));
  ok('with the content type it went in with', read?.contentType === 'image/png');
  ok('and exactly the bytes that went in', Boolean(read && Buffer.compare(read.bytes, image) === 0),
    `${read?.bytes.byteLength} of ${image.byteLength}`);
  ok('an unknown shot id is a null, not a throw', (await getFeedbackShotAcrossUsers('fbs_nope', tx)) === null);

  const out = `/tmp/resumi9-feedback-selftest-${stamp}.png`;
  fs.writeFileSync(out, read!.bytes);
  console.log(`   ok    wrote the round-tripped image to ${out}`);

  // ── seen ────────────────────────────────────────────────────────────────
  console.log('\n── marking it read');
  await markFeedbackSeen(signedIn.id, true, tx);
  ok('seen_at is set', Boolean((await listFeedbackAcrossUsers(200, tx)).find((r) => r.id === signedIn.id)?.seenAt));
  await markFeedbackSeen(signedIn.id, false, tx);
  ok('and cleared again', (await listFeedbackAcrossUsers(200, tx)).find((r) => r.id === signedIn.id)?.seenAt === null);

  // ── the cascades ────────────────────────────────────────────────────────
  console.log('\n── what deleting things takes with it');
  await tx.execute(sql`delete from applications where id = ${applicationId}`);
  const afterApp = (await listFeedbackAcrossUsers(200, tx)).find((r) => r.id === signedIn.id);
  ok('deleting the application keeps the report', Boolean(afterApp));
  ok('and nulls its application id rather than cascading', afterApp?.applicationId === null);

  const heldBefore = await storedShotBytes(tx);
  await tx.execute(sql`delete from users where id = ${userId}`);
  const afterUser = await listFeedbackAcrossUsers(200, tx);
  ok('deleting the account removes their report', !afterUser.some((r) => r.id === signedIn.id));
  ok('and the screenshots with it', (await storedShotBytes(tx)) === heldBefore - image.byteLength - small.byteLength);
  ok('but not the report that belonged to nobody', afterUser.some((r) => r.id === signedOut.id),
    'no account deletion can reach a signed-out report — see BACKLOG.md');
}

async function main() {
  loadEnv();
  const stamp = Date.now();

  const [state] = (await db.execute(sql`
    select to_regclass('public.feedback') is not null as a,
           to_regclass('public.feedback_shots') is not null as b
  `)) as unknown as [{ a: boolean; b: boolean }];
  const applied = state.a && state.b;

  if (dry && applied) {
    console.log('\nThe feedback tables are already on this database, so --dry has nothing to');
    console.log('prove: the migration would be a no-op and the rollback would not restore');
    console.log('anything. Run it without --dry.\n');
    return;
  }
  if (!dry && !applied) {
    console.log('\nThe feedback tables do not exist on this database yet.');
    console.log('Run this with --dry to apply drizzle/0013_feedback.sql inside a transaction');
    console.log('that is rolled back afterwards, or apply it and run this again.\n');
    return;
  }

  const before = applied
    ? await db.execute(sql`
        select (select count(*)::int from feedback) as feedback,
               (select count(*)::int from feedback_shots) as shots,
               (select count(*)::int from users) as users`)
    : null;

  /*
   * One transaction, and the only way out of it is the throw at the end.
   *
   * `db.transaction` rather than a raw `begin`, so that every nested
   * transaction inside — `saveFeedback` has one — becomes a savepoint on
   * this one instead of a commit that ends it.
   */
  await db
    .transaction(async (tx) => {
      if (dry) {
        console.log('\n── drizzle/0013_feedback.sql, inside a transaction that will be rolled back');
        await tx.execute(sql.raw(fs.readFileSync(new URL('../drizzle/0013_feedback.sql', import.meta.url), 'utf8')));
        const [made] = (await tx.execute(sql`
          select to_regclass('public.feedback') is not null as a,
                 to_regclass('public.feedback_shots') is not null as b,
                 (select relrowsecurity from pg_class where relname = 'feedback') as rls,
                 (select relrowsecurity from pg_class where relname = 'feedback_shots') as rls2,
                 (select count(*)::int from pg_policies where tablename in ('feedback','feedback_shots')) as policies
        `)) as unknown as [{ a: boolean; b: boolean; rls: boolean; rls2: boolean; policies: number }];
        ok('both tables exist', made.a && made.b);
        ok('row level security is on, on both', made.rls === true && made.rls2 === true);
        ok('with no client policies at all', made.policies === 0, `${made.policies} policies`);
        const grants = (await tx.execute(sql`
          select grantee from information_schema.role_table_grants
          where table_name in ('feedback','feedback_shots') and grantee in ('anon','authenticated')
        `)) as unknown as unknown[];
        ok('anon and authenticated hold no grant', grants.length === 0, `${grants.length} grants`);
      }

      await checks(tx, stamp);
      throw new Rollback();
    })
    .catch((error: unknown) => {
      if (!(error instanceof Rollback)) throw error;
    });

  // ── and none of it happened ─────────────────────────────────────────────
  console.log('\n── and none of it happened');
  const [now] = (await db.execute(sql`
    select to_regclass('public.feedback') is not null as exists,
           (select count(*)::int from users where id like 'user_fbselftest_%') as leftover
  `)) as unknown as [{ exists: boolean; leftover: number }];
  ok('no throwaway account was left behind', now.leftover === 0);
  if (dry) {
    ok('the tables the migration made are gone again', now.exists === false);
  } else {
    const [after] = (await db.execute(sql`
      select (select count(*)::int from feedback) as feedback,
             (select count(*)::int from feedback_shots) as shots,
             (select count(*)::int from users) as users`)) as unknown as [
      { feedback: number; shots: number; users: number },
    ];
    const was = (before as unknown as [{ feedback: number; shots: number; users: number }])[0];
    ok('no feedback row was committed', after.feedback === was.feedback, `${was.feedback} → ${after.feedback}`);
    ok('no screenshot was committed', after.shots === was.shots, `${was.shots} → ${after.shots}`);
    ok('no account was committed', after.users === was.users, `${was.users} → ${after.users}`);
  }

  console.log(failed ? `\n${failed} check(s) FAILED\n` : '\nevery query, the image and both cascades ran clean\n');
  if (failed) process.exitCode = 1;
}

/*
 * Only when run, never when imported — the same guard health.ts carries, for
 * the same reason: a module that does its work on import is a module nothing
 * can reuse.
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then(() => process.exit(process.exitCode ?? 0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
