import assert from 'node:assert';
import test from 'node:test';
import { runChecks } from './ruleCheck';
import { describeCheck, pageTarget } from './rules';
import type { CheckableRule } from './rules';
import type { ResumeStructure } from './types';

function resume(over: Partial<ResumeStructure> = {}): ResumeStructure {
  return {
    name: 'Chukwudi Ndubuisi',
    contact: { email: 'chukwudi.can@gmail.com', github: 'github.com/chukwudican-sudo' },
    education: [
      {
        school: 'Ontario Tech University',
        location: 'Oshawa, ON',
        degree: 'Bachelor of Engineering in Software Engineering',
        dates: 'Sep 2023 – May 2028 (Expected)',
        bullets: [],
      },
    ],
    experience: [
      {
        title: 'Software Engineer',
        org: 'Droady',
        location: 'San Francisco, CA',
        dates: 'Nov 2025 – May 2026',
        bullets: ['Integrated an AI model into a production mobile app'],
      },
    ],
    projects: [
      { name: 'MealApp', tech: 'React Native', dates: 'May 2026', bullets: ['Designed an offline-first sync'] },
    ],
    skills: [{ category: 'Languages', items: 'TypeScript, Python, Java' }],
    ...over,
  };
}

const forbid = (...terms: string[]): CheckableRule[] => [
  { id: 'r1', text: `Never use ${terms.join(' or ')}`, check: { kind: 'forbidden_text', terms } },
];

// ── The five places readableText gets wrong or drops ───────────────────────
//
// proofread.ts walks a whole structure and looks like the thing to reuse, but it
// omits dates and urls and interleaves section banners as lines. Each of these
// is a place a banned word can hide that a naive reuse would miss.

test('an entry is named by something that identifies it, not just its title', () => {
  // The heading of an experience entry is the TITLE, so this used to report
  // "your Engineer entry" — which names neither employer if you have had two
  // engineering jobs.
  const r = runChecks(
    resume({
      experience: [
        { title: 'Engineer', org: 'Droady', location: 'SF', dates: '2025', bullets: ['Fine'] },
        { title: 'Engineer', org: 'RBC', location: 'Toronto', dates: '2024', bullets: ['Spearheaded it'] },
      ],
    }),
    forbid('spearheaded'),
  );
  assert.match(r[0].evidence!, /RBC/, 'the second job is the one at fault');
  assert.doesNotMatch(r[0].evidence!, /Droady/);
});

test('a long second line is left out rather than making the sentence worse', () => {
  // Education's second line is the whole degree. "your Ontario Tech University
  // at Bachelor of Engineering in Software Engineering entry" helps nobody.
  const r = runChecks(
    resume({
      education: [
        {
          school: 'Ontario Tech University',
          location: 'Oshawa, ON',
          degree: 'Bachelor of Engineering in Software Engineering',
          dates: '2023',
          bullets: ['Spearheaded the robotics club'],
        },
      ],
    }),
    forbid('spearheaded'),
  );
  assert.match(r[0].evidence!, /Ontario Tech University/);
  assert.doesNotMatch(r[0].evidence!, /Bachelor/);
});

test('a forbidden word in an experience bullet is found, and named', () => {
  const r = runChecks(
    resume({
      experience: [
        { title: 'Engineer', org: 'Droady', location: 'SF', dates: '2025', bullets: ['Spearheaded the rewrite'] },
      ],
    }),
    forbid('spearheaded'),
  );
  assert.equal(r[0].verdict, 'fail');
  assert.match(r[0].evidence!, /Droady/, 'the message should say which entry');
});

test('a forbidden word in a project bullet is found', () => {
  const r = runChecks(
    resume({ projects: [{ name: 'MealApp', tech: 'Expo', dates: '2026', bullets: ['Spearheaded the sync layer'] }] }),
    forbid('spearheaded'),
  );
  assert.equal(r[0].verdict, 'fail');
  assert.match(r[0].evidence!, /MealApp/);
});

test('a forbidden word in a custom section is found', () => {
  // The one a five-field walker misses entirely — and the exact shape of the bug
  // that put "Creditial Id 1000" on somebody's resume.
  const r = runChecks(
    resume({
      sections: [
        {
          key: 'volunteering',
          label: 'Volunteering',
          shape: 'entries',
          entries: [{ title: 'Tutor', org: 'Library', dates: '2025', bullets: ['Spearheaded a reading group'] }],
        },
      ],
    }),
    forbid('spearheaded'),
  );
  assert.equal(r[0].verdict, 'fail');
});

test('a forbidden word in a prose section is found', () => {
  const r = runChecks(
    resume({ summary: 'Engineer who spearheaded three launches.' }),
    forbid('spearheaded'),
  );
  assert.equal(r[0].verdict, 'fail');
});

test('a forbidden word in a skills group is found', () => {
  const r = runChecks(
    resume({ skills: [{ category: 'Tools', items: 'Excel, Powerpoint' }] }),
    forbid('Powerpoint'),
  );
  assert.equal(r[0].verdict, 'fail');
});

// ── The boundary, and the two omissions this walker does NOT inherit ───────

test('a word boundary holds — forbidding SQL does not flag PostgreSQL', () => {
  // correctText carries this reasoning already: without \b, a correction to "ap"
  // spreads damage across every field containing those letters.
  const r = runChecks(resume({ skills: [{ category: 'Data', items: 'PostgreSQL, Redis' }] }), forbid('SQL'));
  assert.equal(r[0].verdict, 'pass');
});

test('a forbidden word inside a date IS found — this is not a spellchecker', () => {
  const r = runChecks(
    resume({
      experience: [
        { title: 'Engineer', org: 'Droady', location: 'SF', dates: 'Nov 2025 – Present', bullets: ['Shipped it'] },
      ],
    }),
    forbid('Present'),
  );
  assert.equal(r[0].verdict, 'fail', 'readableText drops dates; a banned-word search must not');
});

test('a forbidden word inside a url IS found', () => {
  const r = runChecks(
    resume({ projects: [{ name: 'App', tech: 'Go', dates: '2026', url: 'github.com/acme/app', bullets: ['Built it'] }] }),
    forbid('acme'),
  );
  assert.equal(r[0].verdict, 'fail');
});

test('case does not matter — a rule about a word is about the word', () => {
  const r = runChecks(resume({ summary: 'SPEARHEADED a rewrite.' }), forbid('spearheaded'));
  assert.equal(r[0].verdict, 'fail');
});

test('a clean resume passes', () => {
  assert.equal(runChecks(resume(), forbid('spearheaded'))[0].verdict, 'pass');
});

test('the first offending term is the one reported', () => {
  const r = runChecks(resume({ summary: 'Utilised a framework.' }), forbid('spearheaded', 'utilised'));
  assert.match(r[0].evidence!, /utilised/i);
});

// ── Bullet length, in all four places bullets live ─────────────────────────

const short = (n: number) => 'x'.repeat(n);
const limit = (n: number): CheckableRule[] => [
  { id: 'r2', text: 'Keep every bullet to one line', check: { kind: 'max_bullet_chars', limit: n } },
];

test('an over-long bullet fails, wherever it lives', () => {
  for (const structure of [
    resume({ experience: [{ title: 'E', org: 'O', location: 'L', dates: 'D', bullets: [short(200)] }] }),
    resume({ projects: [{ name: 'P', tech: 'T', dates: 'D', bullets: [short(200)] }] }),
    resume({ education: [{ school: 'S', location: 'L', degree: 'D', dates: 'X', bullets: [short(200)] }] }),
    resume({
      sections: [
        { key: 'volunteering', label: 'Volunteering', shape: 'entries', entries: [{ title: 'T', bullets: [short(200)] }] },
      ],
    }),
  ]) {
    assert.equal(runChecks(structure, limit(110))[0].verdict, 'fail');
  }
});

test('a bullet exactly on the limit passes', () => {
  const r = runChecks(
    resume({ experience: [{ title: 'E', org: 'O', location: 'L', dates: 'D', bullets: [short(110)] }] }),
    limit(110),
  );
  assert.equal(r[0].verdict, 'pass');
});

// ── Page length, which only the rendered PDF can answer ────────────────────

const pages = (n: number): CheckableRule[] => [
  { id: 'r3', text: 'Keep it to one page', check: { kind: 'max_pages', limit: n } },
];

test('a resume within its page limit passes', () => {
  assert.equal(runChecks(resume(), pages(1), { pages: 1 })[0].verdict, 'pass');
  assert.equal(runChecks(resume(), pages(2), { pages: 1 })[0].verdict, 'pass');
});

test('a resume over its page limit fails, and says how long it is', () => {
  const r = runChecks(resume(), pages(1), { pages: 2 })[0];
  assert.equal(r.verdict, 'fail');
  assert.match(r.evidence!, /runs to 2 pages/);
  assert.match(r.fix!, /1 page/);
});

test('an unmeasured resume is never failed for its length', () => {
  // The compile service may be older than this build, or the measurement may
  // not have fitted in the request's budget. Telling somebody they broke a rule
  // the app never checked is worse than saying nothing.
  for (const measured of [{}, { pages: null }, { pages: undefined }]) {
    assert.equal(runChecks(resume(), pages(1), measured)[0].verdict, 'guidance');
  }
});

test('a check kind this build has never heard of is guidance, not a bullet rule', () => {
  // The hazard this fixes: `runChecks` treated anything that was not
  // forbidden_text as a bullet-length check and read `check.limit` off it. A
  // one-page rule would have failed every bullet longer than one character —
  // and `check` is untyped jsonb, so a kind written by a newer build can reach
  // an older one at any time.
  const fromTheFuture = [
    { id: 'r4', text: 'Something this build cannot check', check: { kind: 'max_words', limit: 1 } as any },
  ];
  const r = runChecks(
    resume({ experience: [{ title: 'E', org: 'O', location: 'L', dates: 'D', bullets: [short(200)] }] }),
    fromTheFuture,
  );
  assert.equal(r[0].verdict, 'guidance');
});

test('the page target is the tightest rule, or two when nobody said', () => {
  assert.equal(pageTarget([]), 2);
  assert.equal(pageTarget(forbid('spearheaded')), 2);
  assert.equal(pageTarget(pages(1)), 1);
  assert.equal(pageTarget([...pages(2), ...pages(1)]), 1);
  // A limit that is not a number, or is zero, is nobody saying anything.
  assert.equal(pageTarget([{ id: 'r5', text: 'x', check: { kind: 'max_pages', limit: 0 } }]), 2);
});

test('every kind of check describes itself as what it is', () => {
  assert.match(describeCheck({ kind: 'max_pages', limit: 1 })!, /fit on 1 page/);
  assert.match(describeCheck({ kind: 'max_pages', limit: 2 })!, /fit on 2 pages/);
  assert.match(describeCheck({ kind: 'max_bullet_chars', limit: 110 })!, /110 characters/);
  assert.match(describeCheck({ kind: 'forbidden_text', terms: ['UOIT'] })!, /must not contain/);
  assert.equal(describeCheck(null), null);
  assert.equal(describeCheck({ kind: 'max_words', limit: 5 } as any), null);
});

test('several over-long bullets are counted rather than listed one by one', () => {
  const r = runChecks(
    resume({
      experience: [
        { title: 'E', org: 'O', location: 'L', dates: 'D', bullets: [short(200), short(300), short(400)] },
      ],
    }),
    limit(110),
  );
  assert.match(r[0].evidence!, /3 bullets/);
});

test('a heading longer than the limit is not a bullet', () => {
  // The length rule is about bullets. A long degree name is not a bullet, and
  // flagging it would be the app enforcing something nobody asked for.
  const r = runChecks(
    resume({ education: [{ school: short(200), location: 'L', degree: 'D', dates: 'X', bullets: [] }] }),
    limit(110),
  );
  assert.equal(r[0].verdict, 'pass');
});

// ── Guidance is neither a pass nor a failure ───────────────────────────────

test('a rule with no check reads as guidance, never as a failure', () => {
  const r = runChecks(resume(), [
    { id: 'r3', text: 'Lead with impact, then the technology', check: null },
  ]);
  assert.equal(r[0].verdict, 'guidance');
  assert.equal(r[0].evidence, undefined);
});

test('every rule comes back, in the order it was given', () => {
  const r = runChecks(resume(), [
    { id: 'a', text: 'one', check: null },
    { id: 'b', text: 'two', check: { kind: 'forbidden_text', terms: ['spearheaded'] } },
    { id: 'c', text: 'three', check: { kind: 'max_bullet_chars', limit: 110 } },
  ]);
  assert.deepEqual(r.map((x) => x.ruleId), ['a', 'b', 'c'], 'order is priority — it must survive');
  assert.deepEqual(r.map((x) => x.verdict), ['guidance', 'pass', 'pass']);
});

test('a failure carries something to put in the instruction box', () => {
  const r = runChecks(resume({ summary: 'Spearheaded it.' }), forbid('spearheaded'));
  assert.ok(r[0].fix && r[0].fix.length > 0);
});
