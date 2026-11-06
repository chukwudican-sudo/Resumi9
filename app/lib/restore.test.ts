import test from 'node:test';
import assert from 'node:assert/strict';
import { couldComeBack, readRestore, restoreLine, withRestored } from './restore';
import type { DroppedEntry } from './fit';

const job = (name: string, index: number): DroppedEntry => ({
  section: 'experience',
  index,
  name,
  entry: { title: 'Engineer', org: name, location: 'Oshawa, ON', dates: '2024 – 2025', bullets: ['did a thing'] },
});
const project = (name: string, index: number): DroppedEntry => ({
  section: 'projects',
  index,
  name,
  entry: { name, tech: 'TypeScript', dates: '2025', bullets: ['built a thing'] },
});

const DROPPED: DroppedEntry[] = [job('Droady', 0), job('Aegon', 2), job('WesternBell', 3), project('Rate Limit Lab', 5)];

const read = (words: string, dropped = DROPPED, answer = '') => readRestore(words, dropped, answer);
const got = (words: string, dropped = DROPPED, answer = '') => {
  const r = read(words, dropped, answer);
  assert.ok(r && 'restore' in r, `expected a restore from ${JSON.stringify(words)}`);
  return r.restore.entries.map((e) => e.name);
};

// ── the sentence that started it ───────────────────────────────────────────

test('asking for one by name', () => {
  assert.deepEqual(got('add Droady back'), ['Droady']);
  assert.deepEqual(got('put my Aegon job back'), ['Aegon']);
  assert.deepEqual(got('bring back WesternBell'), ['WesternBell']);
  assert.deepEqual(got('restore the Rate Limit Lab project'), ['Rate Limit Lab']);
});

test('asking for a whole kind', () => {
  assert.deepEqual(got('bring my jobs back'), ['Droady', 'Aegon', 'WesternBell']);
  assert.deepEqual(got('put the projects back'), ['Rate Limit Lab']);
  assert.deepEqual(got('i want all my experiences back'), ['Droady', 'Aegon', 'WesternBell']);
});

test('asking for everything', () => {
  assert.deepEqual(got('put them all back'), ['Droady', 'Aegon', 'WesternBell', 'Rate Limit Lab']);
  assert.deepEqual(got('bring back everything you removed'), ['Droady', 'Aegon', 'WesternBell', 'Rate Limit Lab']);
});

test('a name beats a kind in the same sentence', () => {
  // "job" is in here too, and it must not turn this into all three.
  assert.deepEqual(got('add the Droady job back'), ['Droady']);
});

test('they come back in the order they sat on the page', () => {
  assert.deepEqual(got('bring back WesternBell and Droady'), ['Droady', 'WesternBell']);
});

// ── asking rather than guessing ────────────────────────────────────────────

test('"put it back" with several to choose from asks which', () => {
  const r = read('put it back');
  assert.ok(r && 'ask' in r);
  assert.match(r.ask, /Which one/);
  assert.match(r.ask, /Droady/);
});

test('"put it back" with one thing missing needs no question', () => {
  assert.deepEqual(got('put it back', [job('Droady', 0)]), ['Droady']);
});

test('the answer to that question names it', () => {
  assert.deepEqual(got('put it back', DROPPED, 'Aegon'), ['Aegon']);
  assert.deepEqual(got('put it back', DROPPED, 'all of them').length, 4);
});

// ── what must NEVER read as a restore ──────────────────────────────────────

test('ordinary edits are left alone', () => {
  assert.equal(read('shorten the Droady bullets'), null);
  assert.equal(read('remove the Aegon job'), null);
  assert.equal(read('move the summary below education'), null);
  assert.equal(read('add that I used C# at Droady'), null);
  assert.equal(read('make it simpler'), null);
});

/** As the profile really spells it: closed up, with a suffix. */
const AS_STORED: DroppedEntry[] = [job('WesternBell International Ltd.', 3), project('Rate Limit Lab', 5)];

test('asking for an entry without the word "back"', () => {
  /*
   * The three sentences that returned 502 on 6 Nov, one after another.
   *
   * Each names an entry the app was holding, each says "add", none says
   * "back" — so nothing read them as a restore, the whole sentence went to
   * the model, the model was told the app would splice the entry in, and it
   * returned a log with no structure. The guard found nothing in that to
   * match and called the edit unusable.
   */
  const name = ['WesternBell International Ltd.'];
  assert.deepEqual(got('Add the Western Bell International job to Experience', AS_STORED), name);
  assert.deepEqual(got('Add my Western Bell International job to Experience', AS_STORED), name);
  assert.deepEqual(
    got('Add the Western Bell International experience entry with its inventory and logistics bullet', AS_STORED),
    name,
  );
});

test('a plain add the app can finish by itself needs no model', () => {
  const r = read('Add the Western Bell International job to Experience', AS_STORED);
  assert.ok(r && 'restore' in r);
  assert.equal(r.restore.only, true, 'copying one kept entry is not work for a model');
});

test('an add carrying a second request still reaches the model', () => {
  const r = read('Add the Western Bell International experience entry with its inventory and logistics bullet', AS_STORED);
  assert.ok(r && 'restore' in r);
  assert.equal(r.restore.only, false, 'the bullet half is not the app\'s to decide');
});

test('the asking verb is looked for everywhere in the sentence', () => {
  /*
   * "Drop the second Kudi Kitchen job bullet and use the space to show
   * Western Bell International under Experience with one bullet" — two
   * clauses. Reading only the first verb found "use", acting on "the space",
   * and missed the request entirely. Western Bell was never added and the
   * change log told the person it had been.
   */
  assert.deepEqual(
    got('Drop the second bullet and use the space to show Western Bell International under Experience', AS_STORED),
    ['WesternBell International Ltd.'],
  );
});

test('a name mentioned rather than asked for is still left alone', () => {
  // The rule that keeps the two above from swallowing ordinary edits.
  assert.equal(read('add that I used C# at Droady'), null);
  assert.equal(read('add a bullet about Droady'), null);
  assert.equal(read('add a line to the Aegon job about client retention'), null);
});

test('a sentence about going back is not a restore', () => {
  // "back" alone is not enough; something has to be being asked for.
  assert.equal(read('the dates should go back to 2024'), null);
});

test('nothing was dropped, so nothing can come back', () => {
  assert.equal(read('put Droady back', []), null);
});

test('a name that was never dropped does not match', () => {
  assert.equal(read('bring back Kudi Kitchen'), null);
});

// ── skipping the model ─────────────────────────────────────────────────────

test('a sentence that is only a restore needs no model', () => {
  const r = read('please add Droady back');
  assert.ok(r && 'restore' in r);
  assert.equal(r.restore.only, true);
});

test('a sentence carrying anything else still goes to the model', () => {
  const r = read('add Droady back and shorten the MealApp bullets');
  assert.ok(r && 'restore' in r);
  assert.equal(r.restore.only, false);
});

// ── putting them back ──────────────────────────────────────────────────────

const RESUME = {
  experience: [{ org: 'Kudi Kitchen', bullets: ['ran it'] }],
  projects: [{ name: 'MealApp', bullets: ['built it'] }],
};

test('an entry goes back where it was', () => {
  const out = withRestored(RESUME, [job('Droady', 0)]);
  assert.deepEqual(out.experience.map((e: any) => e.org), ['Droady', 'Kudi Kitchen']);
});

test('several go back without shifting each other out of place', () => {
  const out = withRestored(RESUME, [job('Droady', 0), job('WesternBell', 2)]);
  assert.deepEqual(out.experience.map((e: any) => e.org), ['Droady', 'Kudi Kitchen', 'WesternBell']);
});

test('a position past the end is appended, not refused', () => {
  // The page has changed since it was taken off. A job at the bottom is worth
  // more than a job nowhere.
  const out = withRestored(RESUME, [job('Aegon', 9)]);
  assert.deepEqual(out.experience.map((e: any) => e.org), ['Kudi Kitchen', 'Aegon']);
});

test('the other section is untouched', () => {
  const out = withRestored(RESUME, [job('Droady', 0)]);
  assert.deepEqual(out.projects, RESUME.projects);
});

test('the entry comes back exactly as it was kept', () => {
  const dropped = job('Droady', 0);
  const out = withRestored(RESUME, [dropped]);
  assert.equal(out.experience[0], dropped.entry, 'the same object, not a rewritten copy');
});

// ── how it reads ───────────────────────────────────────────────────────────

test('the change log says what came back', () => {
  assert.equal(
    restoreLine([job('Droady', 0)]),
    'Put Droady back, as it was before the page limit took it off.',
  );
  assert.equal(
    restoreLine([job('Droady', 0), job('Aegon', 2)]),
    'Put Droady and Aegon back, as they were before the page limit took them off.',
  );
});

// ── the sentence the bug report asks for ───────────────────────────────────
//
// "add Aegon back as a third job" was failing the nothing-else test on "as",
// "third" and "job", so it went to the model: a call, a wait, and a whole
// resume rewritten, for an instruction the app can carry out by copying one
// kept entry. The acceptance test for the revision flow types this exactly.

test('add X back as a third job is arithmetic, not a model call', () => {
  const read = readRestore('add Aegon back as a third job', DROPPED);
  assert.ok(read && 'restore' in read);
  assert.equal(read.restore.only, true);
  assert.deepEqual(read.restore.entries.map((e) => e.name), ['Aegon']);
});

test('the ways people word the same request', () => {
  for (const said of [
    'put the Aegon job back',
    'bring back Aegon as a third role',
    'add the Aegon experience back',
    'restore Aegon as my second position',
  ]) {
    const read = readRestore(said, DROPPED);
    assert.ok(read && 'restore' in read && read.restore.only, said);
  }
});

test('a placement request still reaches the model', () => {
  // "as a third job" describes the result; "at the top" asks for an
  // arrangement, and a restore does not arrange. Swallowing it would ignore
  // the half of the sentence the person cares most about.
  for (const said of ['add Aegon back at the top', 'put Aegon back above Droady']) {
    const read = readRestore(said, DROPPED);
    assert.ok(read && 'restore' in read && !read.restore.only, said);
  }
});

test('anything else in the sentence still reaches the model', () => {
  const read = readRestore('add Aegon back and shorten the Droady bullets', DROPPED);
  assert.ok(read && 'restore' in read);
  assert.equal(read.restore.only, false);
});

// ── a swap, which never says "back" ────────────────────────────────────────
//
// The real sentence this missed, from the Intel resume: "Replace the Kudi
// Kitchen experience entry with the Rate Limit Lab project". No "add", no
// "back", so nothing read it as a request to bring anything in — the whole
// sentence went to the model, and the model answered that Rate Limit Lab "is
// not available to add". It was in the list of things the app had taken off,
// one lookup away.

test('replace A with B brings B in', () => {
  const read = readRestore(
    'Replace the Kudi Kitchen experience entry with the Rate Limit Lab project, since testing fits this role better',
    DROPPED,
  );
  assert.ok(read && 'restore' in read);
  assert.deepEqual(read.restore.entries.map((e) => e.name), ['Rate Limit Lab']);
});

test('the four ways people word a swap', () => {
  for (const said of [
    'swap Kudi Kitchen for Rate Limit Lab',
    'use Rate Limit Lab instead of Kudi Kitchen',
    'put Rate Limit Lab in place of Kudi Kitchen',
    'substitute Kudi Kitchen with Rate Limit Lab',
  ]) {
    const read = readRestore(said, DROPPED);
    assert.ok(read && 'restore' in read, said);
    assert.deepEqual(read.restore.entries.map((e) => e.name), ['Rate Limit Lab'], said);
  }
});

test('only the incoming half is read for names', () => {
  /*
   * Both halves name something the app took off — Kudi Kitchen is a job on
   * the page AND a project that was cut — so reading the whole sentence
   * brings back the very thing they asked to get rid of.
   */
  const read = readRestore('replace Rate Limit Lab with WesternBell', DROPPED);
  assert.ok(read && 'restore' in read);
  assert.deepEqual(read.restore.entries.map((e) => e.name), ['WesternBell']);
});

test('a swap is never the app’s whole job', () => {
  // `only` means the app can carry the sentence out alone. Bringing something
  // in is half of a swap; what goes out is the other half, and skipping it
  // would answer a replace with an add.
  const read = readRestore('swap Kudi Kitchen for Rate Limit Lab', DROPPED);
  assert.ok(read && 'restore' in read);
  assert.equal(read.restore.only, false);
});

// ── what could come back ───────────────────────────────────────────────────

test('an entry in the profile but not on the page can come back', () => {
  // `dropped` only ever held what the APP cut. Somebody asking for a project
  // they have is not asking a question about the app's bookkeeping.
  const profile = {
    experience: [{ org: 'Droady', bullets: ['a'] }, { org: 'Aegon', bullets: ['b'] }],
    projects: [{ name: 'Resumi', bullets: ['c'] }, { name: 'MealApp', bullets: ['d'] }],
  };
  const page = { experience: [{ org: 'Droady', bullets: ['a'] }], projects: [] };
  const pool = couldComeBack([], profile, page);
  assert.deepEqual(pool.map((d) => d.name), ['Aegon', 'Resumi', 'MealApp']);
});

test('what the app cut comes first, as it was printed', () => {
  // The dropped copy carries the tailored wording; the profile copy is a
  // rebuild in their own words. The better one wins.
  const dropped = [{ section: 'projects' as const, index: 0, name: 'Resumi', entry: { name: 'Resumi', bullets: ['tailored'] } }];
  const profile = { projects: [{ name: 'Resumi', bullets: ['profile wording'] }] };
  const pool = couldComeBack(dropped, profile, { projects: [] });
  assert.equal(pool.length, 1);
  assert.deepEqual((pool[0].entry as { bullets: string[] }).bullets, ['tailored']);
});

test('something already on the page is not offered', () => {
  // Adding a second copy of something is never what "add X" meant.
  const profile = { projects: [{ name: 'Resumi', bullets: ['a'] }] };
  assert.deepEqual(couldComeBack([], profile, { projects: [{ name: 'Resumi', bullets: ['a'] }] }), []);
});

test('no profile at all is just what the app cut', () => {
  assert.deepEqual(couldComeBack(DROPPED, null, null).map((d) => d.name), DROPPED.map((d) => d.name));
});

test('a swap never falls back to a whole kind', () => {
  /*
   * "Replace the Kudi Kitchen EXPERIENCE entry with the Rate Limit Lab
   * project" contains the word experience, and the kind branches read that as
   * a request for every job the app had taken off — quietly bringing Western
   * Bell back on a sentence that never mentioned it.
   *
   * A swap names what it wants. Nothing, when that is not available: already
   * on the page, or no such entry.
   */
  const read = readRestore('Replace the Kudi Kitchen experience entry with the MealApp project', DROPPED);
  assert.equal(read, null, 'MealApp is not on the dropped list, so there is nothing to bring in');
});

test('and still reads the name when it is available', () => {
  const read = readRestore('Replace the Kudi Kitchen experience entry with the Rate Limit Lab project', DROPPED);
  assert.ok(read && 'restore' in read);
  assert.deepEqual(read.restore.entries.map((e) => e.name), ['Rate Limit Lab']);
});

test('an entry already on the page is not restored a second time', () => {
  // A real version 4 printed Rate Limit Lab twice: the app restored it and
  // the model, handed the bullets in the same breath, wrote it out as well.
  const page = {
    experience: [{ org: 'Aegon' }],
    projects: [{ name: 'Resumi' }, { name: 'Rate Limit Lab', bullets: ['the tailored copy'] }],
  };
  const out = withRestored(page, [
    { section: 'projects', index: 4, name: 'Rate Limit Lab', entry: { name: 'Rate Limit Lab', bullets: ['the older copy'] } },
  ]);
  assert.deepEqual(out.projects.map((p: { name: string }) => p.name), ['Resumi', 'Rate Limit Lab']);
  // The copy on the page wins: it has been through the tailoring, the honesty
  // check and the guard, where the other is a splice of an older version.
  assert.deepEqual((out.projects[1] as { bullets: string[] }).bullets, ['the tailored copy']);
});
