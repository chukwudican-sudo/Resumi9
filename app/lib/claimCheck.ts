import type { ResolvedBullet } from './provenance';
import type { Flag } from './honesty';

/**
 * A second reading of each rewritten bullet, against the source it names.
 *
 * The lexical check in honesty.ts catches the posting's words appearing where
 * the source has nothing, and measured over 139 real bullets it reads six of
 * the eleven inventions from one apply run. The five it misses are all the
 * same shape — a claim built out of words the source already contains:
 *
 *     source:  "payment integration using Stripe and RevenueCat"
 *     bullet:  "...including integration checks before merge"
 *
 *     source:  "integrating an AI/LLM model into a production mobile app"
 *     bullet:  "...cleaned 8,187 records to prepare data for the models"
 *
 * Every word is in the source. Neither claim is. Nothing arithmetic reaches
 * that, so this one asks.
 *
 * **What makes it safe is not trust, it is that both halves are checkable.**
 * The model returns the source sentence it relied on and the span of the
 * bullet that sentence does not support, and the app verifies each against
 * text it already holds: the quote must appear in the evidence, the span must
 * appear in the bullet. A verdict that fails either check is discarded and
 * logged rather than acted on — a model cannot invent its way into deleting
 * somebody's sentence, which is the failure mode a yes/no answer would have.
 *
 * Verifying the quote alone would not have been enough, and that is worth
 * saying because it was the first design: a citation check catches a model
 * that fabricated its evidence, and these models do not. They quote the right
 * source and append the claim anyway.
 */

/** What the checker is asked for, per bullet. */
export interface ClaimVerdict {
  /** The bullet, as it was given. */
  bullet?: unknown;
  /** The sentence from the source it is based on. */
  quote?: unknown;
  /** The part of the bullet that quote does not support, or "" for none. */
  unsupported?: unknown;
}

export const CLAIM_CHECK_TOOL = {
  name: 'report_claims',
  description:
    'Report, for each bullet you were given, the source sentence it rests on and any part of it that source does not support.',
  input_schema: {
    type: 'object' as const,
    properties: {
      verdicts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            bullet: { type: 'string', description: 'The bullet text, copied back exactly as given.' },
            quote: {
              type: 'string',
              description:
                'The sentence from THIS bullet\'s sources that it is based on, copied word for word from the source. Never your own words, never the bullet itself.',
            },
            unsupported: {
              type: 'string',
              description:
                'The exact substring of the bullet that the quote does not support — copied character for character from the bullet, not described. Empty string if every claim in the bullet is supported. A purpose the source does not state ("to flag anomalies"), an outcome it does not record ("improving pipeline reliability"), a condition it does not mention ("under tight latency constraints"), a scope it does not give ("before merge", "for consumers"), or a characterisation it does not make are all unsupported even when every individual word appears somewhere in the source.',
            },
          },
          required: ['bullet', 'quote', 'unsupported'],
          additionalProperties: false,
        },
      },
    },
    required: ['verdicts'],
    additionalProperties: false,
  },
};

export const CLAIM_CHECK_PROMPT = [
  'You are checking one tailored resume against the notes it was written from.',
  '',
  'For each bullet below you are given its sources — the person\'s own sentences, which are the ONLY evidence that exists for it. Resume tailoring may reorder, shorten, swap in the employer\'s vocabulary for the same fact, and choose which true things to lead with. It may not add a purpose, an outcome, a condition, a scope, a tool, a number, or a characterisation that the sources do not state.',
  '',
  'Report each bullet once. Copy the bullet back exactly. Quote the source sentence it rests on word for word from the sources given — if you cannot find one, quote the closest and say the whole bullet is unsupported. For `unsupported`, copy the exact substring of the bullet that the quote does not support; use "" when the bullet claims nothing beyond its source.',
  '',
  'Judge the claim, not the wording. "Worked across mobile, backend, and web" written as "front-end (mobile, web) and back-end development" is the same fact in the employer\'s words and is supported. "Retries failed syncs" written as "retries failed syncs to flag anomalies" is not: the source says nothing about anomalies, however ordinary the words are.',
].join('\n');

/**
 * One bullet and its sources, as the checker is given them.
 *
 * Only changed, sourced bullets are sent. An unchanged sentence is the
 * person's own and has nothing to check; an unsourced one has already been
 * dealt with by the time this runs.
 */
export function claimCheckInput(bullets: readonly ResolvedBullet[]): {
  bullet: string;
  sources: string[];
}[] {
  return bullets
    .filter((b) => b.changed && !b.unsourced && b.evidence.length && b.text.trim())
    .map((b) => ({ bullet: b.text, sources: b.evidence }));
}

/** Letters, digits and single spaces — for comparing text that may be respaced. */
const loose = (text: string) => (text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Whether `needle` is really in `haystack`, allowing for punctuation drift. */
const inside = (haystack: string, needle: string) => {
  const hay = loose(haystack);
  const bit = loose(needle);
  return bit.length > 0 && hay.includes(bit);
};

/**
 * The verdicts that survive checking, as flags the honesty pass can apply.
 *
 * `discarded` is the count of verdicts thrown away for failing a check, and it
 * is returned rather than swallowed: a checker that starts answering in its own
 * words shows up as a number in the logs instead of as silence.
 */
export function flagsFromVerdicts(
  verdicts: readonly ClaimVerdict[],
  bullets: readonly ResolvedBullet[],
  sourceLabel = 'your profile',
): { flags: Flag[]; discarded: number } {
  const flags: Flag[] = [];
  let discarded = 0;
  const seen = new Set<string>();

  for (const verdict of verdicts) {
    const said = typeof verdict.unsupported === 'string' ? verdict.unsupported.trim() : '';
    if (!said) continue;

    const named = typeof verdict.bullet === 'string' ? verdict.bullet.trim() : '';
    const quote = typeof verdict.quote === 'string' ? verdict.quote.trim() : '';

    // The bullet it is about has to be one we sent, matched on the text rather
    // than on an index the model could have shifted.
    const bullet = bullets.find((b) => loose(b.text) === loose(named));
    if (!bullet || seen.has(bullet.text)) {
      discarded += 1;
      continue;
    }

    /*
     * Both halves, checked against text the app already holds.
     *
     * The span has to be in the bullet, or there is nothing to act on and the
     * verdict is about a sentence nobody wrote. The quote has to be in the
     * sources, or the evidence it claims to have weighed is its own invention
     * — and a check that can invent its evidence is worse than no check.
     */
    const evidence = bullet.evidence.join(' \n ');
    if (!inside(bullet.text, said) || !inside(evidence, quote)) {
      discarded += 1;
      continue;
    }

    // Nothing to put back. Dropping a sentence on a judgement is for the
    // unsourced case, which this is not: these bullets all have a source.
    const fallback = bullet.evidence[0] ?? '';
    if (!fallback.trim()) {
      discarded += 1;
      continue;
    }

    seen.add(bullet.text);
    flags.push({
      text: bullet.text,
      revertTo: fallback,
      reason: `says "${said.replace(/^[\s,;:—-]+|[\s,;:.—-]+$/g, '')}", which ${sourceLabel} does not`,
    });
  }

  return { flags, discarded };
}
