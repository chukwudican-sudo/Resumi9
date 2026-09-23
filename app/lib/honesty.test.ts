import assert from 'node:assert/strict';
import test from 'node:test';
import { readInstruction } from './asked';
import { applyFlags, checkBullets } from './honesty';
import type { ResolvedBullet } from './provenance';
import type { ResumeStructure } from './types';

/**
 * The cases are real. Every "caught" test below is a sentence that appeared on
 * one of five reviewed resumes, next to the profile bullet it was rewritten
 * from. Every "left alone" test is a rewrite from the same five that was good
 * tailoring and must survive — a check that undoes those is worse than no check.
 */

const bullet = (over: Partial<ResolvedBullet> = {}): ResolvedBullet => ({
  entry: 'p0',
  text: '',
  changed: true,
  // Nothing in this file reads the ids — the honesty check compares against
  // what the source SAID, not what the model pointed at. They are required on
  // the type because the cut ranking follows them, so a default keeps these
  // cases about the sentences they were written for.
  from: [],
  evidence: [],
  moved: false,
  unsourced: false,
  ...over,
});

// ── what got through three revisions of the prompt ─────────────────────────

test('a collaboration clause added to a team is caught', () => {
  const flags = checkBullets([
    bullet({
      text: 'Delivered a live fraud-pattern detection system as backend lead on a 3-person team, completing a two-week Agile sprint, working both independently and collaboratively',
      evidence: ['Delivered a live fraud-pattern detection system as backend lead on a 3-person team by completing a genuine two-week Agile sprint'],
    }),
  ]);
  assert.equal(flags.length, 1);
  assert.match(flags[0].reason, /collaboratively/);
  assert.match(flags[0].revertTo, /^Delivered a live fraud-pattern/);
});

test('a tool bolted on from elsewhere on the resume is caught', () => {
  // Git is on the resume. It is not in this bullet, and each bullet is
  // evidence only for what it says.
  const flags = checkBullets(
    [
      bullet({
        text: 'Set up an automated CI pipeline (GitHub Actions) running the test suite on every push, using Git-based version control throughout',
        evidence: ['Set up an automated CI pipeline (GitHub Actions) running the test suite on every push'],
      }),
    ],
    ['version control', 'ci/cd'],
  );
  assert.equal(flags.length, 1);
  assert.match(flags[0].reason, /version control/);
});

test('a whole bullet with no source is removed, not reverted', () => {
  // "code reviews and status meetings" with "an interdisciplinary team" — a
  // fourth Droady bullet that had no source at all.
  const flags = checkBullets([
    bullet({
      text: 'Used version control and source code management practices while collaborating with an interdisciplinary team through code reviews and status meetings',
      unsourced: true,
    }),
  ]);
  assert.equal(flags[0].revertTo, '');
  assert.match(flags[0].reason, /not based on anything/);
});

test('work carried in from another entry is caught', () => {
  const flags = checkBullets([
    bullet({
      text: 'Designed, developed, and deployed a full production application end-to-end, applying defence-in-depth database access controls',
      evidence: ['Independently own every stage of the product, from technical build to customer-facing content'],
      moved: true,
    }),
  ]);
  assert.match(flags[0].reason, /another entry/);
});

test('a posting requirement the bullet never earned is caught', () => {
  const flags = checkBullets(
    [
      bullet({
        text: 'Defined and maintained the shared data contract between three components, applying object-oriented design principles',
        evidence: ['Kept three independently developed system components integrated cleanly by defining and maintaining the shared data contract between them'],
      }),
    ],
    ['object-oriented design', 'sdlc'],
  );
  assert.match(flags[0].reason, /object-oriented design/);
});

test('a number nobody wrote down is caught', () => {
  const flags = checkBullets([
    bullet({ text: 'Cut response time by 80% across the platform', evidence: ['Cut client response time by 50% by building the company website'] }),
  ]);
  assert.match(flags[0].reason, /80%/);
});

// ── the floor: good tailoring has to survive ───────────────────────────────

test('re-wording the same fact in the posting\'s vocabulary is left alone', () => {
  const flags = checkBullets(
    [
      bullet({
        text: 'Designed a 17+ table relational database schema in PostgreSQL with Row-Level Security policies to enforce strict per-user data isolation',
        evidence: ['Enforced strict per-user data isolation by designing a 17+ table PostgreSQL schema with Row-Level Security policies at the database level'],
      }),
    ],
    ['schema design', 'database management systems'],
  );
  assert.deepEqual(flags, []);
});

test('a number kept from the source is left alone', () => {
  const flags = checkBullets([
    bullet({
      text: 'Redesigned an offline-sync retry scheduler, cutting transient-failure recovery time from 30–45 seconds to 1–2 seconds',
      evidence: ['Cut transient-failure recovery time from 30–45 seconds to 1–2 seconds by redesigning an offline-sync retry scheduler'],
    }),
  ]);
  assert.deepEqual(flags, []);
});

test('a stock phrase the profile itself uses is left alone', () => {
  // The person really does work in a fast-moving environment; they wrote it.
  const flags = checkBullets([
    bullet({
      text: 'Independently owned every stage of the product in a fast-paced, resource-constrained environment',
      evidence: ['Independently own every stage of the product, in a fast-moving, resource-constrained environment. Fast-paced work.'],
    }),
  ]);
  assert.deepEqual(flags, []);
});

test('the posting\'s hyphen is not a different claim', () => {
  // A real false positive, caught on a live run: the profile says "backend",
  // the posting asks for "back-end development", and the phrase never appears
  // adjacently in the source. It plainly says it, so the rewrite that puts the
  // two words together is the tailoring working, not an invented claim.
  const flags = checkBullets(
    [
      bullet({
        text: 'Worked across mobile, back-end, and web development alongside a small engineering team',
        evidence: ['Worked across mobile, backend, and web development alongside a small engineering team'],
      }),
    ],
    ['back-end development'],
  );
  assert.deepEqual(flags, []);
});

test('calling someone\'s mobile and web work "front-end" is still a claim', () => {
  // The source says "mobile, backend, and web"; it never says front-end.
  // Reading two of those as front-end is a leap, and it is the kind this check
  // exists for — the person can still say it themselves, in their own words.
  //
  // Written with the words adjacent, because that is what the proximity rule
  // promises: "front-end development" as a phrase. Spread across a sentence —
  // "front-end (mobile, web) and back-end development" — the two halves sit
  // thirty characters apart and it deliberately says nothing, which is the
  // price of not reverting good rewrites.
  const flags = checkBullets(
    [
      bullet({
        text: 'Led front-end development alongside a small engineering team',
        evidence: ['Worked across mobile, backend, and web development alongside a small engineering team'],
      }),
    ],
    ['front-end development'],
  );
  assert.equal(flags.length, 1);
  assert.match(flags[0].reason, /front-end development/);
});

test('two words doing unrelated jobs are not the phrase', () => {
  // A live false positive. "backend lead" and "Agile development process" are
  // ten words apart doing different jobs; read as one phrase, the rewrite was
  // called a claim of "back-end development" and reverted.
  const flags = checkBullets(
    [
      bullet({
        text: 'Worked as backend lead on a 3-person team, employing an Agile development process with daily standups',
        evidence: ['Delivered a live fraud-pattern detection system as backend lead on a 3-person team by completing a genuine two-week Agile sprint with daily standups'],
      }),
    ],
    ['back-end development'],
  );
  assert.deepEqual(flags, []);
});

test('a phrase\'s words must sit together, not merely share a sentence', () => {
  // The distance is the whole test. "mobile, backend, and web development" has
  // the two words eighteen characters apart and does say back-end development.
  // "backend lead on a 3-person team, employing iterative Agile development"
  // has them sixty apart, doing unrelated jobs, and does not — this one was
  // flagged on two separate live runs before the window was tightened.
  const near = checkBullets(
    [
      bullet({
        text: 'Worked across mobile, back-end, and web development alongside a small team',
        evidence: ['Worked across mobile, backend, and web development alongside a small team'],
      }),
    ],
    ['back-end development'],
  );
  assert.deepEqual(near, []);

  const far = checkBullets(
    [
      bullet({
        text: 'Delivered a live fraud-pattern detection system as backend lead on a 3-person team, employing iterative Agile development',
        evidence: ['Delivered a live fraud-pattern detection system as backend lead on a 3-person team by completing a genuine two-week Agile sprint'],
      }),
    ],
    ['back-end development'],
  );
  assert.equal(far.some((f) => /back-end development/.test(f.reason)), false);
});

test('a stock phrase is only an invention when it is written whole', () => {
  // Matched loosely, "code review" fires on this — "code" in one clause,
  // "review" in another — and takes somebody's real work off their resume.
  // An employer's requirement may legitimately spread across a sentence; a
  // stock phrase never does.
  const flags = checkBullets([
    bullet({
      text: 'Reviewed the code for a teammate and shipped the review notes',
      evidence: ['Reviewed a teammate\'s code and wrote up the notes'],
    }),
  ]);
  assert.deepEqual(flags, []);
});

test('a soft competency lifted from the posting is caught', () => {
  // This one reached a finished resume while the check watched it happen: the
  // source says "timely follow-ups", the rewrite says "strong user
  // orientation", and that phrase is straight off the posting's Skills &
  // Competencies list. It is not a named skill, so the posting reader never
  // extracts it and `requirements` cannot catch it.
  const flags = checkBullets([
    bullet({
      text: 'Maintained a 95% client retention rate through consistent service, clear communication, and strong user orientation',
      evidence: ['Maintained a 95% client retention rate by delivering consistent service, clear communication, and timely follow-ups'],
    }),
  ]);
  assert.equal(flags.length, 1);
  assert.match(flags[0].reason, /user orientation/);
  assert.match(flags[0].revertTo, /timely follow-ups/);
});

test('a competency the person really claims is left alone', () => {
  // They wrote it about themselves; it is not the posting's word being borrowed.
  const flags = checkBullets([
    bullet({
      text: 'Known for attention to detail across every release',
      evidence: ['Recognised for attention to detail on every release'],
    }),
  ]);
  assert.deepEqual(flags, []);
});

test('a stock phrase written whole is still caught', () => {
  // From the live run: the source says nothing about how the code was written,
  // and the rewrite ended "applying secure coding practices".
  const flags = checkBullets([
    bullet({
      text: 'Debugged and closed an injection vulnerability by writing a single-pass input-escaping function, applying secure coding practices',
      evidence: ['Cut a security vulnerability to zero by writing a single-pass input-escaping function that closed an injection gap'],
    }),
  ]);
  assert.equal(flags.length, 1);
  assert.match(flags[0].reason, /secure coding/);
});

test('an unchanged bullet is never checked', () => {
  assert.deepEqual(checkBullets([bullet({ text: 'Anything at all', changed: false })], ['anything']), []);
});

// ── what the person is told ────────────────────────────────────────────────

test('a reverted bullet goes back to their words, and a sourceless one goes', () => {
  const structure = {
    experience: [{ org: 'Droady', bullets: ['Rewrote with a tail', 'Invented from nothing'] }],
    projects: [{ name: 'FraudWatch', bullets: ['Left alone'] }],
  };
  const { structure: fixed, log, warnings } = applyFlags(structure, [
    { text: 'Rewrote with a tail', revertTo: 'What they actually wrote', reason: 'adds "stakeholders", which this bullet does not say' },
    { text: 'Invented from nothing', revertTo: '', reason: 'is not based on anything in your profile' },
  ]);
  assert.deepEqual(fixed.experience[0].bullets, ['What they actually wrote']);
  assert.deepEqual(fixed.projects[0].bullets, ['Left alone']);
  assert.equal(log.length, 2);
  assert.equal(warnings.length, 2);
  // The claim itself is named, not just counted — it is the only place the
  // person can see what was nearly sent out under their name.
  assert.match(warnings[0], /stakeholders/);
});

test('nothing flagged means nothing said', () => {
  const structure = { experience: [{ org: 'Droady', bullets: ['As written'] }] };
  const { structure: same, log, warnings } = applyFlags(structure, []);
  assert.equal(same, structure);
  assert.deepEqual(log, []);
  assert.deepEqual(warnings, []);
});

// ── the person's own words are evidence ────────────────────────────────────
//
// The check compares a rewrite against the bullet it came from, which is right
// for a tailor — nobody said anything — and wrong for an edit, where somebody
// just told it something true about their own work.

const EMPTY: ResumeStructure = {
  name: 'Chukwudi Alex',
  contact: {},
  education: [],
  experience: [{ title: 'Engineer', org: 'Droady', location: 'SF', dates: '2025', bullets: ['Built the billing service'] }],
  projects: [],
  skills: [],
};

test('a tool the person says they used is theirs to add', () => {
  // C# is a requirement this posting names and the source bullet does not
  // contain, which is exactly the shape of an invention — and exactly the shape
  // of somebody answering the gap honestly.
  const asked = readInstruction('add that I used C# at Droady', EMPTY);
  const flags = checkBullets(
    [bullet({ text: 'Built the billing service in C#', evidence: ['Built the billing service'] })],
    ['C#'],
    asked,
  );
  assert.deepEqual(flags, []);
});

test('a number the person supplies is not an invented one', () => {
  const asked = readInstruction('the detector had 500 users', EMPTY);
  const flags = checkBullets(
    [bullet({ text: 'Shipped a detector used by 500 people', evidence: ['Shipped a detector'] })],
    [],
    asked,
  );
  assert.deepEqual(flags, []);
});

test('being asked for one thing does not license everything else in the run', () => {
  const asked = readInstruction('add that I used C# at Droady', EMPTY);
  const flags = checkBullets(
    [
      bullet({ text: 'Built the billing service in C#', evidence: ['Built the billing service'] }),
      bullet({ text: 'Worked cross-functionally with stakeholders on checkout', evidence: ['Worked on the checkout flow'] }),
    ],
    ['C#'],
    asked,
  );
  assert.equal(flags.length, 1);
  assert.match(flags[0].reason, /cross-functional|stakeholder/);
});

test('a bullet built on nothing is still removed, instruction or not', () => {
  // Pinned because the widened evidence must not change which branch this
  // falls into: whole invented bullets arrived by exactly this route.
  const asked = readInstruction('add that I used C# at Droady', EMPTY);
  const flags = checkBullets([bullet({ text: 'Ran the department', unsourced: true })], [], asked);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].revertTo, '');
  assert.match(flags[0].reason, /not based on anything/);
});

test('with nothing asked, the same rewrite is still caught', () => {
  const flags = checkBullets(
    [bullet({ text: 'Built the billing service in C#', evidence: ['Built the billing service'] })],
    ['C#'],
  );
  assert.equal(flags.length, 1);
});
