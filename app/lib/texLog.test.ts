import assert from 'node:assert/strict';
import test from 'node:test';
import { pagesFromLog } from './texLog';

/**
 * The fixtures are real output, not invented shapes. The first is the line
 * tectonic 0.16.9 printed when compiling this app's own profile, which is what
 * the whole measurement rests on.
 */

test('the line tectonic actually prints is read', () => {
  assert.equal(pagesFromLog('Output written on main.pdf (2 pages, 38717 bytes).'), 2);
});

test('one page has no "s", and still counts', () => {
  assert.equal(pagesFromLog('Output written on main.pdf (1 page, 21044 bytes).'), 1);
});

test('the intermediate format is read the same way', () => {
  // Plain XeTeX names main.xdv rather than main.pdf, depending on how the run
  // was driven. The filename is not what is being matched.
  assert.equal(pagesFromLog('Output written on main.xdv (3 pages, 51200 bytes).'), 3);
});

test('the line is found inside a whole log', () => {
  const log = [
    'This is XeTeX, Version 3.141592653-2.6-0.999995',
    'entering extended mode',
    '(./main.tex',
    'LaTeX Warning: Reference `x\' on page 1 undefined.',
    'Output written on main.pdf (2 pages, 38717 bytes).',
    'Transcript written on main.log.',
  ].join('\n');
  assert.equal(pagesFromLog(log), 2);
});

test('no line means not measured, which is a fact and not a failure', () => {
  // A cached compile has no fresh log, and an older compile service sends no
  // header. Everything downstream states "not measured" rather than failing:
  // the resume saves, and a page rule reads as guidance.
  for (const nothing of ['', null, undefined, 'Transcript written on main.log.', 'no pages here']) {
    assert.equal(pagesFromLog(nothing), null);
  }
});

test('a count that is not a real page count is refused', () => {
  assert.equal(pagesFromLog('Output written on main.pdf (0 pages, 0 bytes).'), null);
});
