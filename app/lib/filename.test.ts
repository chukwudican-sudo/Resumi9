import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FILENAME_MAX_BASE_LENGTH,
  buildDefaultFilenameBase,
  sanitizeFilenameInput,
  withVersion,
} from './filename';

/*
 * A filename is the first thing a recruiter sees of a resume and the only
 * thing they see of it in a folder, so every rule here is about what that
 * reader can tell from the name alone.
 */

// ── never half a word ─────────────────────────────────────────────────────

test('a long role is shortened by whole words', () => {
  // "Chukwudi_Alex_GPUAIAcceleratorHardwar_Intel_Resume.pdf" shipped once.
  const base = buildDefaultFilenameBase(
    'Chukwudi Alex',
    'GPU & AI Accelerator Hardware Design Undergrad Intern',
    'Intel Corporation',
  );
  assert.ok(base.length <= FILENAME_MAX_BASE_LENGTH);
  assert.ok(!/Hardwar(?!e)/.test(base), `"${base}" cuts a word in half`);
  assert.match(base, /^Chukwudi_Alex_/);
  assert.match(base, /_Resume$/);
});

test('a hyphenated compound counts as one word', () => {
  const base = buildDefaultFilenameBase('Chukwudi Alex', 'Software Engineer Co-op/Intern', 'Celestica');
  assert.ok(!/Co$/.test(base.replace(/_Celestica_Resume$/, '')), `"${base}" split a hyphenated word`);
});

test('a short one is left alone', () => {
  assert.equal(buildDefaultFilenameBase('Chukwudi Alex', 'Analyst', 'Aegon'), 'Chukwudi_Alex_Analyst_Aegon_Resume');
});

test('no role or company still names the person', () => {
  assert.equal(buildDefaultFilenameBase('Chukwudi Alex', '', ''), 'Chukwudi_Alex_Resume');
});

test('typed input loses what a filesystem will not take', () => {
  assert.equal(sanitizeFilenameInput('my resume (final!)'), 'my_resume_final');
});


// ── telling one download from another ─────────────────────────────────────

test('version 1 is left bare', () => {
  // The common case is one download, and a _v1 on it reads as a draft.
  assert.equal(withVersion('Chukwudi_Alex_TradeFloor_Scotiabank_Resume', 1), 'Chukwudi_Alex_TradeFloor_Scotiabank_Resume');
  assert.equal(withVersion('Chukwudi_Alex_Resume', null), 'Chukwudi_Alex_Resume');
  assert.equal(withVersion('Chukwudi_Alex_Resume', undefined), 'Chukwudi_Alex_Resume');
});

test('every later version carries its number', () => {
  /*
   * Twelve downloads of one application all arrived as the same name, so the
   * browser numbered them "(1)", "(2)" in download order — which has nothing
   * to do with the version, and no way to tell which one was sent.
   */
  assert.equal(withVersion('Chukwudi_Alex_TradeFloor_Scotiabank_Resume', 4), 'Chukwudi_Alex_TradeFloor_Scotiabank_Resume_v4');
});

test('the suffix fits inside the length limit, on a word boundary', () => {
  const long = buildDefaultFilenameBase(
    'Chukwudi Alex',
    'GPU & AI Accelerator Hardware Design Undergrad Intern',
    'Intel Corporation',
  );
  const withIt = withVersion(long, 7);
  assert.ok(withIt.length <= FILENAME_MAX_BASE_LENGTH, `${withIt} is ${withIt.length} characters`);
  assert.match(withIt, /_v7$/);
  assert.ok(!/_$/.test(withIt.replace(/_v7$/, '')), 'no trailing separator where a word was dropped');
});

test('a dropped word goes whole', () => {
  // The rule the rest of this file exists for: never half a word.
  const base = 'Chukwudi_Alex_MachineLearning_Qualcomm_Resume';
  const out = withVersion(base, 12);
  for (const piece of out.replace(/_v12$/, '').split('_')) {
    assert.ok(base.split('_').includes(piece), `"${piece}" is not a whole word from the original`);
  }
});
