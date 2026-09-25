import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { NoToolUseError, REQUEST_BUDGET_MS, TruncatedError, callClaude } from '../../../../lib/anthropic';
import { EDIT_LICENCE, TAILOR_INVARIANT, buildUserContext } from '../../../../lib/systemPrompt';
import { readInstruction } from '../../../../lib/asked';
import { asLines, withoutOrderTalk } from '../../../../lib/changeLog';
import { tidyQuestion } from '../../../../lib/question';
import { gapsAfterEdit, rescore } from '../../../../lib/requirementMatch';
import { moveLine, readMove } from '../../../../lib/sectionMove';
import { planSections, withSectionMoved } from '../../../../lib/sections';
import { surfaceRepairs, validateTailored, withoutUndoneClaims } from '../../../../lib/tailorGuard';
import type { ResumeStructure } from '../../../../lib/types';
import { requireUserId } from '../../../../server/auth';
import {
  countInstructedSince,
  getActiveRules,
  getApplication,
  getLatestResume,
  getUser,
  saveResume,
} from '../../../../server/db/repository';
import { capacityResponse, INSTRUCT_TOOL, errorResponse, SERVICE_UNAVAILABLE } from '../../../claude/shared';
import { annotate, resolveTailored, unreadable } from '../../../../lib/provenance';
import { applyFlags, checkBullets } from '../../../../lib/honesty';

// Kept in step with MAX_DURATION_S by a test; Next.js needs a literal here.
export const maxDuration = 120;

/** Ten per tailor. Tailoring again gives you ten more. */
const FREE_EDITS = 10;

/**
 * Said whenever an order is changed, because the order does not travel.
 *
 * A move applies to this resume. Tailoring again rebuilds from the profile,
 * where no such order is recorded, so it comes back in the usual arrangement —
 * and somebody who deliberately placed a section would otherwise discover that
 * days later with no idea what undid it.
 */
const ORDER_IS_LOCAL = 'This order applies to this resume. Tailoring again rebuilds from your profile and puts it back.';

interface InstructResult {
  /** Absent when the model asked a question instead of making the change. */
  structure?: ResumeStructure;
  /** One short question, when the instruction could mean two different things. */
  question?: string;
  log: string[];
  warnings: string[];
  estimatedPages: number | null;
}

/**
 * Changing one thing about a resume, without regenerating it.
 *
 * The only way to alter a tailored resume was "Tailor again", which spends a
 * credit and rewrites the whole document — including the parts somebody was
 * happy with. So a resume that was ninety-five per cent right could not be
 * fixed, only replaced.
 *
 * The tool and the prompt for this already existed on the legacy /api/claude
 * route, which nothing calls any more; the schema was built for it too, and
 * says so — "an instruction edit inserts a new row pointing at its parent
 * rather than mutating". What was missing was a route that reads the profile
 * from the database rather than taking it as an uploaded PDF, and something
 * that saves the result.
 *
 * Free, because a credit means "one application" and charging one to shorten a
 * bullet means nobody ever does it. Capped rather than unlimited, and the cap
 * resets on a real tailor, which costs a credit — so the true bound is credits.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const userId = await requireUserId();

  if (!process.env.ANTHROPIC_API_KEY) {
    return errorResponse({ type: 'auth', message: 'Your API key may be invalid or out of credits.' }, 500);
  }

  let body: { instruction?: unknown; question?: unknown; answer?: unknown };
  try {
    body = await req.json();
  } catch {
    return errorResponse({ type: 'generic', message: 'Invalid JSON body' }, 400);
  }

  const instruction = typeof body.instruction === 'string' ? body.instruction.trim() : '';
  if (!instruction) {
    return errorResponse({ type: 'generic', message: 'Say what you would like changed.' }, 400);
  }
  if (instruction.length > 500) {
    return errorResponse(
      { type: 'generic', message: 'That is longer than an instruction — try one change at a time.' },
      400,
    );
  }

  /** The question that was put to them, and their answer, when one was asked. */
  const question = typeof body.question === 'string' ? body.question.trim().slice(0, 500) : '';
  const answer = typeof body.answer === 'string' ? body.answer.trim().slice(0, 500) : '';

  const [record, current, rules, user, spent] = await Promise.all([
    getApplication(userId, params.id),
    getLatestResume(userId, params.id),
    getActiveRules(userId),
    getUser(userId),
    countInstructedSince(userId, params.id),
  ]);

  if (!record) return errorResponse({ type: 'generic', message: 'Application not found.' }, 404);
  if (!current) {
    return errorResponse({ type: 'generic', message: 'Tailor this resume before editing it.' }, 400);
  }

  if (spent >= FREE_EDITS) {
    return errorResponse(
      {
        type: 'generic',
        message: `That is ${FREE_EDITS} edits on this version. Tailor again for ${FREE_EDITS} more, or restore an earlier version.`,
      },
      429,
    );
  }

  const structure = current.structure as ResumeStructure;
  const posting = record.posting;

  /*
   * Ids on the version being edited, so an edit can be checked the same way a
   * tailor is.
   *
   * The evidence is deliberately the version on screen rather than the profile.
   * An edit is asked to change THIS resume — "shorten the Aegon bullets" means
   * the bullets as they now read — so its source is the text in front of the
   * person. What that costs is that an invention which survived the tailor
   * becomes evidence for the next edit; what it buys is that every ordinary
   * edit is not flagged for departing from a profile it was never editing.
   */
  const { profile: annotated, index } = annotate(structure);

  /*
   * What the person's own words give permission for.
   *
   * Read once, in code, and handed to both checks below. Without it they cannot
   * tell the model dropping a job from somebody asking for it to go, so they
   * undid both — and then told the person "the tailoring dropped your Aegon
   * role and it has been put back", directly under their own instruction saying
   * to remove it.
   */
  /*
   * What the permissions read: the answer first, then the instruction it
   * answers.
   *
   * `readInstruction` resolves an entry name that FOLLOWS the removal word, so
   * "remove it completely" has to come before the "cut the Aegon job" it is
   * answering — otherwise the name it refers to sits behind the verb and
   * resolves to nothing. The model is shown the same two pieces laid out
   * properly below; only this string is ordered for the matcher.
   */
  const asked = readInstruction(answer ? `${answer} ${instruction}` : instruction, structure);

  /*
   * The app's own question, put before anything is spent.
   *
   * No model call, no save, no edit consumed — `countInstructedSince` counts
   * saved rows and this saves none. It covers the few cases the app can see for
   * itself; the model is asked to notice the rest.
   */
  if (!answer && asked.ask) {
    return NextResponse.json({ question: asked.ask, editsLeft: FREE_EDITS - spent });
  }

  /*
   * A section move, read and carried out by the app.
   *
   * The model is never consulted about order. Asked to move a section it has
   * no field to answer with, so it returned the whole resume instead — in a
   * shape nothing could resolve, which is the edit that deleted somebody's
   * coursework line. The order is arithmetic on a list; nothing is gained by
   * asking a model to do it, and a bullet was lost by asking.
   *
   * `null` from the mover means the move cannot be made — a section that is
   * not there, or one already where it was asked to go — and the sentence goes
   * on to the model as if no move had been read.
   */
  const read = readMove(instruction, structure, answer);
  if (read && 'ask' in read) {
    if (!answer) return NextResponse.json({ question: read.ask, editsLeft: FREE_EDITS - spent });
  }
  const move = read && 'move' in read ? read.move : null;
  const reordered = move ? withSectionMoved(planSections(structure), move.key, move.where, move.target) : null;

  /*
   * Nothing but a move: no model call at all.
   *
   * Instant, free, and — more to the point — an instruction that was only ever
   * about order cannot touch a word of the resume, because nothing capable of
   * rewriting one has run. Earning `only` is deliberately hard; anything else
   * in the sentence and this is skipped.
   */
  if (move && reordered && move.only) {
    const resumeId = await saveResume(userId, params.id, {
      structure: { ...structure, sections: reordered },
      matchScore: current.matchScore,
      missingRequirements: (current.missingRequirements as string[]) ?? [],
      log: [`You asked: "${instruction}"`, moveLine(move), ORDER_IS_LOCAL],
      warnings: [],
      estimatedPages: current.estimatedPages,
      mode: 'instructed',
    });
    return NextResponse.json({ resumeId, editsLeft: FREE_EDITS - spent - 1 });
  }

  const said = [
    `The person has asked for one change: "${instruction}"`,
    question ? `You asked them: "${question}"` : '',
    answer ? `They answered: "${answer}"` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const content = [
    {
      type: 'text' as const,
      text: [
        'Current tailored resume — the Resume Structure to edit. Every entry and bullet carries an id: return each entry\'s id unchanged, and name in each bullet\'s "from" the bullet ids it is a rewrite of. A bullet you are not touching needs only its "from", with no text.',
        '```json',
        // Minified. The two-space indent was pure whitespace re-sent on every
        // edit, and the model does not read it any better for being pretty.
        JSON.stringify(annotated),
        '```',
        `Job posting — Company: ${posting?.company ?? '(not provided)'}, Role: ${posting?.role ?? '(not provided)'}\n${posting?.description ?? '(no description)'}`,
        said,
        'Apply this single instruction as a surgical edit to the structure — only touch the relevant field(s), and return the full structure via the submit_resume_update tool. Do not re-tailor the entire resume from scratch, and do not improve anything you were not asked about. Never add an achievement, a number or a tool that is in neither the structure nor the instruction above — the instruction is the person\'s own account of their own work, and Rule 1 names it as evidence.',
      ].join('\n\n'),
    },
  ];

  try {
    const { toolInput } = await callClaude<InstructResult>({
      userId,
      kind: 'instruct',
      system: TAILOR_INVARIANT,
      // The old handler passed none of this, so it ignored the person's own
      // rules and wrote in whatever English it felt like.
      systemSuffix: [
        buildUserContext({
          displayName: structure.name || user?.displayName,
          locale: user?.locale,
          rules,
          stage: user?.stage,
          targetField: user?.targetField,
        }),
        EDIT_LICENCE,
      ].join('\n\n'),
      content,
      tool: INSTRUCT_TOOL,
      // An edit is a model call like any other, and it had no budget at all:
      // only the SDK's per-attempt timeout stood between a slow one and the
      // platform killing the function.
      deadline: Date.now() + REQUEST_BUDGET_MS,
    });

    // The same guard the tailor runs. "Make it shorter" is exactly the
    // instruction that could drop an entry, and this returns a whole structure
    // the same way tailoring does.
    // The source here is the version on screen, not the profile — so the guard
    // is told to say so. "Restored from your profile, unedited" was untrue on
    // every edit, and visibly so: the restored entries came back carrying the
    // previous tailoring's wording.
    /*
     * The same three passes the tailor runs, for the same reason.
     *
     * An edit is a rewrite too, and the one place it is likelier to drift: the
     * model is rewriting a rewrite, with an instruction that often asks for
     * emphasis. "Say I led the team" has to come back reverted, while "I used
     * Docker at Droady, add it" is the person telling it something true.
     */
    /*
     * A question instead of a change.
     *
     * Nothing is saved and no edit is spent: the person answers in the same box
     * and the next call carries both halves. The alternative to asking is
     * guessing, and guessing is what quietly took the first job's second bullet
     * when somebody wrote "drop the second bullet".
     */
    const asking = typeof toolInput.question === 'string' ? toolInput.question.trim() : '';
    if (asking && !toolInput.structure) {
      // Without the list of entries it read back off its own prompt. The app
      // stopped naming them; the model started.
      return NextResponse.json({ question: tidyQuestion(asking, structure), editsLeft: FREE_EDITS - spent });
    }

    const resolved = resolveTailored(toolInput.structure, index);

    /*
     * An answer we could not read is not an answer full of inventions.
     *
     * One edit came back with all 26 bullets word for word in a shape carrying
     * no source. Every one read as invented, every one was deleted, and the
     * section with no floor under it lost its only line. Changing nothing is
     * the honest response, and an edit costs nothing to try again.
     */
    if (unreadable(resolved.bullets)) {
      console.error('[Resumi9] Instruct came back in a shape we could not read; nothing changed.');
      return errorResponse(
        { type: 'generic', message: 'That came back in a shape we could not read, so nothing was changed. Try again.' },
        502,
      );
    }

    const flags = checkBullets(resolved.bullets, (posting?.requirements as string[]) ?? [], asked, 'the previous version');
    const honest = applyFlags(resolved.structure, flags, 'the previous version');

    // The source here is the version on screen, not the profile — so the guard
    // is told to say so. "Restored from your profile, unedited" was untrue on
    // every edit, and visibly so: the restored entries came back carrying the
    // previous tailoring's wording.
    const guarded = validateTailored(structure, honest.structure, {
      sourceLabel: 'the previous version',
      asked,
    });
    const surfaced = surfaceRepairs(guarded.repairs);

    // Nothing in the edit matched the version it was editing, so there is no
    // edit — only the previous version copied back under a new number. Saying
    // so beats saving a version whose whole change log is "we put this back".
    if (guarded.unusable) {
      console.error('[Resumi9] Instruct returned nothing that matched the current version.');
      return errorResponse(
        { type: 'generic', message: 'That edit came back unusable, so nothing was changed. Try again.' },
        502,
      );
    }

    /*
     * The move, applied after the guard rather than before it.
     *
     * The guard copies `sections` from the source unconditionally, which is
     * what keeps the model out of the ordering — so a move written before it
     * would be overwritten by the guard a moment later. Recomputed against the
     * guarded structure too, because the guard may have restored a section the
     * model dropped, and the order has to cover what is actually there.
     */
    const edited = move
      ? {
          ...guarded.structure,
          sections:
            withSectionMoved(planSections(guarded.structure), move.key, move.where, move.target) ??
            guarded.structure.sections,
        }
      : guarded.structure;

    /** Order talk is only the app's to make, and only when there was a move. */
    const quiet = (lines: string[]) => (move ? withoutOrderTalk(lines) : lines);

    const requirements = (posting?.requirements as string[]) ?? [];
    const carriedGaps = (current.missingRequirements as string[]) ?? [];
    const gaps = gapsAfterEdit(carriedGaps, edited, requirements);

    const resumeId = await saveResume(userId, params.id, {
      structure: edited,
      /*
       * Measured again, against the resume this edit just produced.
       *
       * These were carried forward untouched on the reasoning that an edit
       * changes wording rather than fit. It does not hold: an edit can add the
       * exact tool a posting asked for, or delete the job that evidenced it.
       * So the panel sat at 35/100 above a list of thirteen gaps that had
       * stopped being true three edits earlier — the app's own account of the
       * resume, contradicted by the resume next to it.
       *
       * No model call. The gap list is a literal check the app already owns,
       * and the score is nudged by what that check found; see `rescore`.
       */
      matchScore: rescore(current.matchScore, carriedGaps, gaps, requirements),
      missingRequirements: gaps,
      log: [
        `You asked: "${instruction}"`,
        /*
         * The answer is part of what was asked.
         *
         * It decided the edit — "drop the second bullet" removed FraudWatch's
         * because that is what the answer named — so a log holding only the
         * opening sentence records the question and loses the decision. It is
         * also the only place the exchange is kept at all: a question saves no
         * row, so without this line nothing anywhere remembers it happened.
         */
        ...(answer ? [`We asked: ${question || 'which one?'} You said: "${answer}"`] : []),
        ...(move ? [moveLine(move), ORDER_IS_LOCAL] : []),
        ...surfaced.log,
        ...honest.log,
        // The model's own account comes last and is the only one nobody
        // verified — so a line claiming it removed something the guard put back
        // does not survive to sit beside the notice saying otherwise.
        /*
         * The model's own account comes last, and twice filtered when the app
         * arranged the sections: it does not get to claim a removal the guard
         * undid, and it does not get to narrate the ordering it had no part in.
         */
        ...quiet(withoutUndoneClaims(asLines(toolInput.log), guarded.restored)),
      ],
      warnings: [...surfaced.warnings, ...honest.warnings, ...quiet(asLines(toolInput.warnings))],
      // Carried, not asked for. The model's guess was wrong every time it was
      // checked — "slightly over 1 page" for a resume that filled two — so the
      // tool no longer requests it. A real measurement replaces this later.
      estimatedPages: current.estimatedPages,
      mode: 'instructed',
    });

    return NextResponse.json({ resumeId, editsLeft: FREE_EDITS - spent - 1 });
  } catch (error) {
    const refused = capacityResponse(error);
    if (refused) return refused;
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
      return errorResponse({ type: 'auth', message: 'Your API key may be invalid or out of credits.' }, 401);
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
          message: 'That took longer than we allow and was stopped. Try again in a moment.',
        },
        504,
      );
    }
    if (error instanceof Anthropic.APIConnectionError) {
      return errorResponse({ type: 'network', message: 'Your internet connection dropped.' }, 503);
    }
    // Ran out of room part way through, so whatever came back is half an edit.
    if (error instanceof TruncatedError) {
      return errorResponse(
        { type: 'generic', message: 'That edit came back cut off, so nothing was changed. Try again.' },
        502,
      );
    }
    if (error instanceof NoToolUseError) return errorResponse({ type: 'generic', message: SERVICE_UNAVAILABLE }, 502);
    console.error('[Resumi9] Instruct failed.', error);
    return errorResponse({ type: 'generic', message: SERVICE_UNAVAILABLE }, 502);
  }
}
