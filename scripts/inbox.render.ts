/**
 * Renders the feedback inbox to an HTML file, with real rows.
 *
 *   npx tsx scripts/inbox.render.ts            # writes /tmp/resumi9-inbox.html
 *   npx tsx scripts/inbox.render.ts <path>
 *
 * It exists because the inbox shipped broken. Every query had been run
 * against the real database and every one passed; nothing had ever RENDERED
 * a row. `db.execute` hands back a `timestamptz` as a string, the mapping to
 * FeedbackRow said `as Date` — a promise to the typechecker, not a
 * conversion — and the first real row threw `createdAt.getTime is not a
 * function`. A cast makes a wrong type invisible to everything except the
 * code that finally calls a method on it, and only rendering calls methods.
 *
 * Rendering the real page needs a signed-in admin session, which a script
 * cannot have, so the page was split: it does the asking-who-you-are and the
 * reading, and `Inbox` takes the rows. This hands `Inbox` rows that came back
 * through the real query, so a shape that is wrong in the database is wrong
 * here too.
 *
 * **It writes nothing.** The three reports it needs are inserted inside a
 * transaction that always rolls back, alongside whatever is really in the
 * table. The screenshots are inlined as data URIs from their real bytes, so
 * the picture is the picture somebody actually sent.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { sql } from 'drizzle-orm';
import { png } from './feedback.selftest';
import { db } from '../app/server/db/client';
import {
  getFeedbackShotAcrossUsers,
  listFeedbackAcrossUsers,
  saveFeedback,
  type Executor,
} from '../app/server/db/repository';

/*
 * The app's tsconfig says `jsx: "preserve"`, because Next does the transform
 * and uses React's automatic runtime. esbuild, which is what runs this file,
 * reads the same setting and falls back to the CLASSIC runtime — so the
 * compiled Inbox calls `React.createElement` without importing React.
 *
 * Put on the global rather than fixed with a second tsconfig or a pragma in
 * the component: the app's own build is correct, and this is the script's
 * problem to solve inside the script. The import below has to be dynamic for
 * the same reason — a static one is hoisted above this line.
 */
(globalThis as { React?: typeof React }).React = React;

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

class Rollback extends Error {}

/** The app's compiled stylesheet, so what is rendered is what is served. */
function stylesheet(): string {
  const dir = path.join(process.cwd(), '.next', 'static', 'css');
  if (!fs.existsSync(dir)) {
    console.log('   (no .next/static/css — run `npm run build` first for real styling)');
    return '';
  }
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.css'))
    .map((name) => fs.readFileSync(path.join(dir, name), 'utf8'))
    .join('\n');
}

/** Each `/api/feedback/shot/<id>` swapped for the bytes it would serve. */
async function inlineShots(html: string, on: Executor): Promise<string> {
  const ids = [...new Set([...html.matchAll(/\/api\/feedback\/shot\/([A-Za-z0-9_-]+)/g)].map((m) => m[1]))];
  let out = html;
  for (const id of ids) {
    const shot = await getFeedbackShotAcrossUsers(id, on);
    if (!shot) continue;
    out = out.split(`/api/feedback/shot/${id}`).join(
      `data:${shot.contentType};base64,${shot.bytes.toString('base64')}`,
    );
  }
  return out;
}

async function main() {
  loadEnv();
  const out = process.argv[2] ?? '/tmp/resumi9-inbox.html';
  const stamp = Date.now();
  const { default: Inbox } = await import('../app/admin/feedback/Inbox');
  let html = '';

  await db
    .transaction(async (tx) => {
      const userId = `user_inboxrender_${stamp}`;
      await tx.execute(sql`
        insert into users (id, email, display_name)
        values (${userId}, ${`${userId}@example.invalid`}, 'Render check')`);
      const [attempt] = (await tx.execute(sql`
        insert into failures (user_id, kind, stage, fault, reason, refunded, finished_at, ok, created_at)
        values (${userId}, 'tailor', 'guard_unusable', 'model', 'Error: no entry matched the ranking', true, now(), false, now() - interval '20 minutes')
        returning id`)) as unknown as [{ id: number }];

      // A signed-out visitor who left an address, with a screenshot.
      await saveFeedback({
        userId: null, applicationId: null, kind: 'confusing',
        message: 'I pasted a job posting and the page just sat there. I waited about a minute and gave up. Not sure if it worked or not.',
        email: 'someone@example.invalid', pageUrl: 'https://resumi9.com/',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36',
        viewport: '1280x720 @1x', appVersion: '87368a0f241c', attemptId: null,
        sender: 'ip_render', shots: [{ contentType: 'image/png', bytes: png(1400, 760) }],
      }, tx);

      // A signed-in report with no screenshot, sitting beside a failed attempt.
      await saveFeedback({
        userId, applicationId: null, kind: 'bug',
        message: 'Tailoring failed twice in a row and took a credit the first time.',
        email: null, pageUrl: 'https://resumi9.com/applications/app_example',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
        viewport: '1512x857 @2x', appVersion: '87368a0f241c', attemptId: Number(attempt.id),
        sender: userId, shots: [],
      }, tx);

      const rows = await listFeedbackAcrossUsers(200, tx);
      console.log(`\nrendering ${rows.length} row(s):`);
      for (const row of rows) {
        console.log(
          `   ${row.id}  ${row.kind.padEnd(9)} ${(row.accountEmail ?? row.email ?? 'no address').padEnd(38)}` +
          ` ${row.shots.length} shot(s)  ${row.attempt ? `attempt: ${row.attempt.stage}` : 'no attempt'}`,
        );
      }

      const markup = renderToStaticMarkup(React.createElement(Inbox, { rows }));
      html = await inlineShots(markup, tx);
      throw new Rollback();
    })
    .catch((error: unknown) => {
      if (!(error instanceof Rollback)) throw error;
    });

  fs.writeFileSync(
    out,
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>Resumi9 feedback inbox</title><style>${stylesheet()}</style></head>` +
    `<body>${html}</body></html>`,
  );

  const [{ n }] = (await db.execute(sql`select count(*)::int as n from feedback`)) as unknown as [{ n: number }];
  console.log(`\nwrote ${out}`);
  console.log(`rows actually in feedback afterwards: ${n}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
