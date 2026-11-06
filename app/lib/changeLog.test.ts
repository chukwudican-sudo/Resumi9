import test from 'node:test';
import assert from 'node:assert/strict';
import { aboutWhatSurvived, asLines, entryNames, mendSplitLines, splitWarnings, storedLines, withRulesQuoted, withoutOrderTalk } from './changeLog';

// ── asLines ────────────────────────────────────────────────────────────────
//
// The bug this exists for: the model answered a request for a list with one
// sentence, and spreading a string spreads its letters.

test('a bare sentence is one line, not its letters', () => {
  assert.deepEqual(asLines('Removed the Aegon job.'), ['Removed the Aegon job.']);
});

test('a proper list is left alone', () => {
  assert.deepEqual(asLines(['One.', 'Two.']), ['One.', 'Two.']);
});

test('nothing at all is an empty list', () => {
  assert.deepEqual(asLines(undefined), []);
  assert.deepEqual(asLines(null), []);
  assert.deepEqual(asLines([]), []);
  assert.deepEqual(asLines(''), []);
});

test('blank entries are dropped, not printed', () => {
  assert.deepEqual(asLines(['One.', '', '   ', 'Two.']), ['One.', 'Two.']);
});

test('a sentence written with line breaks becomes several lines', () => {
  assert.deepEqual(asLines('First.\nSecond.'), ['First.', 'Second.']);
});

test('a warning stored as an object gives up its text', () => {
  // `{ text, retry }` shipped for one afternoon and those rows still exist.
  assert.deepEqual(asLines([{ text: 'Aegon was put back.', retry: 'remove it' }]), ['Aegon was put back.']);
});

test('an object with nothing to say is dropped rather than printed', () => {
  assert.deepEqual(asLines([{ retry: 'x' }, 'Real line.']), ['Real line.']);
});

test('a number is printed rather than spread', () => {
  assert.deepEqual(asLines(2), ['2']);
});

// ── mendSplitLines ─────────────────────────────────────────────────────────
//
// For the four versions already saved one letter per row.

test('a spread sentence is put back together', () => {
  const spread = [...'Removed the Aegon job.'];
  assert.deepEqual(mendSplitLines(['You asked: "x"', ...spread]), ['You asked: "x"', 'Removed the Aegon job.']);
});

test('the spaces come back in the right places', () => {
  assert.deepEqual(mendSplitLines([...'one two three']), ['one two three']);
});

test('real log lines are never joined', () => {
  const real = ['You asked: "remove the Aegon job"', 'Aegon: removed, as you asked.'];
  assert.deepEqual(mendSplitLines(real), real);
});

test('a short run of initials is left alone', () => {
  // Three is not enough to be sure, and a wrong join corrupts a real line.
  assert.deepEqual(mendSplitLines(['A', 'B', 'C']), ['A', 'B', 'C']);
});

test('two spread sentences either side of a real one', () => {
  const lines = ['Kept.', ...'first one', 'Middle.', ...'second one'];
  assert.deepEqual(mendSplitLines(lines), ['Kept.', 'first one', 'Middle.', 'second one']);
});

test('an empty list stays empty', () => {
  assert.deepEqual(mendSplitLines([]), []);
});

// ── storedLines ────────────────────────────────────────────────────────────
//
// Reading back a log exactly as four saved versions hold it.

test('a real saved log comes back as sentences, spaces and all', () => {
  const stored = ['You asked: "remove the Aegon job"', ...'Removed the Aegon job as requested.'];
  assert.deepEqual(storedLines(stored), [
    'You asked: "remove the Aegon job"',
    'Removed the Aegon job as requested.',
  ]);
});

test('the words do not run together', () => {
  // Dropping blank rows before mending deletes the spaces themselves, which is
  // how this first came back as "RemovedtheAegonjob".
  assert.equal(storedLines([...'one two three'])[0], 'one two three');
});

test('an undamaged log is unchanged', () => {
  const fine = ['You asked: "x"', 'Aegon: removed, as you asked.'];
  assert.deepEqual(storedLines(fine), fine);
});

test('a log that was never a list at all', () => {
  assert.deepEqual(storedLines('One sentence.'), ['One sentence.']);
  assert.deepEqual(storedLines(null), []);
});

// ── withoutOrderTalk ───────────────────────────────────────────────────────
//
// Both of these are real, from the first live run after section moves shipped
// — one in the change list, one filed as a warning.

test('the model narrating the app’s layout is dropped', () => {
  const lines = [
    'Noted your request to move Skills below Education — section placement is handled by the app’s layout, so no content was changed.',
  ];
  assert.deepEqual(withoutOrderTalk(lines), []);
});

test('the same thing filed as a warning is dropped', () => {
  const warnings = [
    'Section order on the page is controlled by the app, not by the content structure, so no field changed here — the Skills section should appear below Education once rendered.',
  ];
  assert.deepEqual(withoutOrderTalk(warnings), []);
});

test('what the model actually did is kept', () => {
  const lines = [
    'Shortened the four MealApp bullets, keeping every number.',
    'Removed "Python" from the Languages skills group, as instructed.',
  ];
  assert.deepEqual(withoutOrderTalk(lines), lines);
});

test('a warning worth reading survives', () => {
  const warnings = ['Check the Droady dates before you send this — they overlap with Kudi Kitchen.'];
  assert.deepEqual(withoutOrderTalk(warnings), warnings);
});

// ── splitWarnings ──────────────────────────────────────────────────────────
//
// One field, two unrelated kinds of sentence, one box at the bottom of the
// column called "Worth checking". All four below are real.

test('a verdict on the posting is about the job', () => {
  const warnings = [
    "This candidate's background is entirely software engineering with no CAD, CATIA, or mechanical engineering evidence in the provided structure.",
    'Resume lists no direct experience with Adobe Creative Suite, Figma, or project management tools like Jira.',
  ];
  assert.deepEqual(splitWarnings(warnings).aboutTheJob, warnings);
  assert.deepEqual(splitWarnings(warnings).aboutTheApp, []);
});

test('the guard reporting itself is about the app', () => {
  const warnings = [
    'A rewritten bullet claims "python", which this bullet does not say, so your own wording was put back.',
    '8 of your skills were missing from the tailored version and have been put back.',
    'The tailoring dropped your Wealth Manager at Aegon and it has been put back as your profile has it.',
  ];
  assert.deepEqual(splitWarnings(warnings).aboutTheApp, warnings);
  assert.deepEqual(splitWarnings(warnings).aboutTheJob, []);
});

test('a mixed list is sorted, keeping each side in order', () => {
  const { aboutTheApp, aboutTheJob } = splitWarnings([
    'No AWS experience appears anywhere in the profile.',
    'Your certifications were missing and have been put back.',
    'This posting targets PhD candidates with hands-on ML training.',
  ]);
  assert.deepEqual(aboutTheJob, [
    'No AWS experience appears anywhere in the profile.',
    'This posting targets PhD candidates with hands-on ML training.',
  ]);
  assert.deepEqual(aboutTheApp, ['Your certifications were missing and have been put back.']);
});

test('an empty list splits into two empty lists', () => {
  assert.deepEqual(splitWarnings([]), { aboutTheApp: [], aboutTheJob: [] });
});

// ── the log against the page that was actually saved ───────────────────────

test('a line about an entry the fitter cut does not survive', () => {
  /*
   * The 6 Nov tailor, verbatim. The first two lines describe work on a job
   * the third line says was removed, and all three were saved together.
   */
  const lines = [
    'Reworded WesternBell website bullet to name HTML/CSS/JavaScript explicitly.',
    'Reframed the Aegon advisor-leadership bullet around interpersonal skills.',
  ];
  const kept = aboutWhatSurvived(lines, ['Kudi Kitchen', 'Aegon', 'Droady'], ['WesternBell International Ltd.']);
  assert.deepEqual(kept, ['Reframed the Aegon advisor-leadership bullet around interpersonal skills.']);
});

test('a line about a departed entry AND a surviving one is kept', () => {
  // Half a true sentence beats none: the Droady half still happened.
  const lines = ['Framed the Droady and WesternBell bullets around troubleshooting.'];
  assert.deepEqual(
    aboutWhatSurvived(lines, ['Droady'], ['WesternBell International Ltd.']),
    lines,
  );
});

test('the spelling the fitter recorded is not the spelling the model used', () => {
  // "WesternBell International Ltd." on the dropped list, "Western Bell" in
  // the sentence. Matching exactly would have let the line through.
  const lines = ['Added a bullet to Western Bell International about logistics.'];
  assert.deepEqual(aboutWhatSurvived(lines, ['Aegon'], ['WesternBell International Ltd.']), []);
});

test('nothing cut, nothing filtered', () => {
  const lines = ['Shortened the Aegon bullets.'];
  assert.deepEqual(aboutWhatSurvived(lines, ['Aegon'], []), lines);
});

test('an entry cut from one section but still present elsewhere stays', () => {
  // Kudi Kitchen is a job and a project. Dropping the project must not
  // silence every sentence about the job.
  const lines = ['Used "Founder & Web Developer" as the Kudi Kitchen job title.'];
  assert.deepEqual(aboutWhatSurvived(lines, ['Kudi Kitchen'], ['Kudi Kitchen']), lines);
});

test('a line naming no entry at all is never touched', () => {
  const lines = ['Tightened the wording throughout.'];
  assert.deepEqual(aboutWhatSurvived(lines, ['Aegon'], ['Droady']), lines);
});

test('the names a resume answers to', () => {
  assert.deepEqual(
    entryNames({
      experience: [{ org: 'Aegon' }, { org: 'Droady' }],
      projects: [{ name: 'Resumi' }],
      education: [{ school: 'Ontario Tech University' }],
    }),
    ['Aegon', 'Droady', 'Resumi', 'Ontario Tech University'],
  );
  assert.deepEqual(entryNames({}), []);
});

// ── a cited rule number ───────────────────────────────────────────────────

const RULES = [
  { text: 'Keep the resume one page' },
  { text: 'Always include the Aegon Wealth Manager experience entry, with at least 2 bullets.' },
  { text: 'Always include the Droady Software Engineer experience entry, with at least 2 bullets.' },
  { text: 'On software, data and other technical roles, use "Founder & Web Developer" as the Kudi Kitchen job title. On marketing, content or business roles, use "Founder & Digital Creator".' },
];

test('a rule number becomes the words of the rule', () => {
  /*
   * "Removing Kudi goes against rule 4" was in a real change log. Rule 4
   * sets that job's title on technical postings and requires nothing — but
   * the number made the claim unanswerable without counting rules by hand.
   */
  const [line] = withRulesQuoted(['Removing Kudi goes against rule 4.'], RULES);
  assert.match(line, /against your rule "On software, data and other technical roles/);
  assert.ok(!/rule 4/.test(line));
});

test('the rule\'s own quote marks do not nest', () => {
  const [line] = withRulesQuoted(['Used the short title per your rule 4.'], RULES);
  assert.equal((line.match(/"/g) ?? []).length, 2, 'one pair of quotes, around the rule');
});

test('two citations in one line both resolve', () => {
  const [line] = withRulesQuoted(['Kept Aegon (your rule 2) and Droady (your rule 3).'], RULES);
  assert.match(line, /Aegon \(your rule "Always include the Aegon/);
  assert.match(line, /Droady \(your rule "Always include the Droady/);
  assert.ok(!/\(\s/.test(line), 'no stray space after the bracket');
});

test('a universal rule takes its line with it', () => {
  // The app's own machinery, which means nothing to somebody reading their
  // resume — and substituting left "This." behind.
  assert.deepEqual(withRulesQuoted(['This breaks universal rule 1.'], RULES), []);
});

test('a rule that does not exist takes its line with it', () => {
  assert.deepEqual(withRulesQuoted(['Cited rule 9, which does not exist.'], RULES), []);
});

test('a line citing nothing is untouched', () => {
  const lines = ['Shortened the Aegon bullets.', 'Dropped 1 role to fit one page.'];
  assert.deepEqual(withRulesQuoted(lines, RULES), lines);
});

test('no rules at all drops every citation line rather than guessing', () => {
  assert.deepEqual(withRulesQuoted(['Kept Aegon per your rule 2.'], []), []);
  assert.deepEqual(withRulesQuoted(['Shortened the Aegon bullets.'], []), ['Shortened the Aegon bullets.']);
});
