import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SHOTS,
  MAX_SHOT_BYTES,
  MAX_STORE_BYTES,
  MAX_TOTAL_BYTES,
  applicationIdFrom,
  isKind,
  trimTo,
} from './feedback';

// ── the application they were looking at ──────────────────────────────────

test('the application id comes out of the page they sent from', () => {
  assert.equal(
    applicationIdFrom('https://www.resumi9.com/applications/app_a1b2c3'),
    'app_a1b2c3',
  );
  assert.equal(
    applicationIdFrom('https://www.resumi9.com/applications/app_a1b2c3?tab=resume#top'),
    'app_a1b2c3',
  );
});

test('a page that is not about one application has none', () => {
  assert.equal(applicationIdFrom('https://www.resumi9.com/applications'), null);
  assert.equal(applicationIdFrom('https://www.resumi9.com/'), null);
  assert.equal(applicationIdFrom('https://www.resumi9.com/insights'), null);
  assert.equal(applicationIdFrom(null), null);
  assert.equal(applicationIdFrom(''), null);
});

test('/applications/new is a form, not an application', () => {
  // It would otherwise be stored as an id, fail the ownership check on the
  // server and be nulled anyway — but one layer earlier is where it belongs.
  assert.equal(applicationIdFrom('https://www.resumi9.com/applications/new'), null);
});

test('anything that is not shaped like an id is refused here', () => {
  // The server checks ownership regardless, so this is the second line rather
  // than the only one. It stops a path segment of arbitrary length or
  // punctuation reaching a query at all.
  assert.equal(applicationIdFrom('/applications/' + 'x'.repeat(200)), null);
  assert.equal(applicationIdFrom('/applications/app a1'), null);
  assert.equal(applicationIdFrom("/applications/app';drop"), null);
});

// ── what kind of thing it is ──────────────────────────────────────────────

test('only the four kinds are kinds', () => {
  assert.ok(isKind('bug'));
  assert.ok(isKind('idea'));
  assert.ok(isKind('confusing'));
  assert.ok(isKind('other'));
  assert.ok(!isKind('BUG'));
  assert.ok(!isKind('feature'));
  assert.ok(!isKind(undefined));
  assert.ok(!isKind(7));
});

// ── the limits ────────────────────────────────────────────────────────────

test('three screenshots at the per-image cap still fit under the total', () => {
  /*
   * The number that matters and is easy to get wrong: a serverless request
   * body is capped around 4.5MB on the platform this runs on, and a request
   * over it is refused before any of our code can say why. If these two
   * constants ever drift apart, the panel accepts an upload the platform will
   * not carry.
   */
  assert.ok(MAX_TOTAL_BYTES < 4_000_000, `total ${MAX_TOTAL_BYTES} leaves no headroom`);
  assert.ok(MAX_SHOT_BYTES <= MAX_TOTAL_BYTES);
  assert.ok(MAX_SHOTS >= 1);
});

test('no run of submissions can fill the database', () => {
  /*
   * The per-submission caps bound ONE report and nothing else; this is the
   * only number that bounds the table. The database it shares is 500MB in
   * total, and every resume, bullet and posting in the app is in there too —
   * so the ceiling has to leave most of it alone, and a single submission has
   * to be a small fraction of the ceiling or the cap arrives in one jump.
   */
  assert.ok(MAX_STORE_BYTES < 300_000_000, `${MAX_STORE_BYTES} is most of the free tier`);
  assert.ok(MAX_TOTAL_BYTES * 50 < MAX_STORE_BYTES, 'one submission is too large a share of the ceiling');
});

test('text is cut to its column rather than refused', () => {
  assert.equal(trimTo('hello', 10), 'hello');
  assert.equal(trimTo('hello', 3), 'hel');
  assert.equal(trimTo('', 3), '');
});
