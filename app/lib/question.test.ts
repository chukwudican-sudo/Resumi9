import test from 'node:test';
import assert from 'node:assert/strict';
import { PLAIN_QUESTION, tidyQuestion } from './question';
import type { ResumeStructure } from './types';

const source = {
  experience: [
    { title: 'Software Engineer', org: 'Droady', location: '', dates: '', bullets: [] },
    { title: 'Founder', org: 'Kudi Kitchen', location: '', dates: '', bullets: [] },
  ],
  projects: [
    { name: 'FraudWatch', tech: '', dates: '', bullets: [] },
    { name: 'MealApp', tech: '', dates: '', bullets: [] },
    { name: 'Resumi', tech: '', dates: '', bullets: [] },
  ],
  education: [{ school: 'Ontario Tech', degree: '', location: '', dates: '', bullets: [] }],
  skills: [],
} as unknown as ResumeStructure;

const tidy = (q: string) => tidyQuestion(q, source);

// The real question, from the first live run after the app stopped listing
// entries itself.
const REAL =
  'Could you clarify which section\'s "second bullet" you mean — e.g. which experience or project entry (Droady, Kudi Kitchen, FraudWatch, MealApp, Resumi, etc.)?';

test('the list is cut and the question survives', () => {
  assert.equal(tidy(REAL), 'Could you clarify which section\'s "second bullet" you mean?');
});

test('it cuts at the first aside, leaving no dangling "e.g."', () => {
  // The aside is one thought — "— e.g. which experience or project entry
  // (Droady, …)" — so cutting at the bracket keeps the for-instance and drops
  // the instances.
  assert.match(tidy(REAL), /second bullet/);
  assert.doesNotMatch(tidy(REAL), /e\.g\./);
});

test('a bracketed list on its own is cut', () => {
  assert.equal(
    tidy('Which entry did you mean (Droady, Kudi Kitchen, FraudWatch)?'),
    'Which entry did you mean?',
  );
});

test('a list introduced by a colon is cut', () => {
  assert.equal(
    tidy('Which one of these should go: Droady, Kudi Kitchen or FraudWatch?'),
    'Which one of these should go?',
  );
});

test('one or two names are left exactly as written', () => {
  const two = 'Do you mean the Droady role or the Droady project at FraudWatch?';
  assert.equal(tidy(two), two);
  const one = 'Should the Droady entry go completely, or just get shorter?';
  assert.equal(tidy(one), one);
});

test('the same name three times is one name, not three', () => {
  const q = 'Do you mean Droady the job, Droady the project, or Droady the certificate?';
  assert.equal(tidy(q), q);
});

test('names in the main clause have nothing safe to cut, so it uses ours', () => {
  // Trimming here would leave a stub; the app's own question is the fallback.
  assert.equal(
    tidy('Should I shorten Droady, Kudi Kitchen and FraudWatch, or only Droady?'),
    PLAIN_QUESTION,
  );
});

test('a question that would be left as a stub uses ours instead', () => {
  assert.equal(tidy('Which — Droady, Kudi Kitchen or FraudWatch?'), PLAIN_QUESTION);
});

test('a question mark is added back when the cut took it', () => {
  assert.match(tidy('Which entry should be shortened (Droady, MealApp, Resumi)'), /\?$/);
});

test('an ordinary question is untouched', () => {
  const plain = 'Do you want it removed completely, or just shortened?';
  assert.equal(tidy(plain), plain);
});

test('nothing at all stays nothing', () => {
  assert.equal(tidy(''), '');
  assert.equal(tidy('   '), '');
});

test('a resume with no entries cannot trip it', () => {
  const empty = { experience: [], projects: [], education: [], skills: [] } as unknown as ResumeStructure;
  assert.equal(tidyQuestion(REAL, empty), REAL);
});
