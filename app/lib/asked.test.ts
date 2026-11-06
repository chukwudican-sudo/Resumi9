import assert from 'node:assert/strict';
import test from 'node:test';
import { NOTHING_ASKED, readInstruction } from './asked';
import type { ResumeStructure } from './types';

/**
 * The refusals are the half that matters.
 *
 * A grant that fails to fire costs one free edit and a retry. A grant that fires
 * when it should not takes a job off a resume somebody is about to send, and the
 * app tells them it worked. Two of the cases below are instructions the app
 * itself suggests on buttons under the box.
 */
const RESUME: ResumeStructure = {
  name: 'Chukwudi Alex',
  contact: { email: 'a@example.com' },
  education: [
    { school: 'Ontario Tech University', location: 'Oshawa, ON', degree: 'BEng', dates: 'Sep 2023 – 2028', bullets: [] },
  ],
  experience: [
    { title: 'Software Engineer', org: 'Droady', location: 'San Francisco, CA', dates: 'Nov 2025 – May 2026', bullets: ['shipped a thing'] },
    { title: 'Wealth Manager', org: 'Aegon', location: 'Oshawa, ON', dates: 'May 2025 – Aug 2026', bullets: ['advised clients'] },
    { title: 'Operations', org: 'WesternBell International Ltd.', location: 'Port Harcourt, Nigeria', dates: 'Jun 2024 – Jan 2025', bullets: ['built the site'] },
  ],
  projects: [
    { name: 'MealApp', tech: 'React Native', dates: 'May 2026', bullets: ['a mobile app'] },
    { name: 'Python Rate Limiter', tech: 'Python', dates: 'Jul 2026', bullets: ['three algorithms'] },
  ],
  skills: [{ category: 'Languages', items: 'Java, TypeScript, Python' }],
};

const asked = (words: string) => readInstruction(words, RESUME);

// ── what it grants ─────────────────────────────────────────────────────────

test('naming a job with a removal word removes that job and no other', () => {
  const it = asked('remove the Aegon job');
  assert.equal(it.removes('experience', 'Aegon'), true);
  assert.equal(it.removes('experience', 'Droady'), false);
  assert.equal(it.removes('experience', 'WesternBell International Ltd.'), false);
});

test('an employer is found by the word people actually type', () => {
  // Nobody types "WesternBell International Ltd." into a one-line instruction.
  assert.equal(asked('delete the WesternBell role').removes('experience', 'WesternBell International Ltd.'), true);
});

test('the other removal words work too', () => {
  assert.equal(asked('get rid of the MealApp project').removes('projects', 'MealApp'), true);
  assert.equal(asked('drop the MealApp project').removes('projects', 'MealApp'), true);
  assert.equal(asked('take the MealApp project out').removes('projects', 'MealApp'), true);
});

test('a skill goes without the project of the same name going with it', () => {
  const it = asked('take Python out of my skills');
  assert.equal(it.removesSkill('Python'), true);
  assert.equal(it.removes('projects', 'Python Rate Limiter'), false);
});

test('and the project goes without the skill going with it', () => {
  const it = asked('drop the Python project');
  assert.equal(it.removes('projects', 'Python Rate Limiter'), true);
  assert.equal(it.removesSkill('Python'), false);
});

test('shouting, and punctuation people actually type', () => {
  assert.equal(asked('REMOVE THE AEGON JOB').removes('experience', 'Aegon'), true);
  assert.equal(asked('remove the Aegon job — it’s over').removes('experience', 'Aegon'), true);
});

test('the nearest name after the verb wins, not every name in the sentence', () => {
  const it = asked('get rid of the WesternBell job but keep Aegon');
  assert.equal(it.removes('experience', 'WesternBell International Ltd.'), true);
  assert.equal(it.removes('experience', 'Aegon'), false);
});

test('asking for a summary, and asking for it to go', () => {
  assert.equal(asked('add a summary at the top').wantsSummary, true);
  assert.equal(asked('remove the summary').dropsSummary, true);
  // "summary" is a part-word, so asking about one never licenses an entry.
  assert.equal(asked('remove the summary').removes('experience', 'Aegon'), false);
});

test('a date changes only when they said what it should be, and it came back that way', () => {
  const it = asked('change my Droady end date to Aug 2026');
  assert.equal(it.allowsDates('Droady', 'Nov 2025 – Aug 2026'), true);
  assert.equal(it.allowsDates('Droady', 'Nov 2025 – Dec 2027'), false, 'not what they asked for');
  assert.equal(it.allowsDates('Aegon', 'May 2025 – Aug 2026'), false, 'a different entry');
});

// ── what it refuses ────────────────────────────────────────────────────────

test('the app\'s own suggestion chips never delete anything', () => {
  // These two are printed on buttons under the box. A rule that deletes a job
  // for either of them ships a button that destroys an employment history.
  const shorten = asked('shorten the Aegon bullets');
  assert.equal(shorten.removes('experience', 'Aegon'), false);
  assert.equal(shorten.nearlyRemoves('Aegon'), false, 'not even worded as a removal');

  const second = asked('drop the second bullet');
  assert.equal(second.removes('experience', 'Droady'), false);
  assert.equal(second.removes('projects', 'MealApp'), false);
});

test('a removal aimed at a part of an entry never takes the entry', () => {
  assert.equal(asked('remove the second bullet from Droady').removes('experience', 'Droady'), false);
  assert.equal(asked('take out the part about Stripe at Droady').removes('experience', 'Droady'), false);
  assert.equal(asked('delete the date on the Aegon job').removes('experience', 'Aegon'), false);
});

test('a job that ended is not a job to delete', () => {
  const it = asked('no longer at WesternBell');
  assert.equal(it.removes('experience', 'WesternBell International Ltd.'), false);
  assert.equal(it.allowsDates('WesternBell International Ltd.', 'Jun 2024 – Present'), false, 'no date given');
});

test('being told not to, and being asked about it, are not permission', () => {
  assert.equal(asked("don't remove the Aegon job").removes('experience', 'Aegon'), false);
  assert.equal(asked('why did you remove the Aegon job?').removes('experience', 'Aegon'), false);
  assert.equal(asked('did you delete MealApp?').removes('projects', 'MealApp'), false);
});

test('two entries answering to the same words resolve to neither', () => {
  const twins: ResumeStructure = {
    ...RESUME,
    projects: [
      { name: 'MealApp', tech: 'React Native', dates: 'May 2026', bullets: ['x'] },
      { name: 'MealApp Pro', tech: 'Swift', dates: 'Jun 2026', bullets: ['y'] },
    ],
  };
  const it = readInstruction('remove the MealApp project', twins);
  assert.equal(it.removes('projects', 'MealApp'), false);
  assert.equal(it.removes('projects', 'MealApp Pro'), false);
  assert.equal(it.nearlyRemoves('MealApp'), true, 'and it says so, rather than going quiet');
});

test('a degree is not an edit-box removal', () => {
  assert.equal(asked('remove my Ontario Tech degree').removes('education', 'Ontario Tech University'), false);
});

test('a word that means both delete and shorten asks instead of acting', () => {
  const it = asked('cut the Aegon job');
  assert.equal(it.removes('experience', 'Aegon'), false);
  assert.equal(it.nearlyRemoves('Aegon'), true);
});

test('one grant never leaks into another', () => {
  const it = asked('remove the Aegon job');
  assert.equal(it.wantsSummary, false);
  assert.equal(it.dropsSummary, false);
  assert.equal(it.removesSkill('Python'), false, 'no skill was named');
  assert.equal(it.allowsDates('Aegon', 'May 2025 – Aug 2026'), false, 'no date was named');
});

test('an empty instruction is the same as no instruction', () => {
  const it = readInstruction('   ', RESUME);
  assert.equal(it.words, '');
  assert.equal(it.removes('experience', 'Aegon'), false);
  assert.equal(it.nearlyRemoves('Aegon'), false);
  assert.equal(it.removesSkill('Python'), false);
  assert.equal(it.wantsSummary, false);
  assert.equal(it.dropsSummary, false);
});

test('nothing asked grants nothing', () => {
  assert.equal(NOTHING_ASKED.words, '');
  assert.equal(NOTHING_ASKED.removes('experience', 'Aegon'), false);
  assert.equal(NOTHING_ASKED.nearlyRemoves('Aegon'), false);
  assert.equal(NOTHING_ASKED.removesSkill('Python'), false);
  assert.equal(NOTHING_ASKED.allowsDates('Aegon', 'May 2025 – Aug 2026'), false);
  assert.equal(NOTHING_ASKED.wantsSummary, false);
  assert.equal(NOTHING_ASKED.dropsSummary, false);
});

test('the instruction is kept verbatim, for the honesty check to read', () => {
  assert.equal(asked('  add that I used C# at Droady  ').words, 'add that I used C# at Droady');
});

// ── asking instead of guessing ─────────────────────────────────────────────
//
// "Drop the second bullet" silently took Droady's, because Droady happened to
// be first. The app could see it did not know; it picked anyway.

test('a removal aimed at a part, with nothing named, asks which one', () => {
  const question = asked('drop the second bullet').ask;
  assert.ok(question, 'it should ask rather than pick');
  assert.match(question!, /Which entry/);
  // No list of names. It said "you have" and then named some of them, which
  // read as a complete list and was not one.
  assert.doesNotMatch(question!, /Droady|Aegon/);
});

test('the same instruction with an entry named asks nothing', () => {
  assert.equal(asked('remove the second bullet from Droady').ask, null);
});

test('a word meaning both delete and shorten asks which was meant', () => {
  const question = asked('cut the Aegon job').ask;
  assert.ok(question);
  assert.match(question!, /Aegon/);
  assert.match(question!, /removed completely, or just shortened/);
});

test('the same word aimed at bullets is not ambiguous', () => {
  // "Cut the Aegon bullets" is a length request and always was.
  assert.equal(asked('cut the Aegon bullets').ask, null);
});

test('two entries answering the same words asks which', () => {
  const twins: ResumeStructure = {
    ...RESUME,
    projects: [
      { name: 'MealApp', tech: 'React Native', dates: 'May 2026', bullets: ['x'] },
      { name: 'MealApp Pro', tech: 'Swift', dates: 'Jun 2026', bullets: ['y'] },
    ],
  };
  const question = readInstruction('remove the MealApp project', twins).ask;
  assert.ok(question);
  assert.match(question!, /MealApp or MealApp Pro/);
});

test('an instruction it can act on asks nothing', () => {
  assert.equal(asked('remove the Aegon job').ask, null);
  assert.equal(asked('shorten the Aegon bullets').ask, null);
  assert.equal(asked('add that I used C# at Droady').ask, null);
  assert.equal(asked('take Python out of my skills').ask, null);
});

test('a job that ended is not offered a delete-or-shorten choice', () => {
  // "No longer at WesternBell" means the dates changed. Asking whether to
  // delete it would be offering the wrong two answers.
  assert.equal(asked('no longer at WesternBell').ask, null);
});

test('a question or a refusal asks nothing back', () => {
  assert.equal(asked('why did you cut the Aegon job?').ask, null);
  assert.equal(asked("don't cut the Aegon job").ask, null);
});

// ── the Intel application, three sentences deep ────────────────────────────
//
// Every sentence below is verbatim from one revision that went wrong three
// times running. The resume had a Kudi Kitchen job and a Rate Limit Lab
// project, and the app put Kudi Kitchen back after each instruction to remove
// it — telling the person, each time, that their own instruction had been
// undone.

const INTEL: ResumeStructure = {
  ...RESUME,
  experience: [
    { title: 'Founder & Web Developer', org: 'Kudi Kitchen', location: 'Oshawa, ON', dates: 'Mar 2025 – Present', bullets: ['sold things'] },
    ...RESUME.experience,
  ],
  projects: [
    { name: 'Rate Limit Lab', tech: 'Python, pytest', dates: 'Jul 2026 – Aug 2026', bullets: ['benchmarked two algorithms'] },
    ...RESUME.projects,
  ],
};
const onIntel = (words: string) => readInstruction(words, INTEL);

test('replace A with B licenses removing A', () => {
  /*
   * Two faults at once: "replace" was not a removal verb, and "project" —
   * said about the thing coming IN — narrowed the removal to projects and let
   * the job through untouched.
   */
  const it = onIntel('Replace the Kudi Kitchen experience entry with the Rate Limit Lab project.');
  assert.equal(it.removes('experience', 'Kudi Kitchen'), true);
  assert.equal(it.removes('projects', 'Rate Limit Lab'), false, 'the incoming half is not a removal');
});

test('the other three ways to word a swap', () => {
  for (const said of [
    'swap the Kudi Kitchen job for the Rate Limit Lab project',
    'use the Rate Limit Lab project instead of the Kudi Kitchen job',
    'put the Rate Limit Lab project in place of the Kudi Kitchen job',
  ]) {
    assert.equal(onIntel(said).removes('experience', 'Kudi Kitchen'), true, said);
    assert.equal(onIntel(said).removes('projects', 'Rate Limit Lab'), false, said);
  }
});

test('"instead of removing X" is a refusal, not a licence', () => {
  // The dangerous direction, and why the swap verbs are read against what
  // follows: granting this deletes a job somebody just asked to keep.
  for (const said of ['instead of removing Aegon, shorten it', 'in place of dropping Aegon, trim the bullets']) {
    assert.equal(onIntel(said).removes('experience', 'Aegon'), false, said);
  }
});

test('an answer supplying bullets does not void the removal beside it', () => {
  // They answered a question with two bullets AND "Remove Kudi Kitchen" in
  // one box, and the word "bullets" made the whole sentence read as being
  // about a part of an entry.
  const it = onIntel(
    'Benchmarked a sliding window against a token bucket; found and fixed a subtle timing bug. Remove Kudi Kitchen',
  );
  assert.equal(it.removes('experience', 'Kudi Kitchen'), true);
});

test('two removal verbs are two removals', () => {
  const it = onIntel('Delete the second, duplicate Rate Limit Lab entry and remove Kudi Kitchen');
  assert.equal(it.removes('projects', 'Rate Limit Lab'), true);
  assert.equal(it.removes('experience', 'Kudi Kitchen'), true);
});

test('one verb and a list is still every item on it', () => {
  const it = onIntel('remove Aegon and WesternBell');
  assert.equal(it.removes('experience', 'Aegon'), true);
  assert.equal(it.removes('experience', 'WesternBell International Ltd.'), true);
});

test('a verb between two names ends the list', () => {
  // The whole safety of reading a list: "and shorten Droady" is a second
  // clause, not a second removal.
  for (const said of [
    'remove Aegon and shorten Droady',
    'remove Aegon and keep Droady',
    'remove Aegon, and do not touch Droady',
  ]) {
    const it = onIntel(said);
    assert.equal(it.removes('experience', 'Aegon'), true, said);
    assert.equal(it.removes('experience', 'Droady'), false, said);
  }
});

test('a name that is both a job and a project asks which, by kind', () => {
  // It asked "Which one — Rate Limit Lab or Rate Limit Lab?" on a page that
  // printed the project twice. The answer it wanted was the kind, and it
  // never said so.
  const both: ResumeStructure = {
    ...INTEL,
    projects: [...INTEL.projects, { name: 'Kudi Kitchen', tech: 'Cloudflare', dates: '2026', bullets: ['a rebuild'] }],
  };
  assert.match(readInstruction('remove Kudi Kitchen', both).ask ?? '', /the Kudi Kitchen job or the Kudi Kitchen project/);
});

// ── two requests in one sentence ───────────────────────────────────────────
//
// The Scotiabank application, 6 Nov. One sentence saying what to remove and
// what to keep, about a name this profile holds in BOTH sections — which is
// the whole difficulty, so the fixture has to hold it twice too.

/** Kudi Kitchen is a job and a project here, as it is in the real profile. */
const BOTH: ResumeStructure = {
  ...RESUME,
  experience: [
    { title: 'Founder & Web Developer', org: 'Kudi Kitchen', location: 'Oshawa, ON', dates: 'Mar 2025 – Present', bullets: ['sold things'] },
    ...RESUME.experience,
  ],
  projects: [
    { name: 'Kudi Kitchen', tech: 'HTML, CSS, Stripe', dates: '2026', bullets: ['hand-coded the storefront'] },
    ...RESUME.projects,
  ],
};
const onBoth = (words: string) => readInstruction(words, BOTH);

test('the section word is read from the clause that asks for the removal', () => {
  /*
   * "Remove the Kudi Kitchen entry from Technical Projects only. Keep the
   * Kudi Kitchen job in Experience."
   *
   * Read whole, the sentence says "Projects" and it says "job", so both kinds
   * were in play, the tie stood, and the app asked "which one — the job or
   * the project?" about a sentence whose first four words had answered it.
   */
  const it = onBoth('Remove the Kudi Kitchen entry from Technical Projects only. Keep the Kudi Kitchen job in Experience.');
  assert.equal(it.ask, null, 'the sentence already said which');
  assert.equal(it.removes('projects', 'Kudi Kitchen'), true);
  assert.equal(it.removes('experience', 'Kudi Kitchen'), false, 'the job was the half to keep');
});

test('an answer carrying the name does not move it behind the verb', () => {
  /*
   * The route reads the answer before the instruction, so a verb in the
   * answer finds its name in the instruction. That ordering put the ANSWER's
   * copy of the name ahead of the instruction's verb, and only the first
   * occurrence was ever recorded — so nothing was licensed and the guard put
   * the project back under the person's own answer.
   */
  const it = onBoth('The Kudi Kitchen project Remove the Kudi Kitchen entry from Technical Projects only.');
  assert.equal(it.removes('projects', 'Kudi Kitchen'), true);
  assert.equal(it.removes('experience', 'Kudi Kitchen'), false);
});

test('a sentence with only one clause reads exactly as it did', () => {
  // The fallback that makes clause-reading safe to adopt.
  assert.equal(onBoth('remove the Kudi Kitchen project').removes('projects', 'Kudi Kitchen'), true);
  assert.equal(onBoth('remove the Kudi Kitchen job').removes('experience', 'Kudi Kitchen'), true);
  assert.equal(onBoth('remove Droady').removes('experience', 'Droady'), true);
});

test('a name with no section word still asks', () => {
  // Nothing here narrows it, so the question is the right answer.
  const it = onBoth('remove Kudi Kitchen');
  assert.ok(it.ask, 'two entries answer to that name and nothing says which');
  assert.equal(it.removes('projects', 'Kudi Kitchen'), false);
  assert.equal(it.removes('experience', 'Kudi Kitchen'), false);
});
