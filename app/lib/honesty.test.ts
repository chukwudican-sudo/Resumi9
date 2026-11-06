import assert from 'node:assert/strict';
import test from 'node:test';
import { readInstruction } from './asked';
import { applyFlags, checkBullets, toldByThePerson, wholeRecord } from './honesty';
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
  context: '',
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
  // The claim itself is named, not just counted — it is the only place the
  // person can see what was nearly sent out under their name.
  assert.match(warnings[0], /stakeholders/);
  // And Droady is down to one line, which is thinner than their own rule.
  assert.equal(warnings.length, 3);
  assert.match(warnings[2], /Droady has only one line left/);
});

test('an entry left with one line is kept and said out loud', () => {
  /*
   * Not deleted, which is the difference from an entry left with nothing. One
   * real line is a real entry; taking somebody's job off because the OTHER
   * bullet was an invention would cost more than the check catches.
   */
  const structure = {
    experience: [{ org: 'Droady', bullets: ['Real work', 'Invented from nothing'] }],
    projects: [{ name: 'FraudWatch', bullets: ['One line, as it always was'] }],
  };
  const { structure: fixed, warnings } = applyFlags(structure, [
    { text: 'Invented from nothing', revertTo: '', reason: 'is not based on anything in your profile' },
  ]);
  assert.deepEqual(fixed.experience[0].bullets, ['Real work'], 'the job stays');
  assert.equal(warnings.filter((w) => /one line left/.test(w)).length, 1);
  assert.match(warnings.find((w) => /one line left/.test(w))!, /Droady/);
  assert.ok(
    !/FraudWatch/.test(warnings.find((w) => /one line left/.test(w))!),
    'an entry that always had one line is not news',
  );
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

test('an edit says the previous version, never your profile', () => {
  // On an edit the source is the version on screen. Twenty-six warnings once
  // accused somebody's own unchanged wording of not being in their profile.
  const flags = checkBullets([bullet({ text: 'Ran the department', unsourced: true })], [], undefined, 'the previous version');
  assert.match(flags[0].reason, /the previous version/);

  const { log, warnings } = applyFlags(
    { experience: [{ org: 'Droady', bullets: ['Ran the department'] }] },
    flags,
    'the previous version',
  );
  assert.match(log[0], /the previous version/);
  assert.doesNotMatch(log[0], /your profile/);
  assert.doesNotMatch(warnings[0], /your profile/);
});

test('a tailor still says your profile', () => {
  const flags = checkBullets([bullet({ text: 'Ran the department', unsourced: true })], []);
  assert.match(flags[0].reason, /your profile/);
});

// ── the answer to the app's own question ───────────────────────────────────
//
// From the Nov 4 apply run, verbatim. The app asked what the Resumi project
// should say; the person answered "schema-constrained output, hallucination
// guards, mock-mode test harness"; the model wrote two bullets from exactly
// that; and this check deleted both, because the project had been dropped
// earlier so neither bullet had a source bullet behind it. The resume saved
// with "Resumi" printed over nothing.

test('a bullet made of the person’s own answer is theirs, not an invention', () => {
  const answer =
    'Add the Resumi project back with 2 bullets on validating LLM output: schema-constrained output, hallucination guards, and a mock-mode test harness.';
  assert.equal(
    toldByThePerson('Used schema-constrained output and hallucination guards to validate every LLM response', answer),
    true,
  );
});

test('a gloss on top of their words is still not their words', () => {
  /*
   * The second bullet from that same run, and it does NOT pass: "Built a
   * mock-mode test harness to validate LLM output without live calls" is six
   * ninths his, because "without live calls" is the model explaining what
   * mock-mode means rather than something he said.
   *
   * Left failing on purpose. Two thirds would pass it and the threshold is a
   * judgement either way, so it is set where an invention cannot ride in on a
   * long instruction — and the entry no longer disappears when a bullet is
   * refused, because an emptied entry is now taken off rather than printed as
   * a bare heading. One surviving bullet keeps the project.
   */
  const answer =
    'Add the Resumi project back with 2 bullets on validating LLM output: schema-constrained output, hallucination guards, and a mock-mode test harness.';
  assert.equal(
    toldByThePerson('Built a mock-mode test harness to validate LLM output without live calls', answer),
    false,
  );
});

test('a bullet riding alongside an unrelated instruction is still an invention', () => {
  const answer = 'Make the FraudWatch bullets shorter.';
  assert.equal(
    toldByThePerson('Partnered with stakeholders across the organisation to drive alignment', answer),
    false,
  );
});

test('half somebody’s words is half invented', () => {
  // Deliberately strict: three quarters, not a majority.
  assert.equal(toldByThePerson('Used schema-constrained output and Kubernetes autoscaling on AWS Lambda', 'schema-constrained output'), false);
});

test('no instruction at all means nothing is excused', () => {
  assert.equal(toldByThePerson('Used schema-constrained output', ''), false);
});

test('a bullet of two words proves nothing either way', () => {
  assert.equal(toldByThePerson('Shipped features', 'shipped features for the team'), false);
});

// ── a heading over nothing ─────────────────────────────────────────────────

test('an entry this pass empties is taken off, not printed as a bare heading', () => {
  const structure = {
    experience: [{ org: 'Droady', bullets: ['a real one'] }],
    projects: [{ name: 'Resumi', bullets: ['invented one', 'invented two'] }],
  };
  const { structure: out, log } = applyFlags(structure as never, [
    { text: 'invented one', revertTo: '', reason: 'is not based on anything in your profile' },
    { text: 'invented two', revertTo: '', reason: 'is not based on anything in your profile' },
  ]);

  assert.deepEqual((out as any).projects, [], 'the heading goes with its last bullet');
  assert.equal((out as any).experience.length, 1, 'and nothing else is touched');
  assert.ok(log.some((l) => /Resumi had nothing left under it/.test(l)), `log was ${JSON.stringify(log)}`);
});

test('an entry that keeps one bullet keeps its heading', () => {
  const structure = { projects: [{ name: 'Resumi', bullets: ['a real one', 'invented'] }] };
  const { structure: out } = applyFlags(structure as never, [
    { text: 'invented', revertTo: '', reason: 'is not based on anything in your profile' },
  ]);
  assert.equal((out as any).projects.length, 1);
  assert.deepEqual((out as any).projects[0].bullets, ['a real one']);
});

// ── the posting's words, where the source has nothing ──────────────────────
//
// Eleven of these were found in the Nov 4 apply run. Every bullet below is
// verbatim from a generated PDF, next to the profile bullet it was written
// from and the phrase of the posting it reached for. The report's own rule
// was a two-word phrase shared with the posting; measured over all 139
// bullets of that run it reads six of the eleven, and the five it misses are
// claims built from words the source already contains.

/** Verbatim from the two Plusgrade postings of that run. */
const DATA_SCIENCE_POSTING =
  'Write clean Python and SQL on AWS, track pipeline health and data quality, flag performance anomalies before they reach partners.';
const APPLIED_AI_POSTING =
  'Write clean, low-latency Python services with FastAPI, configure AWS cloud infrastructure, build pipelines and ' +
  'caching layers to keep response times fast under strict SLAs. Requirements: solid grasp of model inference logic, ' +
  'input/output contracts, and latency constraints; strong testing practices with thorough unit and integration ' +
  'tests on every pull request.';

test('a purpose clause lifted from the posting is caught', () => {
  const flags = checkBullets(
    [
      bullet({
        text: 'Cut transient-failure recovery time from 30–45 seconds to 1–2 seconds by redesigning an offline-sync retry scheduler to flag anomalies and fire against the next real retry time instead of a fixed interval',
        evidence: ['Cut transient-failure recovery time from 30–45 seconds to 1–2 seconds by redesigning an offline-sync retry scheduler to fire against the next real retry time instead of a fixed interval'],
      }),
    ],
    [],
    undefined,
    undefined,
    DATA_SCIENCE_POSTING,
  );
  assert.equal(flags.length, 1, 'the scheduler retries failed syncs; it does not flag anomalies');
  assert.match(flags[0].reason, /from the posting/);
});

test('a condition nobody recorded is caught', () => {
  const flags = checkBullets(
    [
      bullet({
        text: 'Redesigned an offline-sync retry scheduler to fire against the next real retry time instead of a fixed interval, under tight latency constraints',
        evidence: ['Redesigned an offline-sync retry scheduler to fire against the next real retry time instead of a fixed interval'],
      }),
    ],
    [],
    undefined,
    undefined,
    APPLIED_AI_POSTING,
  );
  assert.equal(flags.length, 1);
  assert.match(flags[0].reason, /latency/);
});

test('an evaluation that was never done that way is caught', () => {
  const flags = checkBullets(
    [
      bullet({
        text: 'Built and evaluated three rule-based detection algorithms to flag anomalous activity against baseline behaviour',
        evidence: ['Built three rule-based detection algorithms to flag anomalous activity in a continuous data stream'],
      }),
    ],
    [],
    undefined,
    undefined,
    'You will train models and evaluate quality against baseline models.',
  );
  assert.equal(flags.length, 1);
  assert.match(flags[0].reason, /baselin/);
});

test('a board that tracked sprint tasks is not a defect tracker', () => {
  const flags = checkBullets(
    [
      bullet({
        text: 'Ran a two-week Agile sprint with a shared GitHub Projects board for defect tracking',
        evidence: ['Ran a two-week Agile sprint with a shared GitHub Projects board for sprint tasks'],
      }),
    ],
    [],
    undefined,
    undefined,
    'You will own defect tracking and triage across the QA function.',
  );
  assert.equal(flags.length, 1);
  assert.match(flags[0].reason, /defect track/);
});

test('reverting puts the person’s own sentence back', () => {
  const theirs = 'Redesigned an offline-sync retry scheduler to fire against the next real retry time';
  const flags = checkBullets(
    [bullet({ text: `${theirs}, under tight latency constraints`, evidence: [theirs] })],
    [], undefined, undefined, APPLIED_AI_POSTING,
  );
  assert.equal(flags[0].revertTo, theirs);
});

// ── good tailoring, which must survive ─────────────────────────────────────

test('one shared word is not an invention', () => {
  // Measured: one unsourced word that also appears in the posting fires on a
  // fifth of all bullets and catches nothing the two-word rule misses. This
  // is how a legitimate rewrite reaches for the employer's vocabulary.
  const flags = checkBullets(
    [
      bullet({
        text: 'Built three rule-based detection algorithms to flag anomalous activity in a continuous stream',
        evidence: ['Built three rule-based detection algorithms to spot anomalous activity in a continuous data stream'],
      }),
    ],
    [], undefined, undefined, 'You will flag fraud in continuous streams.',
  );
  assert.deepEqual(flags, []);
});

test('the posting’s vocabulary for a fact the source has is left alone', () => {
  const flags = checkBullets(
    [
      bullet({
        text: 'Worked on front-end (mobile, web) and back-end development alongside a small engineering team',
        evidence: ['Worked across mobile, backend, and web development alongside a small engineering team'],
      }),
    ],
    [], undefined, undefined, 'Front-end and back-end development across mobile and web.',
  );
  assert.deepEqual(flags, []);
});

test('no posting means the check does not run', () => {
  const flags = checkBullets(
    [
      bullet({
        text: 'Redesigned the retry scheduler, under tight latency constraints',
        evidence: ['Redesigned the retry scheduler'],
      }),
    ],
    [],
  );
  assert.deepEqual(flags, [], 'nothing to compare against, so nothing is claimed');
});

test('an unchanged bullet is never read for echoes', () => {
  const same = 'Redesigned an offline-sync retry scheduler under tight latency constraints';
  const flags = checkBullets(
    [bullet({ text: same, evidence: [same], changed: false })],
    [], undefined, undefined, APPLIED_AI_POSTING,
  );
  assert.deepEqual(flags, []);
});

test('the warning quotes the bullet, not the stems it was compared on', () => {
  // It read: takes "requir" and "multipl" from the posting. Somebody reading a
  // warning about their own sentence should see their own sentence.
  const flags = checkBullets(
    [
      bullet({
        text: 'Supported a 30% increase in new business by coordinating client engagement, requiring careful prioritization across multiple accounts',
        evidence: ['Contributed to a 30% increase in new business by supporting client engagement, contract execution, and operational delivery'],
      }),
    ],
    [], undefined, undefined,
    'Multitasking with attention to detail under tight deadlines is required across multiple departments.',
  );
  assert.equal(flags.length, 1);
  assert.match(flags[0].reason, /"requiring" and "multiple"/);
});

test('a lifted phrase is quoted with its own punctuation', () => {
  const flags = checkBullets(
    [
      bullet({
        text: "Integrated an AI model's input/output contract into a production mobile app",
        evidence: ['Integrated an AI/LLM model into a production mobile app'],
      }),
    ],
    [], undefined, undefined,
    'Solid grasp of model inference logic, input/output contracts, and latency constraints.',
  );
  assert.match(flags[0].reason, /"input\/output"/);
});

// ── three real flags from the Rockwell UX run ──────────────────────────────
//
// The first acceptance run flagged three bullets on that resume. Two were
// right and one was wrong, and the wrong one is why the two fixes below this
// comment exist: the person's own fact says "Did user research" and the
// rewrite said "Conducted user research", which is the one thing the rules
// name as allowed — swapping a synonym for a fact they do have.

const ROBOTICS_POSTING =
  'You will conduct user research, build wireframes and prototypes, and shape the interaction flow ' +
  'between people and robots. Figma experience and multi-discipline team experience required.';

test('a verb swapped for a sourced fact is not an invention', () => {
  const flags = checkBullets(
    [
      bullet({
        text: 'Conducted user research and wireframing/prototyping in Figma for the client-facing website design',
        evidence: ['Did user research and wireframing/prototyping in Figma for client websites'],
      }),
    ],
    [], undefined, undefined, ROBOTICS_POSTING,
  );
  assert.deepEqual(flags, [], 'conducted is did');
});

test('the purpose clause in the same sentence still is', () => {
  const flags = checkBullets(
    [
      bullet({
        text: 'Conducted user research and built wireframes/prototypes in Figma to shape the app’s interaction flow before development',
        evidence: ['Did user research and wireframing/prototyping in Figma for MealApp'],
      }),
    ],
    [], undefined, undefined, ROBOTICS_POSTING,
  );
  assert.equal(flags.length, 1, 'nothing in the source says what the research was for');
  assert.match(flags[0].reason, /shape the app’s interaction/);
});

test('a purpose lifted onto a design fact is caught', () => {
  const flags = checkBullets(
    [
      bullet({
        text: 'Designed screens and onboarding flow in Figma to shape the interaction flow between users and the app’s AI features',
        evidence: ['Designed screens and onboarding flow in Figma at Droady in San Francisco'],
      }),
    ],
    [], undefined, undefined, ROBOTICS_POSTING,
  );
  assert.equal(flags.length, 1);
  assert.match(flags[0].reason, /shape the interaction/);
});

test('wireframing and wireframes are one word', () => {
  // The stemmer took "wireframes" to wireframe and "wireframing" to
  // wirefram, so a bullet rewritten from the person's own word was flagged
  // for taking the posting's.
  const flags = checkBullets(
    [
      bullet({
        text: 'Built wireframes and prototypes in Figma',
        evidence: ['Did wireframing and prototyping in Figma'],
      }),
    ],
    [], undefined, undefined, 'Build wireframes and prototypes in Figma.',
  );
  assert.deepEqual(flags, []);
});

test('a position claimed is still an invention, however ordinary the verb', () => {
  // The do-synonyms are set aside; managed, owned, led and oversaw are not,
  // and must not be — "worked on" rewritten as "managed" is an escalation.
  const flags = checkBullets(
    [
      bullet({
        text: 'Managed the release process across three teams',
        evidence: ['Worked on the release process'],
      }),
    ],
    [], undefined, undefined, 'You will manage the release process across teams.',
  );
  assert.equal(flags.length, 1, `managed is not did; got ${JSON.stringify(flags)}`);
});

// ── the entry's own lines are a source ─────────────────────────────────────
//
// From the Intel resume: "in Python" was reverted off a Rate Limit Lab
// bullet, on a project whose Built-with line reads "Python, pytest,
// matplotlib, Git". The app calling somebody a liar about a word it printed
// itself two centimetres higher.

test('a tool named on the entry’s tech line is not an invention', () => {
  const flags = checkBullets(
    [
      bullet({
        text: 'Benchmarked a sliding window against a token bucket in Python, charting both',
        evidence: ['Benchmarked a sliding window against a token bucket, charting both'],
        context: 'Python, pytest, matplotlib, Git',
      }),
    ],
    ['python'], undefined, undefined,
    'Write clean, low-latency Python services. Python and pytest required.',
  );
  assert.deepEqual(flags, []);
});

test('without the tech line it is still caught', () => {
  // The check has not been widened, only given what the page already shows.
  const flags = checkBullets(
    [
      bullet({
        text: 'Benchmarked a sliding window against a token bucket in Python, charting both',
        evidence: ['Benchmarked a sliding window against a token bucket, charting both'],
      }),
    ],
    ['python'], undefined, undefined,
    'Write clean, low-latency Python services. Python and pytest required.',
  );
  assert.equal(flags.length, 1);
  assert.match(flags[0].reason, /python/i);
});

test('a job title is a source for what the job was', () => {
  const flags = checkBullets(
    [
      bullet({
        text: 'Advised clients on wealth management as their wealth manager',
        evidence: ['Advised clients on their portfolios'],
        context: 'Wealth Manager (Client Services & Financial Planning)',
      }),
    ],
    [], undefined, undefined, 'We are hiring a wealth manager for client services.',
  );
  assert.deepEqual(flags, []);
});

test('the tech line is never what a bullet reverts to', () => {
  // It is read, never written back: reverting a sentence to "Python, pytest,
  // matplotlib, Git" would be worse than the flag it was fixing.
  const flags = checkBullets(
    [
      bullet({
        text: 'Cut p99 latency under tight latency constraints',
        evidence: ['Cut p99 latency'],
        context: 'Python, pytest',
      }),
    ],
    [], undefined, undefined,
    'Solid grasp of model inference logic, input/output contracts, and latency constraints.',
  );
  assert.equal(flags.length, 1);
  assert.equal(flags[0].revertTo, 'Cut p99 latency');
});

// ── the echo check asks about their vocabulary, not one bullet's sources ──

const RECORD_PROFILE = {
  skills: [{ category: 'Tools & Practices', items: 'Git, GitHub Actions (CI/CD), Docker' }],
  experience: [
    { title: 'Wealth Manager', org: 'Aegon', bullets: ['Led 20+ advisors, delivering training and communication at conventions'] },
  ],
  projects: [
    { name: 'FraudWatch', tech: 'Java, REST API, CI/CD', bullets: ['Led the backend on a 3-person team'] },
    { name: 'Rate Limit Lab', tech: 'Python, FastAPI, pytest', bullets: ['Compared three rate-limiting algorithms'] },
  ],
};

const POSTING = 'We want Java, Python and Git. Strong communication. Experience with deep learning.';

/** One changed bullet whose own evidence is deliberately narrow. */
const rewritten = (text: string, evidence: string, context = ''): ResolvedBullet =>
  ({ text, changed: true, unsourced: false, evidence: [evidence], context }) as ResolvedBullet;

test('a word from their own record is not treated as taken from the posting', () => {
  /*
   * Measured on fifty-five real reverts: "git", which is in their skills;
   * "in Java", which is FraudWatch's tech line; "communication", which is in
   * their Aegon bullet. Each reverted a tailored bullet to generic wording
   * and told them their profile does not say a thing their profile says.
   */
  const record = wholeRecord(RECORD_PROFILE);
  for (const [text, evidence] of [
    ['Shipped the pipeline with Git and Docker', 'Shipped the pipeline'],
    ['Built the detection algorithms in Java', 'Built the detection algorithms'],
    ['Led advisors, improving communication across the team', 'Led advisors'],
  ] as const) {
    const narrow = checkBullets([rewritten(text, evidence)], [], undefined, undefined, POSTING, '');
    const wide = checkBullets([rewritten(text, evidence)], [], undefined, undefined, POSTING, record);
    assert.equal(wide.length, 0, `"${text}" should stand: every word of it is theirs`);
    assert.ok(narrow.length >= wide.length, 'widening the record never adds a flag');
  }
});

test('a claim that is nowhere in their record is still caught', () => {
  const record = wholeRecord(RECORD_PROFILE);
  const flags = checkBullets(
    [rewritten('Built the detection algorithms with deep learning model training', 'Built the detection algorithms')],
    [],
    undefined,
    undefined,
    POSTING,
    record,
  );
  assert.equal(flags.length, 1, 'deep learning is in the posting and nowhere in their record');
});

test('the record covers skills, entries, tech lines and answered facts', () => {
  const record = wholeRecord(RECORD_PROFILE, ['Did user research in Figma']);
  for (const word of ['Git', 'Docker', 'Aegon', 'FastAPI', 'FraudWatch', 'Figma']) {
    assert.match(record, new RegExp(word), `${word} belongs to their record`);
  }
});

test('an empty record changes nothing', () => {
  assert.equal(wholeRecord({}), '');
  const flags = checkBullets(
    [rewritten('Built it with deep learning', 'Built it')],
    [],
    undefined,
    undefined,
    POSTING,
  );
  assert.equal(flags.length, 1, 'the old behaviour, unchanged, when no record is passed');
});
