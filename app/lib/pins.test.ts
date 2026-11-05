import assert from 'node:assert/strict';
import test from 'node:test';
import { missingPins, pinEntry, pinnedOverLine, readPins } from './pins';
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

// ── a standing rule ────────────────────────────────────────────────────────
//
// This one was sitting active on a real account, going to the model as prompt
// text and binding nothing. The resume for the posting it was written for
// dropped Aegon anyway.

const THE_RULE =
  'Include the Aegon Wealth Manager experience entry (at least 2 bullets) whenever it fits on one page. ' +
  'Only drop it when a clearly more relevant technical project or experience needs the space.';

test('a rule saying to include an entry pins it', () => {
  const pins = readPins(THE_RULE, RESUME, true);
  assert.deepEqual(pins.map((p) => p.text), ['Aegon']);
  assert.equal(pins[0].place, 'experience');
});

test('the same sentence in the change box is read as an addition', () => {
  // "include X" typed into the box is work for the model. Only a standing
  // rule reads it as a promise about the page.
  assert.deepEqual(readPins(THE_RULE, RESUME), []);
});

test('a page rule pins nothing, because it names nothing', () => {
  assert.deepEqual(readPins('Keep the resume one page', RESUME, true), []);
  assert.deepEqual(readPins('Keep it to one page, 10pt or larger', RESUME, true), []);
});

test('a rule about wording pins nothing', () => {
  assert.deepEqual(readPins('Never use the word synergy', RESUME, true), []);
  assert.deepEqual(readPins('Always write in past tense', RESUME, true), []);
});

test('a rule naming a skill pins the skill', () => {
  assert.deepEqual(readPins('Always include Figma in my skills', RESUME, true).map((p) => p.text), ['Figma']);
});
