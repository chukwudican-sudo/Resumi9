import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { NoToolUseError, REQUEST_BUDGET_MS, TruncatedError, callClaude } from '../../../../lib/anthropic';
import { TAILOR_INVARIANT, buildUserContext } from '../../../../lib/systemPrompt';
import { surfaceRepairs, validateTailored } from '../../../../lib/tailorGuard';
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

export const maxDuration = 60;

/** Ten per tailor. Tailoring again gives you ten more. */
const FREE_EDITS = 10;

interface InstructResult {
  structure: ResumeStructure;
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

  let body: { instruction?: unknown };
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

  const content = [
    {
      type: 'text' as const,
      text: [
        'Current tailored resume — the Resume Structure to edit:',
        '```json',
        // Minified. The two-space indent was pure whitespace re-sent on every
        // edit, and the model does not read it any better for being pretty.
        JSON.stringify(structure),
        '```',
        `Job posting — Company: ${posting?.company ?? '(not provided)'}, Role: ${posting?.role ?? '(not provided)'}\n${posting?.description ?? '(no description)'}`,
        `The person has asked for one change: "${instruction}"`,
        'Apply this single instruction as a surgical edit to the structure — only touch the relevant field(s), and return the full structure via the submit_resume_update tool. Do not re-tailor the entire resume from scratch, and do not improve anything you were not asked about. Never add an achievement, a number or a tool that is not already in the structure.',
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
      systemSuffix: buildUserContext({
        displayName: structure.name || user?.displayName,
        locale: user?.locale,
        rules,
        stage: user?.stage,
        targetField: user?.targetField,
      }),
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
    const guarded = validateTailored(structure, toolInput.structure, {
      sourceLabel: 'the previous version',
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

    const resumeId = await saveResume(userId, params.id, {
      structure: guarded.structure,
      // An instruction changes wording, not how well the resume fits the job.
      // INSTRUCT_TOOL returns neither of these, so without carrying them the
      // match tile would go blank on every edit.
      matchScore: current.matchScore,
      missingRequirements: (current.missingRequirements as string[]) ?? [],
      log: [`You asked: "${instruction}"`, ...surfaced.log, ...(toolInput.log ?? [])],
      warnings: [...surfaced.warnings, ...(toolInput.warnings ?? [])],
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
