/**
 * Renders the feedback inbox from real rows, as a page you can actually use.
 *
 *   npx tsx scripts/inbox.render.ts            # writes /tmp/resumi9-inbox
 *   npx tsx scripts/inbox.render.ts --serve    # and serves it, to click around
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
 * **It is a real page, not a picture of one.** The client bundle is built
 * with esbuild and mounted, the screenshots are served from the bytes that
 * are really in the table, and the server actions are stubbed — so rows open,
 * filters filter and the lightbox opens, under a mouse, in a browser. A
 * static render would have proved the markup and none of the behaviour, and
 * behaviour is where the last one broke.
 *
 * **It writes nothing to the database.** The three reports it needs are
 * inserted inside a transaction that always rolls back, alongside whatever is
 * really in the table.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sql } from 'drizzle-orm';
import { png } from './feedback.selftest';
import { db } from '../app/server/db/client';
import {
  getFeedbackShotAcrossUsers,
  listFeedbackAcrossUsers,
  saveFeedback,
  type Executor,
} from '../app/server/db/repository';

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

/**
 * The client bundle, built the way Next builds it.
 *
 * `jsx: 'automatic'` is set here rather than read from the app's tsconfig,
 * which says `preserve` because Next does the transform. esbuild reading that
 * falls back to the classic runtime and emits `React.createElement` calls
 * into a bundle that never imports React.
 *
 * The server actions are stubbed at resolve time. They are the one import in
 * a client component that reaches the database, and bundling them for a
 * browser would drag drizzle and a Postgres driver in with them.
 */
async function bundle(into: string): Promise<void> {
  const esbuild = await import('esbuild');
  const tmp = path.join(into, '.entry');
  fs.mkdirSync(tmp, { recursive: true });

  const stub = path.join(tmp, 'actions.stub.ts');
  fs.writeFileSync(
    stub,
    'export const setFeedbackSeen = async () => {};\n' +
    'export const markEverythingSeen = async () => 0;\n',
  );

  const entry = path.join(tmp, 'entry.tsx');
  fs.writeFileSync(
    entry,
    `import { createRoot } from 'react-dom/client';
` +
    `import InboxList from '${path.join(process.cwd(), 'app/admin/feedback/InboxList')}';
` +
    `const items = JSON.parse(document.getElementById('items')!.textContent!);
` +
    `createRoot(document.getElementById('list')!).render(<InboxList items={items} />);
`,
  );

  try {
    await esbuild.build({
      entryPoints: [entry],
      outfile: path.join(into, 'app.js'),
      bundle: true,
      format: 'iife',
      /*
       * The entry is written beside the OUTPUT, which may be anywhere — so
       * resolution has to be told where the project's modules live rather
       * than walking up from a scratch directory that has no node_modules
       * above it.
       */
      absWorkingDir: process.cwd(),
      nodePaths: [path.join(process.cwd(), 'node_modules')],
      jsx: 'automatic',
      loader: { '.ts': 'ts', '.tsx': 'tsx' },
      define: { 'process.env.NODE_ENV': '"production"' },
      logLevel: 'warning',
      plugins: [
        {
          name: 'stub-server-actions',
          setup(build: import('esbuild').PluginBuild) {
            build.onResolve({ filter: /server\/actions$/ }, () => ({ path: stub }));
          },
        },
      ],
    });
  } catch (error) {
    // esbuild's own message, not the wrapper's stack, which says nothing.
    for (const problem of (error as { errors?: { text: string; location?: { file: string; line: number } }[] }).errors ?? []) {
      console.error(`   esbuild: ${problem.text}${problem.location ? `  (${problem.location.file}:${problem.location.line})` : ''}`);
    }
    throw error;
  }

  fs.rmSync(tmp, { recursive: true, force: true });
}

/** A static server, so `/api/feedback/shot/<id>` resolves like it does live. */
function serve(from: string, port: number): void {
  http
    .createServer((request, response) => {
      const asked = decodeURIComponent((request.url ?? '/').split('?')[0]);
      const file = path.join(from, asked === '/' ? 'index.html' : asked);
      if (!file.startsWith(from) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        response.writeHead(404).end('not found');
        return;
      }
      const type = file.endsWith('.html') ? 'text/html'
        : file.endsWith('.js') ? 'text/javascript'
        : file.endsWith('.png') ? 'image/png'
        : 'image/jpeg';
      response.writeHead(200, { 'content-type': type }).end(fs.readFileSync(file));
    })
    .listen(port, () => console.log(`\nserving http://127.0.0.1:${port}  (ctrl-c to stop)\n`));
}

/** Written into the output directory, and the only thing that licenses a delete. */
const MARKER = '.resumi9-render';

/**
 * Where to write, taken from the arguments the user actually typed.
 *
 * This was `process.argv.find((arg) => arg.startsWith('/'))`, and
 * **process.argv[0] is the path of the node executable** — which starts with
 * a slash. Run with no output argument, this script resolved its output
 * directory to /opt/homebrew/Cellar/node/25.4.0/bin/node, deleted it
 * recursively, and created its own folder in its place. It destroyed the node
 * installation it was running on, and every tool on this machine stopped
 * working at once.
 *
 * argv[0] is the interpreter and argv[1] is the script. Only slice(2) is
 * anything a person typed, and that is the whole of the lesson.
 */
function outputDirectory(): string {
  const given = process.argv.slice(2).find((arg) => !arg.startsWith('-'));
  return path.resolve(given ?? '/tmp/resumi9-inbox');
}

/**
 * An empty output directory, or a refusal.
 *
 * Two conditions before anything is deleted, because `rmSync` with
 * `recursive` and `force` is the most destructive call in Node and a wrong
 * path reaching it is unrecoverable:
 *
 *   - it must be somewhere a scratch directory belongs, and
 *   - it must either not exist, or be a directory this script made — which
 *     is what the marker file proves. A directory full of somebody else's
 *     files, or a FILE where a directory was expected, stops the script.
 *
 * Either of these alone would have prevented what happened; both are here
 * because the argument parsing above also looked obviously correct.
 */
function resetDirectory(out: string): void {
  const allowed = ['/tmp/', '/private/tmp/', `${process.cwd()}/`];
  if (!allowed.some((root) => out.startsWith(root))) {
    throw new Error(
      `Refusing to write to ${out}: an output directory must be under /tmp or the working directory.`,
    );
  }

  if (fs.existsSync(out)) {
    if (!fs.statSync(out).isDirectory()) {
      throw new Error(`Refusing to delete ${out}: it is a file, not a directory this script made.`);
    }
    if (!fs.existsSync(path.join(out, MARKER))) {
      throw new Error(
        `Refusing to delete ${out}: no ${MARKER} in it, so this script did not create it.`,
      );
    }
    fs.rmSync(out, { recursive: true, force: true });
  }

  fs.mkdirSync(path.join(out, 'api/feedback/shot'), { recursive: true });
  fs.writeFileSync(path.join(out, MARKER), 'Written by scripts/inbox.render.ts. Safe to delete.\n');
}

async function main() {
  loadEnv();
  const out = outputDirectory();
  const stamp = Date.now();
  /*
   * The app's tsconfig says `jsx: "preserve"`, because Next does the
   * transform and uses React's automatic runtime. esbuild, which is what runs
   * this file, reads the same setting and falls back to the CLASSIC runtime —
   * so the compiled components call `React.createElement` without importing
   * React. Put on the global rather than fixed with a second tsconfig or a
   * pragma in the components: the app's own build is correct, and this is the
   * script's problem to solve inside the script. Every import below it has to
   * be dynamic for the same reason — a static one is hoisted above this line.
   */
  const React = (await import('react')).default;
  (globalThis as { React?: typeof React }).React = React;

  const { default: Inbox, asItem } = await import('../app/admin/feedback/Inbox');
  const { NavBar } = await import('../app/components/AppNav');
  const { renderToStaticMarkup } = await import('react-dom/server');
  /*
   * The nav uses `useRouter`, which throws outside a mounted app router — so
   * the context it reads is provided with a no-op. The same thing Storybook
   * and the testing libraries do, and the alternative is a hand-copied
   * stand-in header that drifts from the real one the first time either
   * changes.
   */
  const { AppRouterContext } = await import('next/dist/shared/lib/app-router-context.shared-runtime');
  const router = { push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} };

  resetDirectory(out);

  let shell = '';
  let items: unknown[] = [];

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

      /*
       * Both reports are written inside this transaction, so both carry the
       * same `created_at` — `now()` is the transaction's start time — and the
       * list's tiebreak is a random id, which made the order differ run to
       * run. Aged by hand so the page renders the same way twice.
       */
      // A signed-out visitor who left an address, with a screenshot.
      const first = await saveFeedback({
        userId: null, applicationId: null, kind: 'confusing',
        message: 'I pasted a job posting and the page just sat there. I waited about a minute and gave up. Not sure if it worked or not.',
        email: 'someone@example.invalid', pageUrl: 'https://resumi9.com/',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36',
        viewport: '1280x720 @1x', appVersion: '87368a0f241c', attemptId: null,
        sender: 'ip_render', shots: [{ contentType: 'image/png', bytes: png(900, 520) }],
      }, tx);
      await tx.execute(sql`update feedback set created_at = now() - interval '4 minutes' where id = ${first.id}`);

      // A signed-in report with no screenshot, sitting beside a failed attempt.
      const second = await saveFeedback({
        userId, applicationId: null, kind: 'bug',
        message: 'Tailoring failed twice in a row and took a credit the first time.',
        email: null, pageUrl: 'https://resumi9.com/applications/app_example',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
        viewport: '1512x857 @2x', appVersion: '87368a0f241c', attemptId: Number(attempt.id),
        sender: userId, shots: [],
      }, tx);
      await tx.execute(sql`update feedback set created_at = now() - interval '12 minutes' where id = ${second.id}`);

      const rows = await listFeedbackAcrossUsers(200, tx);
      console.log(`\nrendering ${rows.length} row(s):`);
      for (const row of rows) {
        console.log(
          `   ${row.id}  ${row.kind.padEnd(9)} ${(row.accountEmail ?? row.email ?? 'no address').padEnd(38)}` +
          ` ${row.shots.length} shot(s)  ${row.attempt ? `attempt: ${row.attempt.stage}` : 'no attempt'}`,
        );
        // The real bytes, under the path the real route serves them at.
        for (const shot of row.shots) {
          const got = await getFeedbackShotAcrossUsers(shot.id, tx);
          if (got) fs.writeFileSync(path.join(out, 'api/feedback/shot', shot.id), got.bytes);
        }
      }

      /*
       * The page is rendered server-side for its shell — the bar, the title,
       * the counts — and the list is left empty for the bundle to mount into,
       * so what is clicked afterwards is the real component with its real
       * state rather than a snapshot of its first frame.
       */
      shell = renderToStaticMarkup(
        React.createElement(
          AppRouterContext.Provider,
          { value: router as never },
          React.createElement(Inbox, {
            rows,
            nav: React.createElement(NavBar, { active: 'account', credits: 7, admin: true }),
          }),
        ),
      );
      // The server's own mapping, not a second copy of it here — a flattening
      // that drifts is a render that proves the wrong thing.
      items = rows.map(asItem);
      throw new Rollback();
    })
    .catch((error: unknown) => {
      if (!(error instanceof Rollback)) throw error;
    });

  const css = stylesheet();
  fs.writeFileSync(
    path.join(out, 'index.html'),
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>Resumi9 feedback inbox</title><style>${css}</style></head>` +
    `<body>${shell}` +
    `<script id="items" type="application/json">${JSON.stringify(items).replace(/</g, '\\u003c')}</script>` +
    `<script src="/app.js"></script></body></html>`,
  );
  await bundle(out);

  const [{ n }] = (await db.execute(sql`select count(*)::int as n from feedback`)) as unknown as [{ n: number }];
  console.log(`\nwrote ${out}/index.html`);
  console.log(`rows actually in feedback afterwards: ${n}`);

  if (process.argv.includes('--serve')) {
    serve(out, 4173);
    await new Promise(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
