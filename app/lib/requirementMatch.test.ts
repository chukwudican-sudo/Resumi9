import assert from 'node:assert';
import test from 'node:test';
import { gapsAfterEdit, matchRequirements, rescore } from './requirementMatch';
import type { ResumeStructure } from './types';

function resume(over: Partial<ResumeStructure> = {}): ResumeStructure {
  return {
    name: 'Chukwudi Alex',
    contact: { email: 'chukwudi.can@gmail.com' },
    education: [],
    experience: [
      {
        title: 'Software Engineer',
        org: 'Droady',
        location: 'Toronto, ON',
        dates: 'Nov 2025 – May 2026',
        bullets: ['Built data visualisation dashboards over REST APIs', 'Wrote statistical modelling notebooks'],
      },
    ],
    projects: [{ name: 'FraudWatch', tech: 'Python, PowerBI', dates: 'May 2026', bullets: ['Anomaly detection pipeline'] }],
    skills: [
      { category: 'Languages', items: 'JavaScript, TypeScript, Python, SQL, C++, HTML/CSS' },
      { category: 'AI & Data', items: 'LLM/AI API Integration, Prompt Engineering' },
      { category: 'Tools', items: 'MS Excel, PostgreSQL' },
    ],
    ...over,
  };
}

const found = (requirement: string, r: ResumeStructure = resume()) =>
  matchRequirements(r, [requirement]).have.length === 1;

// ── The case that prompted the aliases ─────────────────────────────────────

test('generative AI is satisfied by LLM work', () => {
  // The real profile says "LLM/AI API Integration" and never the words
  // "generative AI". A word-for-word check called that missing.
  assert.equal(found('generative ai'), true);
});

test('the reverse is not assumed: generative AI may not mean LLMs', () => {
  const r = resume({ skills: [{ category: 'AI', items: 'Generative AI' }] });
  assert.equal(found('llm', r), false);
});

// ── Where \b gets technical terms wrong ────────────────────────────────────

test('C++ is found, and the C inside it is not', () => {
  assert.equal(found('c++'), true);
  assert.equal(found('c'), false);
});

test('a one-letter term is not stretched into another word', () => {
  // With a plural allowed, "C" would find "CS", the degree.
  assert.equal(found('c', resume({ skills: [{ category: 'Study', items: 'CS' }] })), false);
});

// ── The three loosenings ───────────────────────────────────────────────────

test('spacing does not hide a tool', () => {
  assert.equal(found('power bi'), true); // written "PowerBI"
});

test('a hyphen the resume does not use is not a different word', () => {
  // "back-end development" asked for, "backend" written. The separator may be a
  // space, a hyphen, or nothing at all, in either direction.
  const r = resume({
    skills: [{ category: 'Engineering', items: 'Backend, Frontend, Full Stack' }],
  });
  assert.equal(found('back-end', r), true);
  assert.equal(found('front end', r), true);
  assert.equal(found('full-stack', r), true);
});

test('a vendor prefix is not part of the product', () => {
  assert.equal(found('ms excel'), true);
  assert.equal(found('excel'), true);
});

test('Canadian spelling on the resume meets American in the posting', () => {
  assert.equal(found('data visualization'), true);
  assert.equal(found('statistical modeling'), true);
});

test('a plural on the resume still counts', () => {
  assert.equal(found('rest api'), true); // written "REST APIs"
});

// ── What it must not claim ─────────────────────────────────────────────────

test('a related skill is not the skill', () => {
  assert.equal(found('tableau'), false); // Power BI is on it; Tableau is not
  assert.equal(found('sql', resume({ skills: [{ category: 'DB', items: 'PostgreSQL' }] })), false);
});

test('both lists keep the posting’s order', () => {
  const match = matchRequirements(resume(), ['tableau', 'python', 'word', 'sql']);
  assert.deepEqual(match.have, ['python', 'sql']);
  assert.deepEqual(match.missing, ['tableau', 'word']);
});

test('with no profile, nothing is found', () => {
  assert.deepEqual(matchRequirements(null, ['python']), { have: [], missing: ['python'] });
});

// ── after a hand edit ──────────────────────────────────────────────────────
//
// The review panel said 35/100 above "they ask for 13 things you have not
// mentioned", and neither moved no matter what was edited — so a resume could
// gain the exact tool a posting asked for and still be told it was missing.

test('a gap the edit closed stops being listed', () => {
  const carried = ['PyTorch', 'Kubernetes'];
  const edited = resume({
    skills: [{ category: 'AI & Data', items: 'PyTorch, Prompt Engineering' }],
  });
  const gaps = gapsAfterEdit(carried, edited, ['PyTorch', 'Kubernetes']);
  assert.deepEqual(gaps, ['Kubernetes']);
});

test('a gap the edit did not close stays listed', () => {
  assert.deepEqual(gapsAfterEdit(['Kubernetes'], resume(), ['Kubernetes']), ['Kubernetes']);
});

test('a requirement the edit deleted the evidence for is added', () => {
  // Python was in Languages; an edit took the whole skills group out.
  const stripped = resume({ skills: [], projects: [] });
  assert.ok(gapsAfterEdit([], stripped, ['Python']).includes('Python'));
});

test('the model’s own wording is kept rather than replaced', () => {
  const carried = ['Feature Engineering / Loss Function Design experience'];
  const gaps = gapsAfterEdit(carried, resume(), ['Feature Engineering']);
  assert.deepEqual(gaps, ['Feature Engineering / Loss Function Design experience']);
});

test('nothing is listed twice', () => {
  const gaps = gapsAfterEdit(['Kubernetes'], resume(), ['Kubernetes']);
  assert.equal(gaps.length, 1);
});

test('closing a gap moves the score up, opening one moves it back', () => {
  const twenty = Array.from({ length: 20 }, (_, i) => `req${i}`);
  assert.equal(rescore(35, ['a', 'b'], ['b'], twenty), 40);
  assert.equal(rescore(35, ['b'], ['a', 'b'], twenty), 30);
});

test('an edit that changed no requirement leaves the score alone', () => {
  assert.equal(rescore(35, ['a'], ['a'], ['x', 'y']), 35);
});

test('the score never leaves 0 to 100', () => {
  assert.equal(rescore(98, ['a', 'b', 'c'], [], ['x', 'y', 'z']), 100);
  assert.equal(rescore(2, [], ['a', 'b', 'c'], ['x', 'y', 'z']), 0);
});

test('a resume with no score to move keeps none', () => {
  assert.equal(rescore(null, ['a'], [], ['x']), null);
});

test('a posting with no requirements cannot move the score', () => {
  assert.equal(rescore(35, ['a'], [], []), 35);
});
