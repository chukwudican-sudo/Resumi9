import assert from 'node:assert';
import test from 'node:test';
import { TAILOR_INVARIANT, buildUserContext } from './systemPrompt';

test('the cached prefix names nobody', () => {
  // Every user shares this block. A name in it means each person becomes their
  // own cache entry for the largest part of the request — and it means someone
  // else's name is in the prompt describing this person's resume.
  assert.doesNotMatch(TAILOR_INVARIANT, /Alex|Ndubuisi/i);
  // Nor a nationality, since spelling is a per-user decision.
  assert.doesNotMatch(TAILOR_INVARIANT, /Canadian|Canada/i);
  // Nor a pronoun for the person, whose pronouns the app does not know.
  assert.doesNotMatch(TAILOR_INVARIANT, /\b(his|her|he|she)\b/i);
});

test('an American applicant is told to use American spelling', () => {
  const context = buildUserContext({ displayName: 'Dana Whitfield', locale: 'en-US' });
  assert.match(context, /American English/);
  assert.match(context, /color, program, license, organize/);
  assert.doesNotMatch(context, /organise/);
});

test('a Canadian applicant gets Canadian spelling, which is not British spelling', () => {
  // The examples used to be "programme" and "organise", which are British. So
  // rewritten bullets came back "categorised" and "optimising" while the
  // untouched ones kept the profile's American spelling, in one document.
  const context = buildUserContext({ displayName: 'Alex Ndubuisi', locale: 'en-CA' });
  assert.match(context, /Canadian English/);
  assert.match(context, /colour, behaviour, centre/);
  assert.match(context, /organize, optimize, analyze/);
  assert.doesNotMatch(context, /programme|organise/);
});

test('the spelling instruction covers the change log too', () => {
  assert.match(buildUserContext({ locale: 'en-US' }), /change log/i);
});

test('the invariant does not push the model to invent', () => {
  // Every one of these produced invented claims in the five reviewed resumes:
  // posting phrases pasted onto real work, practices nobody did, inflated
  // ownership. The pressure came from the prompt, not the model.
  for (const pressure of [
    /aggressively/i,
    /MINIMUM BAR/,
    /fully rewrite the bullet/i,
    /almost identically/i,
    /mirror the language/i,
    /estimatedPages/,
    /Maximum 2 pages/i,
  ]) {
    assert.doesNotMatch(TAILOR_INVARIANT, pressure, `still says ${pressure}`);
  }

  // And it says, in so many words, what inventing looks like inside a bullet.
  assert.match(TAILOR_INVARIANT, /stakeholders/i);
  assert.match(TAILOR_INVARIANT, /"Contributed to X" may not become/);
  assert.match(TAILOR_INVARIANT, /An unchanged bullet is a correct answer/);
});

test('it still asks for real tailoring, not just reordering', () => {
  // Measured: with the invention pressure removed and nothing put in its place,
  // a real run came back with 26 of 27 bullets untouched and a change log that
  // said "only reordering and word choices". Silence is the other failure.
  assert.match(TAILOR_INVARIANT, /almost entirely untouched has not been tailored/);
  // Both caught in a real run once the pressure came back: a team became
  // "working closely with the other developers", and a tool from elsewhere on
  // the resume was bolted onto a bullet it had nothing to do with.
  assert.match(TAILOR_INVARIANT, /a team is who was there, not what you did with them/);
  assert.match(TAILOR_INVARIANT, /Each bullet is evidence for what that bullet says/);
  assert.match(TAILOR_INVARIANT, /reordering alone is not tailoring/);
  assert.match(TAILOR_INVARIANT, /it is the wrong default/);
});

test('length is the app\'s decision, not the model\'s', () => {
  assert.match(TAILOR_INVARIANT, /Do not decide length/);
  assert.match(TAILOR_INVARIANT, /least relevant/);
});

test('an unknown or missing locale falls back rather than dropping the instruction', () => {
  // Silence here would mean whatever the model felt like, which is worse than a
  // default someone can correct.
  for (const locale of [undefined, null, 'xx-YY', '']) {
    const context = buildUserContext({ displayName: 'Sam', locale });
    assert.match(context, /English spelling/, `no spelling instruction for locale ${String(locale)}`);
  }
});

test('the resume belongs to whoever is named', () => {
  assert.match(buildUserContext({ displayName: 'Dana Whitfield' }), /Dana Whitfield/);
  // No name is a normal state, not a reason to guess one.
  const anonymous = buildUserContext({ displayName: null });
  assert.doesNotMatch(anonymous, /null|undefined/);
  assert.match(anonymous, /this person/i);
});

test("personal rules are numbered and ranked below the universal ones", () => {
  const context = buildUserContext({
    displayName: 'Sam',
    locale: 'en-CA',
    rules: [{ text: 'Never use the word "spearheaded".' }, { text: 'Call it Ontario Tech, never UOIT.' }],
  });
  assert.match(context, /1\. Never use the word "spearheaded"\./);
  assert.match(context, /2\. Call it Ontario Tech, never UOIT\./);
  // The ranking has to be stated, or a personal rule can be read as licence to
  // break rule 1 and invent something.
  assert.match(context, /below the Universal Rules/i);
});

test('blank rules do not become empty numbered lines', () => {
  const context = buildUserContext({ rules: [{ text: '   ' }, { text: 'Keep bullets to one line.' }] });
  assert.match(context, /1\. Keep bullets to one line\./);
  assert.doesNotMatch(context, /2\./);
});

test('no rules means no rules section at all', () => {
  // An empty heading reads as a feature that failed to load.
  const context = buildUserContext({ displayName: 'Sam', rules: [] });
  assert.doesNotMatch(context, /OWN RULES/);
});

test('what someone is applying for reaches the prompt', () => {
  // Stored since onboarding and read by nothing: the account page claimed it
  // shaped every resume while the only consumer was the disabled interview.
  const intern = buildUserContext({ displayName: 'Sam', stage: 'internship', targetField: 'data engineering' });
  assert.match(intern, /internships and co-ops/i);
  assert.match(intern, /data engineering/);
  // The point of saying it: a student must not be written up as a senior hire.
  assert.match(intern, /years of ownership they do not have/i);

  assert.match(buildUserContext({ stage: 'experienced' }), /scope, ownership and outcomes/i);
  assert.match(buildUserContext({ stage: 'new_grad' }), /built and shipped/i);
});

test('an unset or unknown stage adds nothing rather than guessing', () => {
  for (const stage of [null, undefined, '', '   ', 'director']) {
    const context = buildUserContext({ displayName: 'Sam', stage });
    assert.equal(/applying for internships|experienced hire|early career/i.test(context), false, `stage: ${stage}`);
  }
  assert.equal(/roles they are going for/i.test(buildUserContext({ targetField: '  ' })), false);
});
