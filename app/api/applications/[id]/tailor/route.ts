import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { NoToolUseError, REQUEST_BUDGET_MS, TruncatedError, callClaude } from '../../../../lib/anthropic';
import { TAILOR_INVARIANT, buildUserContext } from '../../../../lib/systemPrompt';
import type { ResumeStructure } from '../../../../lib/types';
import { surfaceRepairs, validateTailored, withoutUndoneClaims } from '../../../../lib/tailorGuard';
import { requireUserId } from '../../../../server/auth';
import { MONTHLY_CREDITS } from '../../../../lib/credits';
import { hasEnoughToTailor } from '../../../../lib/readiness';
import { matchRequirements } from '../../../../lib/requirementMatch';
import { annotate, cutTargets, resolveTailored, unreadable } from '../../../../lib/provenance';
import { applyFlags, checkBullets } from '../../../../lib/honesty';
import { asLines } from '../../../../lib/changeLog';
import { renderResumeLatex } from '../../../../lib/latexEngine';
import { compileWithMeta } from '../../../../server/pdf';
import { fitToPages } from '../../../../lib/fit';
import { COMPILE_ESTIMATE_MS, affords } from '../../../../lib/budget';
import { pageTarget, type RuleCheck } from '../../../../lib/rules';
import {
  getActiveRules,
  getUser,
  getApplication,
  getProfile,
  getSupportingFacts,
  refundCredit,
  saveResume,
  spendCredit,
} from '../../../../server/db/repository';
import { capacityResponse, tailorToolFor, errorResponse, SERVICE_UNAVAILABLE } from '../../../claude/shared';

export const maxDuration = 60;

interface TailorResult {
  structure: ResumeStructure;
  log: string[];
  matchScore: number;
  missingRequirements: string[];
  /**
   * Bullet ids, least relevant to this posting first.
   *
   * A ranking and nothing else. How much of it gets spent is the app's
   * decision, made against the compiler's page count — see lib/fit.ts.
   */
  cutOrder: string[];
  warnings: string[];
}

/** Rewrites the profile around one job posting and keeps the result. */
export async function POST(_request: Request, { params }: { params: { id: string } }) {
  const userId = await requireUserId();
  // The budget lives beside the per-attempt timeouts in lib/anthropic.ts, not
  // here. Held apart, the two numbers drifted: this route budgeted 52s while
  // the tailor's own timeout was 45s, so the timeout always fired first and the
  // budget never once ran.
  const deadline = Date.now() + REQUEST_BUDGET_MS;

  if (!process.env.ANTHROPIC_API_KEY) {
    return errorResponse({ type: 'auth', message: 'Your API key may be invalid or out of credits.' }, 500);
  }

  const [record, profile, rules, user, supporting] = await Promise.all([
    getApplication(userId, params.id),
    getProfile(userId),
    getActiveRules(userId),
    getUser(userId),
    // What they have answered that is not on the resume. Until now these were
    // written and never read: somebody answered three questions about their
    // achievements, paid a credit to re-tailor, and got the same resume back.
    getSupportingFacts(userId),
  ]);

  if (!record) return errorResponse({ type: 'generic', message: 'Application not found.' }, 404);

  const profileStructure = (profile?.resumeStructure ?? null) as ResumeStructure | null;
  // A name alone used to be enough to get past here, and this check sits ABOVE
  // the spend — so an empty resume did not just produce nothing, it cost a
  // credit to produce nothing.
  if (!hasEnoughToTailor(profileStructure)) {
    return errorResponse({ type: 'generic', message: 'Build your profile first.' }, 400);
  }

  // Spend before generating. The other order lets two tabs both produce a
  // resume on the last remaining credit.
  const remaining = await spendCredit(userId);
  if (remaining === null) {
    return errorResponse(
      {
        type: 'generic',
        message: `You've used all ${MONTHLY_CREDITS} free applications this month. They come back on the 1st.`,
      },
      402,
    );
  }

  // Everything after the spend is inside the try, so there is no path that takes
  // a credit and leaves without either a resume or a refund. The editorial pass
  // below swallows its own failures, but the reads around it do not, and the
  // rule is easier to keep than to check line by line.
  try {
    // The editorial pass used to run here, and it was half the wait.
    //
    // The reasoning was sound — tailoring reads the master resume, so it should
    // read the tidy version rather than skills still written as sentences. What
    // was wrong was the moment: two model calls and some twenty-five serialised
    // database round trips, in front of somebody waiting on a job application.
    //
    // It runs when you press Done on /setup instead, where you have already
    // stopped. By the time you get here the resume is tidy and this is one call.
    // Narrowed by hasEnoughToTailor above, which requires a name.
    const structure = profileStructure!;

    const posting = record.posting;

    // Things they have told us that never made it onto the page. Offered as
    // material the tailor may use, never as licence to invent: each line is
    // something the person said in their own words, so working one in is
    // reporting rather than embellishing.
    /*
     * Every bullet and fact carries an id now, and the facts carry the entry
     * they were answered about.
     *
     * That last part was being thrown away: `getSupportingFacts` selects
     * `entryId` and this route mapped it to text alone, so a fact about one job
     * was evidence for every job. It is what makes "this bullet moved work in
     * from somewhere else" a thing code can see rather than a thing to argue
     * about in the prompt.
     */
    const { profile: annotated, index } = annotate(structure, supporting);

    const said = supporting.length
      ? 'Also true of this person, in their own words, from questions they have answered — the `facts` list above. These are NOT yet on the resume. Use any that the posting makes relevant, worked into an existing entry rather than added as a new one, and name its id in that bullet\'s "from". They are the only other thing you may draw on, and you may not extrapolate beyond what each one says.'
      : null;

    const content = [
      {
        type: 'text' as const,
        text: [
          'Their profile — the Resume Structure to edit. This is the resume of record; keep the same entries, dates, and section identities, and rewrite freely within them. Every entry and bullet carries an id: return each entry\'s id unchanged, and name in each bullet\'s "from" the bullet or fact ids it is a rewrite of.',
          '```json',
          // Minified. The two-space indent was about three hundred tokens of
          // pure whitespace re-sent on every tailor, and the model does not read
          // it any better for being pretty.
          JSON.stringify(annotated),
          '```',
          said,
          `Job posting — Company: ${posting?.company ?? '(not provided)'}, Role: ${posting?.role ?? '(not provided)'}\n${posting?.description ?? '(no description)'}`,
          said
            ? 'Produce the tailored resume now via submit_tailored_resume. The structure and the facts above are your only sources for what this person has done — tailor within them and invent nothing to fill gaps. A bullet you are leaving as it stands needs only its "from"; leave its text out.'
            : 'Produce the tailored resume now via submit_tailored_resume. The structure above is your only source for what this person has done, so tailor within it and invent nothing to fill gaps. A bullet you are leaving as it stands needs only its "from"; leave its text out.',
        ]
          .filter(Boolean)
          .join('\n\n'),
      },
    ];

    const { toolInput } = await callClaude<TailorResult>({
      userId,
      kind: 'tailor',
      system: TAILOR_INVARIANT,
      systemSuffix: buildUserContext({
        displayName: structure.name || user?.displayName,
        locale: user?.locale,
        rules,
        stage: user?.stage,
        targetField: user?.targetField,
      }),
      content,
      // The summary field only exists when the profile has one. The guard drops
      // a summary a master resume does not have, so offering the field meant the
      // model wrote one, the guard binned it, and the change log still announced
      // "Added a summary…" on a resume with no summary on it.
      tool: tailorToolFor({ hasSummary: Boolean(structure.summary?.trim()) }),
      deadline,
    });

    // Checked before it is stored, because a tailored resume came back missing
    // a fifteen-month job and nothing noticed. The model's own change log had
    // sixteen entries and mentioned that role in none of them, and its warnings
    // were empty — three self-reports from one pass, all silent, which is why
    // this is arithmetic rather than another line of prompt.
    /*
     * Three passes, in this order, and the order is the point.
     *
     * `resolveTailored` turns each bullet back into a sentence and records the
     * profile bullet it named as its source. `checkBullets` compares what the
     * sentence claims against that source and nothing else — a posting's words
     * are not evidence, and neither is another entry's work. `applyFlags` puts
     * the person's own wording back where a claim was not earned.
     *
     * Only then does the guard run, so it is checking the resume that will
     * actually be saved: a bullet reverted here must still be counted when it
     * decides whether anything was dropped.
     */
    const resolved = resolveTailored(toolInput.structure, index);

    /*
     * The same exposure as the edit path, and the same answer.
     *
     * A reply whose every changed bullet answers to nothing is one we failed to
     * read. Here it would be worse than on an edit: the guard would hand back
     * the profile's own bullets and save that as a tailored resume, for a
     * credit.
     */
    if (unreadable(resolved.bullets)) {
      await refundCredit(userId);
      console.error('[Resumi9] Tailoring came back in a shape we could not read; refunded.');
      return errorResponse(
        {
          type: 'generic',
          message: 'That came back in a shape we could not read, so nothing was saved.',
          creditKept: true,
        },
        502,
      );
    }

    const flags = checkBullets(resolved.bullets, (posting?.requirements as string[]) ?? []);
    const honest = applyFlags(resolved.structure, flags);
    if (flags.length) {
      console.error(`[Resumi9] Tailoring made ${flags.length} claim(s) the profile does not support; put back.`);
    }

    const guarded = validateTailored(structure, honest.structure);
    const surfaced = surfaceRepairs(guarded.repairs);

    /*
     * A tailor that restored everything is a failed tailor, not a finished one.
     *
     * This happened for real: the model wrote 3,315 output tokens, none of it
     * arrived in a shape the guard could read, and the profile was saved back
     * as a "tailored" resume — 28 of 28 bullets identical — with eleven
     * warnings and a credit gone. The person got their own resume with a new
     * filename and no way to know.
     */
    if (guarded.unusable) {
      await refundCredit(userId);
      console.error('[Resumi9] Tailoring returned nothing that matched the profile; refunded.');
      return errorResponse(
        {
          type: 'generic',
          // The screen says the credit came back and offers the retry, so
          // neither belongs in the sentence as well.
          message: 'That came back unusable, so nothing was saved.',
          creditKept: true,
        },
        502,
      );
    }

    const restored = guarded.repairs.filter((r) => r.kind === 'entry').length;
    if (restored) {
      // Countable without a database query. An entry going missing is the
      // model breaking a rule it was given, and it should be visible that it
      // happens rather than only that it was caught.
      console.error(`[Resumi9] Tailoring dropped ${restored} entr${restored === 1 ? 'y' : 'ies'}; restored from the profile.`);
    }

    /*
     * How long it actually came out, and cutting it down if it runs over.
     *
     * Last, and optional, because of the rule that governs everything after the
     * model call: a finished resume is never thrown away for want of a number.
     * Every compile here asks the budget first, so a tailor that has already
     * eaten the clock degrades to "not measured" — a length nobody counted,
     * which reads as guidance rather than as a broken page rule.
     *
     * The cutting is the app's, never the model's. It ranked the bullets by how
     * little they matter for this posting; what that ranking is spent on is
     * decided against the compiler's own page count, and if spending all of it
     * still does not reach the target then none of it is spent.
     */
    const fitted = await fitToPages(guarded.structure, {
      target: pageTarget(
        rules.map((r) => ({ id: r.id, text: r.text, check: (r.check as RuleCheck) ?? null })),
      ),
      /*
       * The model's ranking, followed to the sentences that actually survived.
       *
       * Two passes have been over these bullets since it wrote them: the
       * honesty check put the person's own wording back wherever a rewrite
       * claimed more than its source, and the guard restored anything dropped.
       * Following an id to the model's text would name sentences that are no
       * longer on the page.
       */
      cuts: cutTargets(
        toolInput.cutOrder,
        resolved.bullets,
        index,
        new Map(flags.map((f) => [f.text, f.revertTo])),
      ),
      affords: () => affords(deadline, COMPILE_ESTIMATE_MS),
      measure: async (candidate) => {
        try {
          return (await compileWithMeta(renderResumeLatex(candidate))).pages;
        } catch (err) {
          // The resume is fine; only the measurement failed. It is not worth a
          // person's tailor, and the log is where this belongs.
          console.error('[Resumi9] Could not measure the tailored resume:', err);
          return null;
        }
      },
    });

    const resumeId = await saveResume(userId, params.id, {
      structure: fitted.structure,
      matchScore: toolInput.matchScore ?? null,
      /*
       * The model's list, plus any requirement a literal check cannot find on
       * the finished resume.
       *
       * Asked to report its own gaps, the model reports the ones it did not
       * paper over. One tailor wrote "analytics-driven prediction logic" into a
       * bullet and machine learning — named by that posting, absent from this
       * profile — simply stopped appearing here. A gap the person never sees is
       * a question they get asked in the interview instead.
       */
      missingRequirements: [
        ...(toolInput.missingRequirements ?? []),
        ...matchRequirements(fitted.structure, (posting?.requirements as string[]) ?? []).missing.filter(
          (gap) =>
            !(toolInput.missingRequirements ?? []).some((named) =>
              named.toLowerCase().includes(gap.toLowerCase()),
            ),
        ),
      ],
      // Guard lines lead. The point of a restore notice is lost at item
      // fourteen of sixteen.
      // Guard lines lead, then what was put back for being unsupported, then
      // the model's own account of what it did. The model's line comes last on
      // purpose: it is the only one of the three nobody verified.
      log: [
        ...surfaced.log,
        ...honest.log,
        ...fitted.log,
        ...withoutUndoneClaims(asLines(toolInput.log), guarded.restored),
      ],
      warnings: [...surfaced.warnings, ...honest.warnings, ...fitted.warnings, ...asLines(toolInput.warnings)],
      // The column exists and nothing has ever read it back, so the model is
      // no longer asked to produce a number for it. `pageCount` is the real
      // one, and the only one anything reads.
      estimatedPages: null,
      pageCount: fitted.pages,
    });

    // Said out loud rather than done quietly: polishing regroups skills and
    // can reorder sections, and finding that out from a resume you already
    // sent is worse than being told now.
    return NextResponse.json({
      resumeId,
      creditsLeft: remaining,
    });
  } catch (error) {
    // Nothing was produced, so the credit goes back.
    //
    // Every failure below lands here, and `saveResume` is the last thing before
    // the success return — so reaching this catch means there is no tailored
    // resume anywhere. Charging for that is charging for an outage.
    await refundCredit(userId);

    // Our own budget ran out, not the network's. Distinguishable because the
    // SDK throws this only for a caller-supplied signal — a timeout throws
    // APIConnectionTimeoutError instead.
    if (error instanceof Anthropic.APIUserAbortError) {
      return errorResponse(
        {
          type: 'generic',
          message: 'That took longer than we allow and was stopped.',
          creditKept: true,
        },
        504,
      );
    }

    const refused = capacityResponse(error);
    if (refused) return refused;
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
      return errorResponse(
        { type: 'auth', message: 'Your API key may be invalid or out of credits.', creditKept: true },
        401,
      );
    }
    // A timeout is not a dropped connection, and saying so sends people to
    // check a router that is working fine. APIConnectionTimeoutError EXTENDS
    // APIConnectionError in this SDK, so the branch below swallowed it — and it
    // only started firing once the client was given a real timeout, at which
    // point the slowest call in the app began blaming the person's internet.
    if (error instanceof Anthropic.APIConnectionTimeoutError) {
      return errorResponse(
        {
          type: 'network',
          // The refund above already ran; creditKept is how the screen knows to
          // say so, which is the difference between trying again and assuming
          // it cost something.
          message: 'That took longer than we allow and was stopped.',
          creditKept: true,
        },
        504,
      );
    }
    if (error instanceof Anthropic.APIConnectionError) {
      return errorResponse(
        { type: 'network', message: 'Your internet connection dropped.', creditKept: true },
        503,
      );
    }
    // Cut off part way through, so whatever arrived is half a resume. It used
    // to be handed to the guard, which restored the missing half from the
    // profile and saved the result as a finished tailor.
    if (error instanceof TruncatedError) {
      return errorResponse(
        {
          type: 'generic',
          message: 'That came back cut off, so nothing was saved.',
          creditKept: true,
        },
        502,
      );
    }
    if (error instanceof NoToolUseError) {
      return errorResponse({ type: 'generic', message: SERVICE_UNAVAILABLE, creditKept: true }, 502);
    }
    console.error('[Resumi9] Tailoring failed:', error);
    return errorResponse({ type: 'generic', message: SERVICE_UNAVAILABLE, creditKept: true }, 502);
  }
}
