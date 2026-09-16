import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { timingSafeEqual, createHash } from 'node:crypto';

const run = promisify(execFile);

/**
 * Turns LaTeX into a PDF, and does nothing else.
 *
 * Deliberately tiny and dependency-free. This container runs a TeX engine,
 * which is a programming language with filesystem access, so the useful
 * security question is not "is the code correct" but "what is reachable if it
 * is not". The answer is kept small: no database credentials, no user data, no
 * API keys, no outbound network at compile time, and a filesystem that holds
 * only the LaTeX bundle and this file.
 *
 * The LaTeX it receives is always produced by the app's own renderer from a
 * stored resume — never accepted from a browser. The token below is what keeps
 * that true in practice.
 */

const PORT = Number(process.env.PORT || 8080);
const TOKEN = process.env.COMPILE_TOKEN;
const TIMEOUT_MS = Number(process.env.COMPILE_TIMEOUT_MS || 15_000);
const MAX_BODY = 512 * 1024;

if (!TOKEN) {
  console.error('COMPILE_TOKEN is not set. Refusing to start an unauthenticated compile service.');
  process.exit(1);
}

/** Compared in constant time so the token cannot be recovered by timing. */
function authorised(header) {
  const given = (header || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(given);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Compiled PDFs, keyed by a hash of the LaTeX that produced them.
 *
 * The same resume compiles to the same bytes every time, and a resume is looked
 * at far more often than it is edited — opening the page, switching tabs,
 * coming back tomorrow. Without this, each of those is a second or two of CPU
 * spent producing a file we already had.
 *
 * In memory and capped. A restart loses it, which costs one recompile, and
 * bounding it matters more than keeping it: this machine has 1GB and a resume
 * is ~35KB, so an unbounded map is a slow memory leak with a deadline.
 */
const CACHE_MAX = Number(process.env.COMPILE_CACHE_MAX || 200);
const cache = new Map();

/**
 * How many pages the engine said it wrote.
 *
 * The same line and the same pattern as `app/lib/texLog.ts` — duplicated on
 * purpose, because this service has no dependencies and no build step, and one
 * import would give it both. If the pattern ever changes, it changes twice.
 */
function pagesFromLog(chatter) {
  const found = /Output written on [^(]*\((\d+)\s+pages?/i.exec(chatter || '');
  if (!found) return null;
  const pages = Number(found[1]);
  return Number.isInteger(pages) && pages > 0 ? pages : null;
}

function remember(key, pdf) {
  // Oldest out first. Map keeps insertion order, so the first key is the least
  // recently added.
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, pdf);
}

function recall(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  // Re-inserted so that what is being used stays, and what is not falls off.
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

// One compile at a time per machine. Unbounded concurrency turns a slow
// document into a memory problem, and a resume takes about a second.
let inFlight = 0;
const MAX_IN_FLIGHT = Number(process.env.COMPILE_CONCURRENCY || 2);

async function compile(latex) {
  const dir = await mkdtemp(join(tmpdir(), 'compile-'));
  try {
    const tex = join(dir, 'main.tex');
    await writeFile(tex, latex, 'utf8');
    // --print and --keep-logs are what make the page count knowable. The app
    // cannot work it out from the bytes — page objects hide inside compressed
    // object streams — and it needs it to judge somebody's "keep it to one
    // page" rule against the document rather than against a guess.
    const finished = await run(
      'tectonic',
      ['-X', 'compile', tex, '--outdir', dir, '--outfmt', 'pdf', '--keep-logs', '--print'],
      {
        cwd: dir,
        timeout: TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
        // The bundle is baked into the image, so a compile needs no network. If
        // tectonic reaches for one anyway, something is wrong with the image.
        env: { ...process.env, HOME: process.env.HOME || '/home/app' },
      },
    );
    const log = await readFile(join(dir, 'main.log'), 'utf8').catch(() => '');
    return {
      pdf: await readFile(join(dir, 'main.pdf')),
      pages: pagesFromLog(`${finished.stdout || ''}\n${finished.stderr || ''}\n${log}`),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const server = createServer((req, res) => {
  const json = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (req.method === 'GET' && req.url === '/health') return json(200, { status: 'ok' });

  if (req.method !== 'POST' || req.url !== '/render') return json(404, { error: 'Not found' });
  if (!authorised(req.headers.authorization)) return json(401, { error: 'Unauthorized' });
  if (inFlight >= MAX_IN_FLIGHT) return json(503, { error: 'Busy' });

  let size = 0;
  const chunks = [];
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY) {
      json(413, { error: 'Too large' });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', async () => {
    if (res.writableEnded) return;

    let latex;
    try {
      ({ latex } = JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch {
      return json(400, { error: 'Invalid JSON' });
    }
    if (typeof latex !== 'string' || !latex.trim()) return json(400, { error: 'Missing "latex"' });

    const key = createHash('sha256').update(latex).digest('hex');
    const cached = recall(key);
    if (cached) {
      // The count is cached with the bytes. Storing only the PDF would mean the
      // first request knew how long the resume was and every one after it did
      // not — and a resume is read far more often than it is compiled, so the
      // cached answer is the usual answer.
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Length': String(cached.pdf.length),
        'X-Compile-Cache': 'hit',
        ...(cached.pages ? { 'X-Page-Count': String(cached.pages) } : {}),
      });
      res.end(cached.pdf);
      return;
    }

    inFlight += 1;
    try {
      const { pdf, pages } = await compile(latex);
      remember(key, { pdf, pages });
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Length': String(pdf.length),
        'X-Compile-Cache': 'miss',
        ...(pages ? { 'X-Page-Count': String(pages) } : {}),
      });
      res.end(pdf);
    } catch (err) {
      // The log stays here; the caller gets a status. A TeX trace is internal.
      console.error('[compile] failed:', err.stderr || err.message);
      json(422, { error: 'Compilation failed' });
    } finally {
      inFlight -= 1;
    }
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`compile service listening on ${PORT}`));
