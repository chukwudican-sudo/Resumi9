import assert from 'node:assert';
import test from 'node:test';
import { matchRequirements } from './requirementMatch';
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
