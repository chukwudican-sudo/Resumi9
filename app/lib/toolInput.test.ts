import assert from 'node:assert/strict';
import test from 'node:test';
import { EXTRACT_TOOL, tailorToolFor } from '../api/claude/shared';
import { recoverToolInput } from './toolInput';

/**
 * Built against the real tool definitions, so a schema change that alters what
 * counts as "the wrong shape" shows up here rather than in production.
 *
 * The resume below is invented. The SHAPE of the jammed answer is copied from a
 * real failed tailor, masked character by character before anyone looked at it.
 */
const TAILOR = tailorToolFor({ hasSummary: true });

const RESUME = {
  summary: 'Engineering student building AI tools.',
  skills: [{ category: 'Languages', items: 'Python, Java' }],
  experience: [
    { id: 'e0', title: 'Intern', dates: 'May 2025 – Aug 2025', org: 'Acme', location: 'Toronto, ON', bullets: [{ from: ['e0.b0'] }] },
  ],
  projects: [
    { id: 'p0', name: 'Parser', tech: 'Python', dates: '2025', bullets: [{ from: ['p0.b0'], text: 'Wrote a parser that handles {curly} input' }] },
  ],
  education: [{ id: 'd0', school: 'Ontario Tech University', dates: '2023 – 2028', bullets: [] }],
};

const jam = (resume: unknown, extra = '') =>
  `${JSON.stringify(resume)}</parameter>\n` +
  '<parameter name="log">["Reordered projects around the posting"]</parameter>\n' +
  '<parameter name="matchScore">40</parameter>\n' +
  '<parameter name="missingRequirements">["Docker", "Kubernetes"]</parameter>\n' +
  '<parameter name="cutOrder">["p0.b0", "e0"]</parameter>\n' +
  '<parameter name="warnings">[]</parameter>\n' +
  extra +
  '</invoke>\n';

test('every answer jammed into the resume field is put back in its own place', () => {
  // The real failure: one field arrived, holding all six.
  const { input, repaired } = recoverToolInput({ structure: jam(RESUME) }, TAILOR);

  assert.deepEqual(input.structure, RESUME);
  assert.deepEqual(input.log, ['Reordered projects around the posting']);
  assert.equal(input.matchScore, 40);
  assert.deepEqual(input.missingRequirements, ['Docker', 'Kubernetes']);
  assert.deepEqual(input.cutOrder, ['p0.b0', 'e0']);
  assert.deepEqual(input.warnings, []);
  assert.deepEqual([...repaired].sort(), ['cutOrder', 'log', 'matchScore', 'missingRequirements', 'structure', 'warnings']);
});

test('a brace inside a bullet does not end the resume early', () => {
  const { input } = recoverToolInput({ structure: jam(RESUME) }, TAILOR);
  assert.equal((input.structure as typeof RESUME).projects[0].bullets[0].text, 'Wrote a parser that handles {curly} input');
});

test('a resume sent as a plain JSON string, with nothing jammed, is parsed', () => {
  const { input, repaired } = recoverToolInput(
    { structure: JSON.stringify(RESUME), log: ['x'], matchScore: 50, missingRequirements: [], cutOrder: [], warnings: [] },
    TAILOR,
  );
  assert.deepEqual(input.structure, RESUME);
  assert.deepEqual(repaired, ['structure']);
});

test('a well-formed answer comes back exactly as it arrived', () => {
  const answer = { structure: RESUME, log: ['x'], matchScore: 72, missingRequirements: ['Go'], cutOrder: ['e0'], warnings: [] };
  const { input, repaired } = recoverToolInput(answer, TAILOR);
  assert.deepEqual(input, answer);
  assert.deepEqual(repaired, []);
});

test('a field that arrived properly is never overwritten by a jammed copy', () => {
  const { input } = recoverToolInput({ structure: jam(RESUME), matchScore: 88, log: ['the real log'] }, TAILOR);
  assert.equal(input.matchScore, 88);
  assert.deepEqual(input.log, ['the real log']);
});

test('text that is not a resume is left alone, so the refusal stays honest', () => {
  // Guessing here would save something nobody wrote. Leaving it lets the guard
  // say "that came back unusable" and refund, which is the truth.
  const garbage = 'I could not complete this request.</parameter>\n</invoke>';
  const { input, repaired } = recoverToolInput({ structure: garbage }, TAILOR);
  assert.equal(input.structure, garbage);
  assert.deepEqual(repaired, []);
});

test('a jammed parameter the tool does not have is ignored', () => {
  const { input } = recoverToolInput(
    { structure: jam(RESUME, '<parameter name="deleteEverything">true</parameter>\n') },
    TAILOR,
  );
  assert.equal('deleteEverything' in input, false);
});

test('a text field that swallowed the rest keeps only its own text', () => {
  const { input } = recoverToolInput(
    {
      company: 'IBM</parameter>\n<parameter name="role">AI Software Engineer Intern</parameter>\n<parameter name="requirements">["Python"]</parameter>\n</invoke>',
    },
    EXTRACT_TOOL,
  );
  assert.equal(input.company, 'IBM');
  assert.equal(input.role, 'AI Software Engineer Intern');
  assert.deepEqual(input.requirements, ['Python']);
});

test('an ordinary text field that happens to look like JSON is never reinterpreted', () => {
  // A job description is somebody's words. Only the call's own markers are
  // evidence that anything was swallowed into one.
  const answer = { company: 'Acme', role: 'Intern', description: '{"not": "a structure"}', location: '', requirements: [] };
  const { input, repaired } = recoverToolInput(answer, EXTRACT_TOOL);
  assert.equal(input.description, '{"not": "a structure"}');
  assert.deepEqual(repaired, []);
});

test('an answer that is not an object at all does not throw', () => {
  assert.deepEqual(recoverToolInput(undefined, TAILOR), { input: {}, repaired: [] });
  assert.deepEqual(recoverToolInput('nonsense', TAILOR), { input: {}, repaired: [] });
});
