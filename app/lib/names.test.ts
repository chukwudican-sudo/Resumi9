import test from 'node:test';
import assert from 'node:assert/strict';
import { namedAtStart, namesEntry, spanFor, splitTerms, squash, waysOfNaming, whichNamed, withoutAside } from './names';

/*
 * The sentences in here are real ones, from the 6 Nov run on the Scotiabank
 * application. Every case that is marked as the reason for a rule came back to
 * the person as a 502 or as an edit that silently did nothing.
 */

// ── the spellings of one name ──────────────────────────────────────────────

test('a name reduces one suffix at a time, not straight to its first word', () => {
  // Returning only the ends missed the middle, which is what people type.
  assert.deepEqual(waysOfNaming('WesternBell International Ltd.'), [
    'WesternBell International Ltd.',
    'WesternBell International Ltd',
    'WesternBell International',
    'WesternBell',
  ]);
});

test('a first word too generic to name anything is not offered', () => {
  const ways = waysOfNaming('The Tech Group');
  assert.ok(!ways.includes('The'), 'an article names nothing');
  assert.ok(!ways.some((w) => w.toLowerCase() === 'tech'), 'nor does a word every company shares');
});

test('a short first word is not offered either', () => {
  assert.deepEqual(waysOfNaming('Sun Systems'), ['Sun Systems'], 'three letters is not a name on its own');
});

test('a name that is all suffix words keeps what it had', () => {
  assert.deepEqual(waysOfNaming('The Group'), ['The Group']);
});

// ── does this sentence name that thing ─────────────────────────────────────

test('the spelling the profile holds is not the spelling people type', () => {
  // The 502. Stored closed up and with a suffix; typed open and without one.
  assert.equal(namesEntry('Add the Western Bell International job to Experience', 'WesternBell International Ltd.'), true);
  assert.equal(namesEntry('Add my Western Bell International job to Experience', 'WesternBell International Ltd.'), true);
  assert.equal(namesEntry('bring back WesternBell', 'WesternBell International Ltd.'), true);
});

test('an ordinary name still matches the ordinary way', () => {
  assert.equal(namesEntry('shorten the Aegon bullets', 'Aegon'), true);
  assert.equal(namesEntry('shorten the Aegon bullets', 'Droady'), false);
});

test('a hyphen or a space on one side only', () => {
  assert.equal(namesEntry('the Rate-Limit Lab project', 'Rate Limit Lab'), true);
  assert.equal(namesEntry('the RateLimit Lab project', 'Rate Limit Lab'), true);
});

test('an ampersand written as the word', () => {
  assert.equal(namesEntry('the Smith and Jones role', 'Smith & Jones'), true);
});

test('a name it was not given is not found', () => {
  // The direction that matters: a wrong match here deletes a job.
  assert.equal(namesEntry('shorten the Aegon bullets', 'WesternBell International Ltd.'), false);
  assert.equal(namesEntry('make the projects shorter', 'Kudi Kitchen'), false);
  assert.equal(namesEntry('', 'Aegon'), false);
  assert.equal(namesEntry('add Aegon back', ''), false);
});

test('a short name does not match inside a longer word', () => {
  assert.equal(namesEntry('I ran the marathon', 'Mara'), false);
});

// ── what the verb is acting on ─────────────────────────────────────────────

test('the thing asked for begins what is left of the sentence', () => {
  assert.equal(namedAtStart('Western Bell International job to Experience', 'WesternBell International Ltd.'), true);
  assert.equal(namedAtStart('Droady back', 'Droady'), true);
});

test('a name buried behind the real object does not begin it', () => {
  // "add that I used C# at Droady" is a fact going into an entry, not a
  // request for the entry back. Both sentences name Droady.
  assert.equal(namedAtStart('used C# at Droady', 'Droady'), false);
  assert.equal(namedAtStart('a bullet about Droady', 'Droady'), false);
});

// ── the span, for taking a name out of a sentence ──────────────────────────

test('a span matches the name however it is spaced', () => {
  const span = spanFor('WesternBell International')!;
  assert.match('Add the Western Bell International job', span);
  assert.equal('Add the Western Bell International job'.replace(span, '·'), 'Add the · job');
});

test('a span does not run into the word beside it', () => {
  assert.equal(spanFor('Aegon')!.test('Aegonia Holdings'), false);
});

test('too short to span', () => {
  assert.equal(spanFor('AB'), null);
});

// ── picking one out of a list ──────────────────────────────────────────────

test('the longest match wins', () => {
  const entries = [{ name: 'Kudi' }, { name: 'Kudi Kitchen' }];
  assert.equal(whichNamed('remove the Kudi Kitchen project', entries, (e) => e.name)?.name, 'Kudi Kitchen');
});

test('nothing named is null, not a guess', () => {
  assert.equal(whichNamed('make it shorter', [{ name: 'Aegon' }], (e) => e.name), null);
});

test('squash is punctuation-blind and case-blind', () => {
  assert.equal(squash('Western Bell International Ltd.'), 'westernbellinternationalltd');
  assert.equal(squash('R & D'), 'randd');
});

// ── splitting a skills line ───────────────────────────────────────────────

test('a comma inside brackets does not end a term', () => {
  // Latent in eleven hand-written copies of this before it was shared.
  assert.deepEqual(splitTerms('Cloud Platforms (Vercel, Cloudflare), Docker'), [
    'Cloud Platforms (Vercel, Cloudflare)',
    'Docker',
  ]);
  assert.deepEqual(splitTerms('GitHub Actions (CI/CD), pytest, Docker'), [
    'GitHub Actions (CI/CD)',
    'pytest',
    'Docker',
  ]);
});

test('an ordinary line splits the ordinary way', () => {
  assert.deepEqual(splitTerms('JavaScript, TypeScript, Python'), ['JavaScript', 'TypeScript', 'Python']);
  assert.deepEqual(splitTerms(''), []);
  assert.deepEqual(splitTerms('  ,  , Docker ,'), ['Docker']);
});

test('an unclosed bracket does not swallow the rest of the line', () => {
  assert.deepEqual(splitTerms('Broken (one, two'), ['Broken (one, two']);
});

test('a gloss comes off for comparison but not from the text', () => {
  assert.equal(withoutAside('GitHub Actions (CI/CD)'), 'GitHub Actions');
  assert.equal(withoutAside('React Native (Expo)'), 'React Native');
  assert.equal(withoutAside('Docker'), 'Docker');
});
