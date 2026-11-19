import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_STORE_BYTES } from '../lib/feedback';
import { callerIp, isAdmin, senderKey, sniffImage, storeLimitBytes } from './feedback';

// ── who may read other people's words ─────────────────────────────────────

test('with no allowlist configured, nobody is an admin', async () => {
  /*
   * The direction this has to fail in. A deploy that forgets the variable
   * shows the inbox to NO ONE rather than to everyone, and the page answers
   * 404 — so the mistake is invisible to strangers and obvious to the owner.
   *
   * Both of these return before touching the database, which is also why they
   * can be tested without one.
   */
  const was = process.env.RESUMI_ADMIN_EMAILS;
  delete process.env.RESUMI_ADMIN_EMAILS;
  try {
    assert.equal(await isAdmin('user_123'), false);
    assert.equal(await isAdmin(null), false);
  } finally {
    if (was !== undefined) process.env.RESUMI_ADMIN_EMAILS = was;
  }
});

test('a signed-out caller is never an admin, allowlist or not', async () => {
  const was = process.env.RESUMI_ADMIN_EMAILS;
  process.env.RESUMI_ADMIN_EMAILS = 'someone@example.com';
  try {
    assert.equal(await isAdmin(null), false);
  } finally {
    if (was === undefined) delete process.env.RESUMI_ADMIN_EMAILS;
    else process.env.RESUMI_ADMIN_EMAILS = was;
  }
});

// ── how much room there is ────────────────────────────────────────────────

test('the store ceiling is the constant unless the environment says otherwise', () => {
  const was = process.env.FEEDBACK_STORE_LIMIT_BYTES;
  try {
    delete process.env.FEEDBACK_STORE_LIMIT_BYTES;
    assert.equal(storeLimitBytes(), MAX_STORE_BYTES);
    process.env.FEEDBACK_STORE_LIMIT_BYTES = '5000000';
    assert.equal(storeLimitBytes(), 5_000_000);
    // A nonsense value falls back rather than disabling the cap, which is the
    // failure mode that matters: `0` or `abc` must not mean "unlimited".
    for (const bad of ['0', '-1', 'abc', '']) {
      process.env.FEEDBACK_STORE_LIMIT_BYTES = bad;
      assert.equal(storeLimitBytes(), MAX_STORE_BYTES, `"${bad}" should fall back`);
    }
  } finally {
    if (was === undefined) delete process.env.FEEDBACK_STORE_LIMIT_BYTES;
    else process.env.FEEDBACK_STORE_LIMIT_BYTES = was;
  }
});

// ── who sent it ───────────────────────────────────────────────────────────

test('a signed-in sender is keyed on their own id', () => {
  assert.equal(senderKey('user_123', '203.0.113.7'), 'user_123');
  // Even with no address at all — which is what a request from the platform's
  // own network looks like.
  assert.equal(senderKey('user_123', null), 'user_123');
});

test('an address is hashed, not stored', () => {
  const key = senderKey(null, '203.0.113.7');
  assert.ok(key?.startsWith('ip_'), key ?? 'null');
  assert.ok(!key!.includes('203.0.113'), key!);
  // Same address, same bucket — otherwise the count never reaches the limit.
  assert.equal(senderKey(null, '203.0.113.7'), key);
  assert.notEqual(senderKey(null, '203.0.113.8'), key);
});

test('no id and no address means no sender to count', () => {
  // The global backstop is what covers this case; inventing a shared key would
  // put every anonymous visitor in one bucket and rate-limit them as one person.
  assert.equal(senderKey(null, null), null);
});

test('the caller is the first entry in x-forwarded-for, not the last', () => {
  // The list is appended to by each hop, so the last entry is the proxy's.
  const headers = new Headers({ 'x-forwarded-for': '203.0.113.7, 70.41.3.18, 150.172.238.178' });
  assert.equal(callerIp(headers), '203.0.113.7');
  assert.equal(callerIp(new Headers({ 'x-real-ip': '203.0.113.9' })), '203.0.113.9');
  assert.equal(callerIp(new Headers()), null);
});

// ── what the bytes actually are ───────────────────────────────────────────

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);

test('an image is identified by its own header', () => {
  assert.equal(sniffImage(PNG), 'image/png');
  assert.equal(sniffImage(JPEG), 'image/jpeg');
});

test('anything else is not an image, whatever the upload claimed', () => {
  /*
   * The content type on a form part is a string the sender chose, and the
   * admin page serves these bytes back under it. An HTML page uploaded as
   * image/png would be stored and then served as a page.
   */
  assert.equal(sniffImage(Buffer.from('<html><script>alert(1)</script>')), null);
  assert.equal(sniffImage(Buffer.from('GIF89a')), null);
  assert.equal(sniffImage(Buffer.from('%PDF-1.7')), null);
  assert.equal(sniffImage(Buffer.alloc(0)), null);
  // Short enough to run past the end of the buffer if the length were not checked.
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8])), null);
  assert.equal(sniffImage(Buffer.from([0x89, 0x50])), null);
});
