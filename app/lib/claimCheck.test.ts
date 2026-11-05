import assert from 'node:assert/strict';
import test from 'node:test';
import { claimCheckInput, flagsFromVerdicts } from './claimCheck';
import type { ResolvedBullet } from './provenance';

const bullet = (over: Partial<ResolvedBullet> = {}): ResolvedBullet => ({
  entry: 'p0',
  text: '',
  changed: true,
  from: [],
  evidence: [],
  context: '',
  moved: false,
  unsourced: false,
  ...over,
});

/** The real pair from the Nov 4 run that nothing lexical could reach. */
const SOURCE = 'Set up an automated CI pipeline (GitHub Actions) running the test suite on every push';
const WRITTEN = `${SOURCE}, including integration checks before merge`;
const CHECKED = [bullet({ text: WRITTEN, evidence: [SOURCE] })];

// ── what gets sent ─────────────────────────────────────────────────────────

test('only changed, sourced bullets are worth asking about', () => {
  const sent = claimCheckInput([
    bullet({ text: 'Rewritten', evidence: ['Their own sentence'] }),
    bullet({ text: 'Untouched', evidence: ['Untouched'], changed: false }),
    bullet({ text: 'From nowhere', evidence: [], unsourced: true }),
    bullet({ text: '   ', evidence: ['Something'] }),
  ]);
  assert.deepEqual(sent, [{ bullet: 'Rewritten', sources: ['Their own sentence'] }]);
});

test('every source of a bullet goes with it', () => {
  const sent = claimCheckInput([bullet({ text: 'Merged', evidence: ['One.', 'Two.'] })]);
  assert.deepEqual(sent[0].sources, ['One.', 'Two.']);
});

// ── a verdict that holds up ────────────────────────────────────────────────

test('a claim the source does not make is flagged, with their words to go back to', () => {
  const { flags, discarded } = flagsFromVerdicts(
    [{ bullet: WRITTEN, quote: SOURCE, unsupported: ', including integration checks before merge' }],
    CHECKED,
  );
  assert.equal(discarded, 0);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].revertTo, SOURCE);
  assert.equal(flags[0].reason, 'says "including integration checks before merge", which your profile does not');
});

test('an empty verdict is a bullet that passed', () => {
  const { flags } = flagsFromVerdicts([{ bullet: WRITTEN, quote: SOURCE, unsupported: '' }], CHECKED);
  assert.deepEqual(flags, []);
});

test('the source label travels, so an edit does not say "your profile"', () => {
  const { flags } = flagsFromVerdicts(
    [{ bullet: WRITTEN, quote: SOURCE, unsupported: 'integration checks before merge' }],
    CHECKED,
    'the previous version',
  );
  assert.match(flags[0].reason, /which the previous version does not$/);
});

test('punctuation drift in the quoted span is tolerated', () => {
  // The model retypes the span with a different dash or spacing. The claim is
  // the same and the bullet is the same; refusing on a hyphen would throw away
  // a good verdict.
  const { flags, discarded } = flagsFromVerdicts(
    [{ bullet: WRITTEN, quote: SOURCE, unsupported: 'integration  checks   before merge.' }],
    CHECKED,
  );
  assert.equal(discarded, 0);
  assert.equal(flags.length, 1);
});

// ── a verdict that does not ────────────────────────────────────────────────

test('a span that is not in the bullet is discarded, not acted on', () => {
  // The whole reason the span is asked for rather than a yes/no: a model
  // cannot invent its way into deleting a sentence.
  const { flags, discarded } = flagsFromVerdicts(
    [{ bullet: WRITTEN, quote: SOURCE, unsupported: 'claims to have led the team' }],
    CHECKED,
  );
  assert.deepEqual(flags, []);
  assert.equal(discarded, 1);
});

test('a quote that is not in the sources is discarded', () => {
  // A check that can invent its evidence is worse than no check.
  const { flags, discarded } = flagsFromVerdicts(
    [{ bullet: WRITTEN, quote: 'Ran integration tests before every merge', unsupported: 'before merge' }],
    CHECKED,
  );
  assert.deepEqual(flags, []);
  assert.equal(discarded, 1);
});

test('a verdict about a bullet nobody sent is discarded', () => {
  const { flags, discarded } = flagsFromVerdicts(
    [{ bullet: 'A sentence from another resume', quote: SOURCE, unsupported: 'anything' }],
    CHECKED,
  );
  assert.deepEqual(flags, []);
  assert.equal(discarded, 1);
});

test('two verdicts about one bullet count once', () => {
  const { flags, discarded } = flagsFromVerdicts(
    [
      { bullet: WRITTEN, quote: SOURCE, unsupported: 'before merge' },
      { bullet: WRITTEN, quote: SOURCE, unsupported: 'integration checks' },
    ],
    CHECKED,
  );
  assert.equal(flags.length, 1);
  assert.equal(discarded, 1);
});

test('a malformed verdict is discarded rather than thrown on', () => {
  const { flags, discarded } = flagsFromVerdicts(
    [
      {},
      { bullet: 42, unsupported: 7 },
      { bullet: WRITTEN, quote: SOURCE, unsupported: null },
      // This one does claim something, about a bullet it cannot name.
      { bullet: 42, quote: SOURCE, unsupported: 'before merge' },
    ] as never,
    CHECKED,
  );
  assert.deepEqual(flags, []);
  // A verdict with nothing to say is a bullet that passed, not a failure — so
  // only the last one counts as thrown away.
  assert.equal(discarded, 1);
});

test('nothing back at all changes nothing', () => {
  assert.deepEqual(flagsFromVerdicts([], CHECKED), { flags: [], discarded: 0 });
});

test('a bullet whose only source is blank is left alone', () => {
  // There would be nothing to revert to, and this check never deletes: a
  // bullet with no usable source is the unsourced path's business.
  const { flags, discarded } = flagsFromVerdicts(
    [{ bullet: 'Something', quote: '   ', unsupported: 'Something' }],
    [bullet({ text: 'Something', evidence: ['   '] })],
  );
  assert.deepEqual(flags, []);
  assert.equal(discarded, 1);
});
