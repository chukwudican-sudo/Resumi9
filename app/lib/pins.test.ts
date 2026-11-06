import assert from 'node:assert/strict';
import test from 'node:test';
import { matchedLabels, missingPins, pinEntry, pinnedOverLine, pinsFromRules, readPins, unmatchedNames } from './pins';
import type { ResumeStructure } from './types';

/**
 * The resume these are read against is the real one from the Nov 4 apply run,
 * with the wording shortened. Kudi Kitchen being both a job and a project is
 * the reason a pin records where it was found.
 */
const RESUME: ResumeStructure = {
  name: 'Chukwudi Alex',
  contact: { email: 'a@example.com' },
  education: [
    {
      school: 'Ontario Tech University',
      location: 'Oshawa, ON',
      degree: 'BEng Software Engineering',
      dates: 'Sep 2023 – 2028',
      bullets: ['Relevant Coursework: Data Structures, Web Programming, Statistics & Probability for Engineers'],
    },
  ],
  experience: [
    { title: 'Founder & Digital Creator', org: 'Kudi Kitchen', location: 'Oshawa, ON', dates: 'Mar 2025 – Present', bullets: ['Increased checkout completion rates by 15–25% by redesigning the checkout flow'] },
    { title: 'Wealth Manager', org: 'Aegon', location: 'Oshawa, ON', dates: 'May 2025 – Aug 2026', bullets: ['Grew client portfolios by 12–18% average annual return'] },
    { title: 'Software Engineer', org: 'Droady', location: 'San Francisco, CA', dates: 'Nov 2025 – May 2026', bullets: ['Contributed to the AI physique rating feature in a production mobile app'] },
    { title: 'Operations & Client Engagement', org: 'WesternBell International Ltd.', location: 'Lagos, NG', dates: 'Jun 2024 – Jan 2025', bullets: ['Handled procurement, inventory tracking and logistics for 200+ industrial gas cylinders'] },
  ],
  projects: [
    { name: 'Resumi', tech: 'Next.js', dates: 'Jun 2026 – Present', bullets: ['Built a resume tailoring app'] },
    { name: 'Kudi Kitchen', tech: 'Cloudflare Workers', dates: '2026', bullets: ['Hand-coded rebuild replacing Shopify'] },
  ],
  skills: [
    { category: 'Languages', items: 'JavaScript, TypeScript, Python, SQL' },
    { category: 'Frontend', items: 'React, Next.js, Tailwind CSS, Figma' },
    { category: 'AI & Data', items: 'LLM/AI API Integration, Prompt Engineering' },
  ],
};

// ── reading one ────────────────────────────────────────────────────────────

test('keep a job', () => {
  assert.deepEqual(readPins('keep Western Bell', RESUME), [
    { place: 'experience', text: 'WesternBell International Ltd.', label: 'WesternBell International Ltd.' },
  ]);
});

test('a refused removal is the same promise', () => {
  // asked.ts correctly licenses nothing from this. Nothing recorded that the
  // opposite was asked for, so the next fit dropped it again.
  const pins = readPins("don't remove the Aegon job", RESUME);
  assert.deepEqual(pins.map((p) => p.text), ['Aegon']);
});

test('never drop, do not take off, stop cutting', () => {
  for (const said of ['never drop Aegon', 'do not take Aegon off', 'stop cutting the Aegon job']) {
    assert.deepEqual(readPins(said, RESUME).map((p) => p.text), ['Aegon'], said);
  }
});

test('a skills line by its name', () => {
  assert.deepEqual(readPins('keep the AI & Data line', RESUME), [
    { place: 'skills', text: 'AI & Data', label: 'the AI & Data line' },
  ]);
});

test('a single tool, with nothing calling it a skill', () => {
  assert.deepEqual(readPins("don't drop Figma", RESUME), [
    { place: 'skills', text: 'Figma', label: 'Figma' },
  ]);
});

test('a tool that is not in their skills is not read as one', () => {
  assert.deepEqual(readPins("don't drop Kubernetes", RESUME), []);
});

test('a name on both lists, with the sentence saying which', () => {
  assert.deepEqual(readPins('keep the Kudi Kitchen job', RESUME).map((p) => p.place), ['experience']);
  assert.deepEqual(readPins('keep the Kudi Kitchen project', RESUME).map((p) => p.place), ['projects']);
});

test('a name on both lists, with the sentence saying neither', () => {
  // Keeping too much is answered with a sentence; keeping too little is
  // answered with a resume that lost it.
  assert.deepEqual(readPins('keep Kudi Kitchen', RESUME).map((p) => p.place), ['experience', 'projects']);
});

test('a bullet, by what it is about', () => {
  const pins = readPins('keep the bullet about the 200+ gas cylinders', RESUME);
  assert.equal(pins.length, 1);
  assert.equal(pins[0].place, 'bullet');
  assert.match(pins[0].text, /cylinders/);
});

test('a bullet nothing answers to is not guessed at', () => {
  assert.deepEqual(readPins('keep the bullet about the warehouse rota', RESUME), []);
});

// ── reading nothing ────────────────────────────────────────────────────────

test('keep about length promises nothing', () => {
  for (const said of ['keep it to one page', 'keep the Aegon bullets short', 'keep it concise']) {
    assert.deepEqual(readPins(said, RESUME), [], said);
  }
});

test('a removal is not a pin', () => {
  assert.deepEqual(readPins('remove the Aegon job', RESUME), []);
});

test('a sentence with no keeping in it at all', () => {
  assert.deepEqual(readPins('shorten the Droady bullets', RESUME), []);
  assert.deepEqual(readPins('', RESUME), []);
});

test('include on its own is an addition, not a promise', () => {
  // "include the physique metric" is work for the model. "must include" is a
  // promise about the page.
  assert.deepEqual(readPins('include Figma', RESUME), []);
  assert.deepEqual(readPins('must include Figma', RESUME).map((p) => p.text), ['Figma']);
});

// ── checking one still holds ───────────────────────────────────────────────

test('a kept job holds; a dropped one does not', () => {
  const pins = [pinEntry('experience', 'WesternBell International Ltd.')];
  assert.deepEqual(missingPins(RESUME, pins), []);
  const without = { ...RESUME, experience: RESUME.experience.filter((e) => !/Western/.test(e.org)) };
  assert.deepEqual(missingPins(without, pins).map((p) => p.label), ['WesternBell International Ltd.']);
});

test('the job being gone is not excused by the project of the same name', () => {
  const pins = [pinEntry('experience', 'Kudi Kitchen')];
  const noJob = { ...RESUME, experience: RESUME.experience.filter((e) => e.org !== 'Kudi Kitchen') };
  assert.deepEqual(missingPins(noJob, pins).length, 1, 'the project does not stand in for the job');
});

test('a skills line written differently still holds', () => {
  // A tailor writes "AI and Data" and the pin was read off "AI & Data".
  const pins = readPins('keep the AI & Data line', RESUME);
  const reworded = {
    ...RESUME,
    skills: [{ category: 'AI and Data', items: 'LLM/AI API Integration' }],
  };
  assert.deepEqual(missingPins(reworded, pins), []);
});

test('a pinned tool holds wherever in the line it sits', () => {
  const pins = readPins("don't drop Figma", RESUME);
  const moved = {
    ...RESUME,
    skills: [{ category: 'Design', items: 'Figma, Framer' }],
  };
  assert.deepEqual(missingPins(moved, pins), []);
  const gone = { ...RESUME, skills: [{ category: 'Frontend', items: 'React, Next.js' }] };
  assert.deepEqual(missingPins(gone, pins).map((p) => p.label), ['Figma']);
});

test('a pinned bullet that was trimmed away', () => {
  const pins = readPins('keep the bullet about the 200+ gas cylinders', RESUME);
  const trimmed = {
    ...RESUME,
    experience: RESUME.experience.map((e) => (/Western/.test(e.org) ? { ...e, bullets: [] } : e)),
  };
  assert.equal(missingPins(trimmed, pins).length, 1);
});

test('no pins means nothing is missing', () => {
  assert.deepEqual(missingPins(RESUME, []), []);
});

// ── saying so ──────────────────────────────────────────────────────────────

test('one pinned thing over the limit', () => {
  assert.equal(
    pinnedOverLine([pinEntry('experience', 'Western Bell')], 2, 1),
    'You asked to keep Western Bell. With it on the page this runs to 2 pages and your rules ask for 1 — it is kept, so the page rule is the one that gives.',
  );
});

test('several of them read as a list', () => {
  const line = pinnedOverLine(
    [pinEntry('experience', 'Western Bell'), { place: 'skills', text: 'Figma', label: 'Figma' }],
    2,
    1,
  );
  assert.match(line, /keep Western Bell and Figma\b/);
  assert.match(line, /they are kept/);
});

// ── pins from a standing rule's check ──────────────────────────────────────
//
// Pins were briefly read out of the TEXT of written rules by a regex at
// tailor time. That was fragile on free prose, invisible — nothing on screen
// said what had been bound — and it turned a sentence somebody meant as
// guidance into a constraint. The meaning is read once now, when the rule is
// written, and this reads the stored reading.

const rule = (names: string[]) => ({ check: { kind: 'always_include', names } });

test('a rule naming a job pins the job', () => {
  assert.deepEqual(pinsFromRules([rule(['Aegon'])], RESUME), [
    { place: 'experience', text: 'Aegon', label: 'Aegon' },
  ]);
});

test('a rule naming a project pins the project', () => {
  assert.deepEqual(pinsFromRules([rule(['Resumi'])], RESUME).map((p) => p.place), ['projects']);
});

test('a name on both lists pins both', () => {
  // Kudi Kitchen is a job and a project here. Keeping too much is answered
  // with a sentence; keeping too little is answered with a resume that lost it.
  assert.deepEqual(pinsFromRules([rule(['Kudi Kitchen'])], RESUME).map((p) => p.place), ['experience', 'projects']);
});

test('a rule naming a skills line pins the line', () => {
  assert.deepEqual(pinsFromRules([rule(['AI & Data'])], RESUME), [
    { place: 'skills', text: 'AI & Data', label: 'the AI & Data line' },
  ]);
});

test('a rule naming one tool pins the tool', () => {
  assert.deepEqual(pinsFromRules([rule(['Figma'])], RESUME).map((p) => p.text), ['Figma']);
});

test('several rules, and the same name twice, pin once each', () => {
  const pins = pinsFromRules([rule(['Aegon', 'Figma']), rule(['Aegon'])], RESUME);
  assert.deepEqual(pins.map((p) => p.text), ['Aegon', 'Figma']);
});

test('a name that is not on this resume pins nothing', () => {
  // A rule outlives a profile edit, and a promise the fitter cannot keep
  // would report the page rule as unmeetable for ever.
  assert.deepEqual(pinsFromRules([rule(['A job they deleted'])], RESUME), []);
});

test('a rule with no check binds nothing', () => {
  // The ambiguous ones. They show as guidance on the rules page and reach the
  // model as prose, which is all they ever claimed to do.
  assert.deepEqual(pinsFromRules([{ check: null }, {}], RESUME), []);
  assert.deepEqual(pinsFromRules([{ check: { kind: 'max_pages', limit: 1 } }], RESUME), []);
});

test('a malformed check is ignored rather than thrown on', () => {
  // `check` is untyped jsonb, so a shape written by another build can arrive.
  assert.deepEqual(
    pinsFromRules([{ check: { kind: 'always_include' } }, { check: { kind: 'always_include', names: 'Aegon' } }], RESUME),
    [],
  );
});

test('a rule naming a degree pins nothing, because education is never cut', () => {
  assert.deepEqual(pinsFromRules([rule(['Ontario Tech University'])], RESUME), []);
});

test('a rule names a job loosely and the pin still holds', () => {
  /*
   * The real one, and it pinned nothing.
   *
   * The rule read "Always include the Aegon Wealth Manager experience entry",
   * so its check stored "Aegon Wealth Manager" — a title and an employer run
   * together. That resolves to the right entry, whose org is "Aegon" and
   * whose title is "Wealth Manager (...)" — and a pin carrying the rule's own
   * phrasing matched neither, so it was dropped as naming something not on
   * the resume. Nothing pinned, nothing said, the job dropped as before.
   */
  const pins = pinsFromRules([rule(['Aegon Wealth Manager', 'Droady Software Engineer'])], RESUME);
  assert.deepEqual(pins, [
    { place: 'experience', text: 'Aegon', label: 'Aegon' },
    { place: 'experience', text: 'Droady', label: 'Droady' },
  ]);
  // And the pin holds against the resume it was read from, which is the test
  // that failed before: a pin nothing can match is silently no pin at all.
  assert.deepEqual(missingPins(RESUME, pins), []);
});

// ── a rule naming something they do not have ───────────────────────────────

test('a name that matches no entry is reported, not pinned', () => {
  assert.deepEqual(unmatchedNames({ kind: 'always_include', names: ['Aegon', 'Barclays'] }, RESUME), ['Barclays']);
});

test('nothing unmatched when every name lands', () => {
  assert.deepEqual(unmatchedNames({ kind: 'always_include', names: ['Aegon', 'Figma', 'Resumi'] }, RESUME), []);
});

test('only an always_include check has names to match', () => {
  assert.deepEqual(unmatchedNames({ kind: 'max_pages', limit: 1 }, RESUME), []);
  assert.deepEqual(unmatchedNames(null, RESUME), []);
  assert.deepEqual(unmatchedNames({ kind: 'always_include', names: 'Aegon' }, RESUME), []);
});

// ── the three ways people name a job ───────────────────────────────────────

test('employer, title, or both together', () => {
  // All four of these are one job: org "Droady", title "Software Engineer".
  for (const name of ['Droady', 'Droady Software Engineer', 'Software Engineer at Droady', 'the Software Engineer role']) {
    const pins = pinsFromRules([rule([name])], RESUME);
    assert.deepEqual(pins.map((p) => p.text), ['Droady'], name);
  }
});

test('a title with a parenthetical is matched without it', () => {
  // "Wealth Manager (Client Services & Financial Planning)" is one job, and
  // nobody types that out.
  const pins = pinsFromRules([rule(['Wealth Manager'])], RESUME);
  assert.deepEqual(pins.map((p) => p.text), ['Aegon']);
});

test('one word of a title does not pin a job', () => {
  // Otherwise a rule about a skill starts pinning employment: "always include
  // Python" must not match a "Python Developer" entry.
  const pins = pinsFromRules([rule(['Software'])], RESUME);
  assert.deepEqual(pins, []);
});

test('two jobs sharing a title are both pinned', () => {
  // The rule is ambiguous and keeping both is the safe reading: too much is
  // answered with a sentence, too little loses somebody's job.
  const twice: ResumeStructure = {
    ...RESUME,
    experience: [
      ...RESUME.experience,
      { title: 'Software Engineer', org: 'Celestica', location: 'Toronto, ON', dates: '2024', bullets: ['a', 'b'] },
    ],
  };
  const pins = pinsFromRules([rule(['Software Engineer'])], twice);
  assert.deepEqual(pins.map((p) => p.text), ['Droady', 'Celestica']);
});

// ── what the row says it matched ───────────────────────────────────────────

test('a job resolves to its title and employer', () => {
  // How somebody checks the app understood which job they meant. Repeating
  // their own words back confirms nothing.
  assert.deepEqual(matchedLabels({ kind: 'always_include', names: ['Aegon Wealth Manager'] }, RESUME), [
    'Wealth Manager at Aegon',
  ]);
});

test('one rule matching two jobs names both', () => {
  const twice: ResumeStructure = {
    ...RESUME,
    experience: [
      ...RESUME.experience,
      { title: 'Software Engineer', org: 'Celestica', location: 'Toronto, ON', dates: '2024', bullets: ['a', 'b'] },
    ],
  };
  assert.deepEqual(matchedLabels({ kind: 'always_include', names: ['Software Engineer'] }, twice), [
    'Software Engineer at Droady',
    'Software Engineer at Celestica',
  ]);
});

test('a project and a skill read as themselves', () => {
  assert.deepEqual(matchedLabels({ kind: 'always_include', names: ['Resumi', 'Figma', 'AI & Data'] }, RESUME), [
    'Resumi',
    'Figma',
    'the AI & Data line',
  ]);
});

test('nothing matched, nothing to list', () => {
  assert.deepEqual(matchedLabels({ kind: 'always_include', names: ['Barclays'] }, RESUME), []);
  assert.deepEqual(matchedLabels({ kind: 'max_pages', limit: 1 }, RESUME), []);
});

// ── a promise made in one clause of a two-clause sentence ──────────────────

test('a keep clause pins only the section it names', () => {
  /*
   * "Remove the Kudi Kitchen entry from Technical Projects only. Keep the
   * Kudi Kitchen job in Experience."
   *
   * Read as one sentence this says "Projects" and it says "job", and this
   * profile has a Kudi Kitchen in both — so it pinned both. The project the
   * person had just asked to delete became permanently uncuttable, and three
   * versions later the fitter reported their one-page rule unmeetable
   * because of a promise they never made.
   */
  const pins = readPins(
    'Remove the Kudi Kitchen entry from Technical Projects only. Keep the Kudi Kitchen job in Experience.',
    RESUME,
  );
  assert.deepEqual(pins, [pinEntry('experience', 'Kudi Kitchen')]);
});

test('a keep clause with no section word still pins both', () => {
  // Nothing narrows it, and keeping too much is a message while keeping too
  // little is a resume that lost something.
  const pins = readPins('keep Kudi Kitchen', RESUME);
  assert.deepEqual(pins, [pinEntry('experience', 'Kudi Kitchen'), pinEntry('projects', 'Kudi Kitchen')]);
});

test('a one-clause promise reads exactly as it did', () => {
  assert.deepEqual(readPins('keep the Aegon job', RESUME), [pinEntry('experience', 'Aegon')]);
  assert.deepEqual(readPins('keep the Resumi project', RESUME), [pinEntry('projects', 'Resumi')]);
});

test('a removal clause on its own promises nothing', () => {
  assert.deepEqual(readPins('Remove the Kudi Kitchen entry from Technical Projects only.', RESUME), []);
});
