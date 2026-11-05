import assert from 'node:assert';
import test from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import { INSTRUCT_TOOL, capacityResponse, tailorToolFor } from './shared';

/**
 * What the tools ask for is a prompt in its own right.
 *
 * Every rule pinned here was broken by a description rather than by the model:
 * a summary field on a resume that has no summary, a two-page ceiling nobody
 * chose, a language hardcoded for everyone, and a report that invited moving a
 * fact out of the entry it happened in.
 */

const json = (tool: unknown) => JSON.stringify(tool);

test('the summary field exists only when the profile has a summary', () => {
  // Four tailors out of four logged "Added a summary…" for a summary the guard
  // then dropped, because a master resume without one does not grow one. A
  // field that cannot reach the page should not be on offer.
  const without = tailorToolFor({ hasSummary: false });
  const structure = (without.input_schema as any).properties.structure;
  assert.equal('summary' in structure.properties, false);

  const with_ = tailorToolFor({ hasSummary: true });
  assert.equal('summary' in (with_.input_schema as any).properties.structure.properties, true);
});

test('nothing in the tailor tool decides length', () => {
  // "resume exceeding 2 pages" lived in the warnings description, so two pages
  // is what four tailors aimed for while the person wanted one. Length is
  // measured by the app, from the rendered PDF.
  assert.doesNotMatch(json(tailorToolFor({ hasSummary: true })), /2 pages|two pages|estimatedPages/i);
  assert.doesNotMatch(json(INSTRUCT_TOOL), /2 pages|two pages|estimatedPages/i);
});

test('no tool hardcodes one country\'s English', () => {
  // The log was requested "in Canadian English" for every account, whatever
  // locale the person picked. The spelling instruction belongs in the
  // per-person half of the prompt, which is the only place that knows.
  assert.doesNotMatch(json(tailorToolFor({ hasSummary: true })), /Canadian/i);
  assert.doesNotMatch(json(INSTRUCT_TOOL), /Canadian/i);
});

test('the tailor is not asked to report moving a fact between entries', () => {
  // Reporting it invited it: one tailor folded a project into a job of the same
  // name, the guard restored the project, and the same facts appeared twice.
  const tool = tailorToolFor({ hasSummary: true });
  const properties = (tool.input_schema as any).properties;
  assert.equal('structuralChanges' in properties, false);
  assert.equal((tool.input_schema as any).required.includes('structuralChanges'), false);
});

test('missing requirements are described as the place an unmet requirement goes', () => {
  // The old description named an "About Me PDF or Base Resume", neither of
  // which is sent. An invented match hides the gap instead of reporting it.
  const description = (tailorToolFor({ hasSummary: true }).input_schema as any).properties
    .missingRequirements.description;
  assert.doesNotMatch(description, /About Me PDF|Base Resume/);
  assert.match(description, /never write one into a bullet/i);
});

test('an edit returns the same narrow resume the tailor does', () => {
  // It used to ask for the whole resume — name, contact, degrees, links — all
  // of which the guard overwrites from the source, so every edit paid to write
  // fields that were discarded before anybody saw them.
  const structure = (INSTRUCT_TOOL.input_schema as any).properties.structure;
  assert.equal('name' in structure.properties, false);
  assert.equal('contact' in structure.properties, false);
  assert.equal((INSTRUCT_TOOL.input_schema as any).required.includes('estimatedPages'), false);
});

// ── out of credit ──────────────────────────────────────────────────────────

test('running out of credit reads as capacity, not as a bad request', async () => {
  /*
   * It arrives as a plain 400 with no code of its own, so every catch in the
   * app read it as a malformed request: one real run reported "something went
   * wrong" when the bill had simply not been paid.
   *
   * It is the app's account and never the person's, so the sentence says the
   * thing that is true and useful to them and points at no billing page they
   * do not own. The route refunds their credit before this is read, which is
   * why it can say nothing was charged.
   */
  const message =
    'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.';
  const error = new Anthropic.APIError(
    400,
    { type: 'error', error: { type: 'invalid_request_error', message } },
    message,
    undefined,
  );

  const response = capacityResponse(error);
  assert.ok(response, 'it is recognised');
  assert.equal(response.status, 429);
  const body = await response.json();
  assert.match(body.error.message, /on us, not you/);
  assert.match(body.error.message, /nothing was charged/);
  assert.equal(body.error.creditKept, true);
  assert.equal(/Plans & Billing|balance/i.test(body.error.message), false, 'and says nothing about a bill they do not pay');
});

test('a genuinely bad request still reports as one', () => {
  const message = 'tool_choice: type "tool" is not supported for this model.';
  const error = new Anthropic.APIError(400, { type: 'error', error: { type: 'invalid_request_error', message } }, message, undefined);
  assert.equal(capacityResponse(error), null, 'or a real bug hides behind a reassuring sentence');
});
