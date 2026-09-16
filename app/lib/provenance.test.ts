import assert from 'node:assert/strict';
import test from 'node:test';
import { annotate, resolveTailored } from './provenance';
import type { ResumeStructure } from './types';

const SOURCE: ResumeStructure = {
  name: 'Chukwudi Alex',
  contact: { email: 'a@example.com' },
  education: [
    { school: 'Ontario Tech University', location: 'Oshawa, ON', degree: 'BEng', dates: 'Sep 2023 – 2028', bullets: ['Relevant coursework: Data Structures'] },
  ],
  experience: [
    { title: 'Software Engineer', org: 'Droady', location: 'San Francisco, CA', dates: 'Nov 2025 – May 2026', bullets: ['Contributed to payment integration', 'Worked across mobile and web'] },
  ],
  projects: [
    { name: 'FraudWatch', tech: 'Java', dates: 'Aug 2026', bullets: ['Backend lead on a 3-person team', 'Set up an automated CI pipeline'] },
  ],
  skills: [{ category: 'Languages', items: 'Java, TypeScript' }],
};

const indexOf = (facts: { text: string; entryId?: string | null }[] = []) => annotate(SOURCE, facts).index;

test('every bullet is offered to the model with an id', () => {
  const { profile, index } = annotate(SOURCE);
  const experience = (profile.experience as any[])[0];
  assert.equal(experience.id, 'e0');
  assert.deepEqual(experience.bullets[0], { id: 'e0.b0', text: 'Contributed to payment integration' });
  assert.equal(index.bullets.get('p0.b1')!.text, 'Set up an automated CI pipeline');
  assert.equal(index.bullets.get('p0.b1')!.entry, 'p0');
});

test('a bullet the model did not change comes back verbatim, with no text sent', () => {
  // Most bullets on most resumes. Sending the id alone is what pays for the
  // check: output tokens are the whole of the wait.
  const { structure, bullets } = resolveTailored(
    { experience: [{ id: 'e0', org: 'Droady', bullets: [{ from: ['e0.b0'] }] }] },
    indexOf(),
  );
  assert.deepEqual((structure.experience as any[])[0].bullets, ['Contributed to payment integration']);
  assert.equal(bullets[0].changed, false);
  assert.deepEqual(bullets[0].evidence, ['Contributed to payment integration']);
});

test('a rewritten bullet carries the source it was rewritten from', () => {
  const { bullets } = resolveTailored(
    {
      projects: [
        { id: 'p0', name: 'FraudWatch', bullets: [{ from: ['p0.b1'], text: 'Set up an automated CI pipeline, using Git-based version control throughout' }] },
      ],
    },
    indexOf(),
  );
  assert.equal(bullets[0].changed, true);
  assert.deepEqual(bullets[0].evidence, ['Set up an automated CI pipeline']);
  assert.equal(bullets[0].unsourced, false);
});

test('a bullet built from another entry is marked as moved', () => {
  // A project folded into a job of the same name put the same facts on one
  // resume twice. The id says plainly that the sentence came from elsewhere.
  const { bullets } = resolveTailored(
    { experience: [{ id: 'e0', org: 'Droady', bullets: [{ from: ['p0.b0'], text: 'Led a 3-person team' }] }] },
    indexOf(),
  );
  assert.equal(bullets[0].moved, true);
  assert.deepEqual(bullets[0].evidence, []);
});

test('a bullet that names nothing real is kept but marked unsourced', () => {
  // Deleting here would be the guard's job twice over. Saying it has no source
  // is enough — the honesty check decides what happens to it.
  const { bullets } = resolveTailored(
    { experience: [{ id: 'e0', org: 'Droady', bullets: [{ from: ['e9.b9'], text: 'Ran the department' }] }] },
    indexOf(),
  );
  assert.equal(bullets[0].unsourced, true);
  assert.equal(bullets[0].text, 'Ran the department');
});

test('an id alone that resolves to nothing leaves no bullet behind', () => {
  const { structure, bullets } = resolveTailored(
    { experience: [{ id: 'e0', org: 'Droady', bullets: [{ from: ['nonsense'] }] }] },
    indexOf(),
  );
  assert.deepEqual((structure.experience as any[])[0].bullets, []);
  assert.equal(bullets.length, 0);
});

test('a bare string still works, and says it has no evidence', () => {
  // The schema asks for an object. A schema is a request, not a guarantee.
  const { structure, bullets } = resolveTailored(
    { experience: [{ id: 'e0', org: 'Droady', bullets: ['Shipped the thing'] }] },
    indexOf(),
  );
  assert.deepEqual((structure.experience as any[])[0].bullets, ['Shipped the thing']);
  assert.equal(bullets[0].unsourced, true);
});

test('a fact answered about one job is evidence for that job only', () => {
  const index = indexOf([{ text: 'Cut deploy time in half', entryId: 'e0' }]);
  const forOwnEntry = resolveTailored(
    { experience: [{ id: 'e0', org: 'Droady', bullets: [{ from: ['f0'], text: 'Cut deploy time in half' }] }] },
    index,
  );
  assert.deepEqual(forOwnEntry.bullets[0].evidence, ['Cut deploy time in half']);

  const forAnother = resolveTailored(
    { projects: [{ id: 'p0', name: 'FraudWatch', bullets: [{ from: ['f0'], text: 'Cut deploy time in half' }] }] },
    index,
  );
  assert.equal(forAnother.bullets[0].moved, true);
});

test('a fact about the person, with no entry, is evidence anywhere', () => {
  const index = indexOf([{ text: 'Speaks French', entryId: null }]);
  const { bullets } = resolveTailored(
    { projects: [{ id: 'p0', name: 'FraudWatch', bullets: [{ from: ['f0'], text: 'Documented the API in French' }] }] },
    index,
  );
  assert.equal(bullets[0].moved, false);
  assert.deepEqual(bullets[0].evidence, ['Speaks French']);
});

test('the id is not left on the entry handed to the guard', () => {
  const { structure } = resolveTailored(
    { experience: [{ id: 'e0', org: 'Droady', dates: 'Nov 2025 – May 2026', bullets: [{ from: ['e0.b0'] }] }] },
    indexOf(),
  );
  const entry = (structure.experience as any[])[0];
  assert.equal('id' in entry, false);
  assert.equal(entry.org, 'Droady');
});
