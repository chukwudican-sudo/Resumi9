import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { NoToolUseError, REQUEST_BUDGET_MS, TruncatedError, callClaude } from '../../../../lib/anthropic';
import { EDIT_LICENCE, TAILOR_INVARIANT, buildUserContext } from '../../../../lib/systemPrompt';
import { readInstruction } from '../../../../lib/asked';
import { pinEntry, readPins, samePin, type Pin } from '../../../../lib/pins';
import { asLines, withoutOrderTalk } from '../../../../lib/changeLog';
import { tidyQuestion } from '../../../../lib/question';
import { gapsAfterEdit, rescore } from '../../../../lib/requirementMatch';
import { moveLine, readMove } from '../../../../lib/sectionMove';
import { couldComeBack, readRestore, restoreLine, withRestored, type Restore } from '../../../../lib/restore';
import { fitToPages, type DroppedEntry } from '../../../../lib/fit';
import { planSections, withSectionMoved } from '../../../../lib/sections';
import { renderResumeLatex } from '../../../../lib/latexEngine';
import { compileWithMeta } from '../../../../server/pdf';
import { COMPILE_ESTIMATE_MS, affords } from '../../../../lib/budget';
import { pageTarget, type RuleCheck } from '../../../../lib/rules';
import { frozenLine, onlyWhereAsked, readScope } from '../../../../lib/scope';
import { surfaceRepairs, validateTailored, withoutUndoneClaims } from '../../../../lib/tailorGuard';
import type { ResumeStructure } from '../../../../lib/types';
import { requireUserId } from '../../../../server/auth';
import {
  countInstructedSince,
  getActiveRules,
  getApplication,
  getLatestResume,
  getProfile,
  getSupportingFacts,
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

  let body: { instruction?: unknown; question?: unknown; answer?: unknown; wholeResume?: unknown; scope?: unknown };
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
  /*
   * "I meant the whole resume."
   *
   * An edit is held to what its sentence named, and the sentence beside the
   * result says so and offers this. Sent back on a second try rather than
   * applied to the version already saved: the first result stands, and the
   * person gets a new version either way.
   */
  const wholeResume = body.wholeResume === true || body.scope === 'all';

  const [record, current, rules, user, spent, supporting, profile] = await Promise.all([
    getApplication(userId, params.id),
    getLatestResume(userId, params.id),
    getActiveRules(userId),
    getUser(userId),
    countInstructedSince(userId, params.id),
    /*
     * What they have already told us, which an edit could not see.
     *
     * The tailor has had these for months; the edit was handed the finished
     * page and nothing else. So an edit had two options for anything not
     * already printed — invent it, which the guard reverts, or ask for it —
     * and it asked. The person had answered the same question in /interview
     * weeks earlier.
     */
    getSupportingFacts(userId),
    // For what could come back: an entry they have but this page does not.
    getProfile(userId),
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
  const profileStructure = (profile?.resumeStructure ?? null) as ResumeStructure | null;
  const posting = record.posting;

  /*
   * What this sentence promises to keep, added to what the application already
   * promised.
   *
   * Read here, before anything else is decided, because every branch below
   * saves a version and all of them have to carry it: the pin is for the NEXT
   * tailor, which is the fit that would otherwise take the same thing off a
   * second time. A restore is itself a promise and is pinned where it happens.
   */
  const promised = (current.pins as Pin[]) ?? [];
  const alsoPinned = (more: readonly Pin[]) => {
    const out = [...promised];
    for (const pin of more) {
      if (!out.some((p) => p.place === pin.place && samePin(p.text, pin.text))) out.push(pin);
    }
    return out;
  };
  const pins = alsoPinned(readPins(answer ? `${answer} ${instruction}` : instruction, structure));

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
  // With the facts, so a bullet written from one resolves to real evidence
  // rather than to nothing. Handed the page alone, the honesty check read
  // every such bullet as invented and deleted it.
  const { profile: annotated, index } = annotate(structure, supporting);

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
   * Putting back what the app took off, read and carried out by the app.
   *
   * The entry is copied from what was kept when it was cut, word for word, so
   * there is nothing to retype and nothing to invent. Same shape as a section
   * move: the app does the thing it can do exactly, and the model is only
   * asked to read a sentence — and here, not even that, unless this misses.
   */
  /*
   * Everything that could come back, not only what the app took off.
   *
   * `dropped` holds entries as they were printed and is the better source, so
   * it stays first. But it was the ONLY source, and a real edit asking to
   * bring a project in was answered "Rate Limit Lab is not available to add"
   * — about a project sitting in the person's own profile. Their profile is
   * not the app's bookkeeping, and they should not have to know the
   * difference.
   */
  const kept = ((current.dropped as DroppedEntry[]) ?? []).filter((d) => d && d.entry);
  const available = couldComeBack(kept, profileStructure, structure);
  const asking = readRestore(instruction, available, answer);
  if (asking && 'ask' in asking && !answer) {
    return NextResponse.json({ question: asking.ask, editsLeft: FREE_EDITS - spent });
  }
  const restore = asking && 'restore' in asking ? asking.restore : null;

  /**
   * The app brings an entry back itself, and makes room for it.
   *
   * Used by both paths that can reach it: a sentence that asks for nothing
   * else, and a sentence the model answered with a question it did not need
   * to ask. Copied from what the app kept rather than rebuilt, so nothing can
   * be invented on the way and the honesty check has nothing to flag.
   */
  async function restoreOnly(restore: Restore, lines: string[]) {
    const back = new Set(restore.entries.map((e) => `${e.section}:${e.index}`));
    /*
     * Asking for something back is the clearest possible way of saying keep
     * it. Without this the next tailor takes it off again — the same job, for
     * the same reason, one version after they told the app otherwise.
     */
    const pins = alsoPinned(restore.entries.map((e) => pinEntry(e.section, e.name)));

    /*
     * Room is made for it, rather than the page rule simply breaking.
     *
     * This used to put the entry back and say the resume was "likely over the
     * page limit again" — true, unhelpful, and the next tailor would take the
     * same thing off. The fitter is now run with what they asked for pinned,
     * so something they did NOT ask about gives instead: a skills line first,
     * then the oldest unpinned entry. If nothing unpinned is enough, it says
     * so and keeps what they asked for.
     *
     * No model call on this path, so the whole request budget is free for the
     * two or three compiles this costs.
     */
    const restored = withRestored(structure, restore.entries);
    const fitted = await fitToPages(restored, {
      target: pageTarget(
        rules.map((r) => ({ id: r.id, text: r.text, check: (r.check as RuleCheck) ?? null })),
      ),
      cuts: [],
      posting: [posting?.description ?? '', ((posting?.requirements as string[]) ?? []).join(' ')].join(' \n '),
      pinned: pins,
      measure: async (candidate: ResumeStructure) => {
        try {
          return (await compileWithMeta(renderResumeLatex(candidate))).pages;
        } catch (err) {
          console.error('[Resumi9] Could not measure a restored resume:', err);
          return null;
        }
      },
      affords: () => affords(deadline, COMPILE_ESTIMATE_MS),
    });

    const resumeId = await saveResume(userId, params.id, {
      structure: fitted.structure,
      matchScore: current.matchScore,
      missingRequirements: (current.missingRequirements as string[]) ?? [],
      log: [...lines, ...fitted.log],
      warnings: fitted.warnings,
      estimatedPages: current.estimatedPages,
      pageCount: fitted.pages,
      /*
       * Off the list, and whatever the fitter has just taken off is on it.
       *
       * Without the second half, making room would lose an entry with nothing
       * recording that it went — which is the bookkeeping that made "add it
       * back" work in the first place.
       */
      dropped: [...kept.filter((d) => !back.has(`${d.section}:${d.index}`)), ...fitted.dropped],
      pins,
      mode: 'instructed',
    });
    return { resumeId, editsLeft: FREE_EDITS - spent - 1 };
  }

  if (restore && restore.only) {
    return NextResponse.json(
      await restoreOnly(restore, [`You asked: "${instruction}"`, restoreLine(restore.entries)]),
    );
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
      pins,
      estimatedPages: current.estimatedPages,
      dropped: (current.dropped as unknown[]) ?? [],
      mode: 'instructed',
    });
    return NextResponse.json({ resumeId, editsLeft: FREE_EDITS - spent - 1 });
  }

  /*
   * What the app took off this resume, named for the model.
   *
   * Names and dates only — never the bullets. The model does not need them:
   * if somebody asks for one back the APP copies the entry from here word for
   * word, the same way it applies a section move. Nothing is retyped, so
   * nothing can be invented on the way, and the honesty check has nothing to
   * flag.
   *
   * Shown on every edit rather than only when a restore is asked for, because
   * "why is there just one job" is a question the model cannot answer from a
   * page it has been handed alone. It answered it with a question back, and
   * the person was left explaining their own resume to it.
   */
  const removed = available
    .map((d) => (d?.name ? `${d.name}${(d.entry as { dates?: string })?.dates ? ` (${(d.entry as { dates?: string }).dates})` : ''}` : ''))
    .filter(Boolean);

  const said = [
    `The person has asked for one change: "${instruction}"`,
    /*
     * Their own answers, offered before the model can ask for them again.
     *
     * Worded for an EDIT rather than a tailor: the tailor is invited to work
     * relevant facts in, where an edit may only use one if the instruction
     * asks for something it covers. "Do not ask for what is already here" is
     * said outright, because being asked for a fact you have already given is
     * the thing that broke the first revision anybody tried.
     */
    supporting.length
      ? `Also true of this person, in their own words, from questions they have answered — the \`facts\` list in the JSON above. They are NOT on this resume. If the instruction asks for something one of them covers, use it and name its id in that bullet's "from". Do not ask them for anything the facts or the structure already contain.`
      : '',
    question ? `You asked them: "${question}"` : '',
    answer ? `They answered: "${answer}"` : '',
    removed.length
      /*
       * Everything that could come back, and a flat refusal to ask for its
       * content.
       *
       * It asked. Handed "replace Kudi Kitchen with Rate Limit Lab" and a
       * list naming Rate Limit Lab, it came back with a question — "I don't
       * have any details (bullets, tech, dates) for Rate Limit Lab" — and the
       * person typed the bullets out by hand. The app had them: it splices
       * the entry in from what it kept, word for word, which is the only way
       * it CAN arrive without being invented.
       */
      ? `Not on this resume, and available: ${removed.join(', ')}. Either the app removed it to reach the page limit in their rules, or it is in their profile and this resume does not use it — either way they did not remove it. If they ask why something is missing, say so plainly and name it. If they ask for any of it back, or to swap one in for something else, the APP splices it in from what it kept: do the REST of the instruction, say in your log that the entry is being put back, and never write the entry yourself. Do not ask them for its bullets, tech or dates — you do not need them and the app already has them.`
      : '',
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

  const deadline = Date.now() + REQUEST_BUDGET_MS;

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
      deadline,
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
      /*
       * A question the app can already answer is not asked.
       *
       * It asked for Rate Limit Lab's bullets, tech and dates, about a
       * project sitting in the person's own profile — and the question
       * returned here threw away the restore the app had already read off the
       * same sentence. They typed two bullets out by hand to tell the app
       * something it knew, and the version that came back had the project
       * twice.
       *
       * So where a restore was read, it is carried out: copied from what the
       * app kept, word for word, with room made for it. Only the half of the
       * instruction that needed a model goes unanswered, and the log says so
       * rather than leaving them to wonder.
       */
      if (restore) {
        const done = await restoreOnly(restore, [
          `You asked: "${instruction}"`,
          restoreLine(restore.entries),
          'The rest of that instruction needs another go — ask again and it will be read against this version.',
        ]);
        return NextResponse.json(done);
      }
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

    const flags = checkBullets(
      resolved.bullets,
      (posting?.requirements as string[]) ?? [],
      asked,
      'the previous version',
      [posting?.description ?? '', ((posting?.requirements as string[]) ?? []).join(' ')].join(' \n '),
    );
    const honest = applyFlags(resolved.structure, flags, 'the previous version');

    // The source here is the version on screen, not the profile — so the guard
    // is told to say so. "Restored from your profile, unedited" was untrue on
    // every edit, and visibly so: the restored entries came back carrying the
    // previous tailoring's wording.
    const guarded = validateTailored(structure, honest.structure, {
      sourceLabel: 'the previous version',
      asked,
      alsoSaid: supporting.map((fact) => fact.text).join(' \n '),
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
    const moved = move
      ? {
          ...guarded.structure,
          sections:
            withSectionMoved(planSections(guarded.structure), move.key, move.where, move.target) ??
            guarded.structure.sections,
        }
      : guarded.structure;

    // After the guard, like the move: the guard compares against the resume as
    // it was, and an entry spliced in beforehand would read to it as one the
    // model invented.
    const restored = restore ? withRestored(moved, restore.entries) : moved;
    const putBack = new Set((restore?.entries ?? []).map((e) => `${e.section}:${e.index}`));

    /*
     * Held to what the sentence named, last of all.
     *
     * After the guard and after a restore, because both of those put things
     * back that the model took — read before them, a restored entry would
     * look like a change nobody asked for, and the guard's own repairs would
     * be reverted as unasked rewrites. Scoping is about what the MODEL
     * changed on its own initiative, so it goes after everything the app did
     * deliberately.
     *
     * A restored entry is in scope whatever the sentence said: asking for
     * something back is naming it.
     */
    const namedToo = restore ? `${instruction} ${restore.entries.map((e) => e.name).join(' ')}` : instruction;
    const scope = readScope(answer ? `${namedToo} ${answer}` : namedToo, structure, wholeResume);
    const held = onlyWhereAsked(structure, restored, scope);
    const edited = held.structure;
    if (held.frozen.length) {
      console.error(`[Resumi9] An edit rewrote ${held.frozen.join(', ')}, which it was not asked about.`);
    }

    /** Order talk is only the app's to make, and only when there was a move. */
    const quiet = (lines: string[]) => (move ? withoutOrderTalk(lines) : lines);

    /*
     * How long it is now, which an edit never asked.
     *
     * The page rule was enforced at tailor time and then left alone: an edit
     * cuts nothing, so a sentence that adds a line, puts an entry back or
     * lengthens three bullets could take the resume over the limit and say
     * nothing about it. The person found out from the PDF.
     *
     * One compile, and only if there is budget left after the model call —
     * everything below treats "not measured" as not a failure, the same way
     * the fitter does.
     */
    const target = pageTarget(
      rules.map((r) => ({ id: r.id, text: r.text, check: (r.check as RuleCheck) ?? null })),
    );
    const measure = async (candidate: ResumeStructure) => {
      try {
        return (await compileWithMeta(renderResumeLatex(candidate))).pages;
      } catch (err) {
        // The resume is fine; only the measurement failed. Never worth an edit.
        console.error('[Resumi9] Could not measure the edited resume:', err);
        return null;
      }
    };

    /*
     * Room is made when something was ADDED, and only then.
     *
     * A sentence that brings an entry in — "replace Kudi Kitchen with Rate
     * Limit Lab" — has made the resume longer, and the old behaviour was to
     * leave it over the limit with a note: the entry came back, the page
     * broke, and the next tailor took the same thing off again. So the fitter
     * runs with what they asked for pinned, and something they did NOT ask
     * about gives — a skills line first, then the oldest unpinned entry.
     *
     * An edit that added nothing is measured and nothing else. Refitting
     * every edit would let a sentence about wording quietly cost an entry,
     * which is the thing the scope rule above exists to prevent.
     */
    const refit = restore
      ? await fitToPages(edited, {
          target,
          cuts: [],
          posting: [posting?.description ?? '', ((posting?.requirements as string[]) ?? []).join(' ')].join(' \n '),
          pinned: alsoPinned(restore.entries.map((e) => pinEntry(e.section, e.name))),
          measure,
          affords: () => affords(deadline, COMPILE_ESTIMATE_MS),
        })
      : null;
    const fitted = refit?.structure ?? edited;
    const pages = refit ? refit.pages : affords(deadline, COMPILE_ESTIMATE_MS) ? await measure(edited) : null;
    /*
     * Over the limit, and nothing taken off to get under it.
     *
     * What they asked to keep wins over the page rule — the same order the
     * fitter now uses for a pin — so this is a sentence rather than a cut.
     */
    const overLong =
      pages !== null && pages > target
        ? [
            `This now runs to ${pages === 1 ? 'one page' : `${pages} pages`} and your rules ask for ` +
              `${target === 1 ? 'one page' : `${target} pages`}. Nothing was taken off to get under it — an edit ` +
              'changes what you asked about and leaves the rest alone. Tailor again to fit it, or say what should go.',
          ]
        : [];

    const requirements = (posting?.requirements as string[]) ?? [];
    const carriedGaps = (current.missingRequirements as string[]) ?? [];
    const gaps = gapsAfterEdit(carriedGaps, fitted, requirements);

    const resumeId = await saveResume(userId, params.id, {
      structure: fitted,
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
        /*
         * What came back, and what gave way for it.
         *
         * There was a sentence here saying the resume was "likely over the
         * page limit again" and that tailoring again would cut it back. True,
         * unhelpful, and the thing it cut back was what they had just asked
         * for. Room is made now instead of promised later, so the log says
         * what actually went.
         */
        ...(restore ? [restoreLine(restore.entries), ...(refit?.log ?? [])] : []),
        ...(move ? [moveLine(move), ORDER_IS_LOCAL] : []),
        // What the edit was held to, and how to ask for it everywhere.
        ...(held.frozen.length ? [frozenLine(held.frozen, scope.named)] : []),
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
      warnings: [
        ...surfaced.warnings,
        ...honest.warnings,
        ...(refit?.warnings ?? []),
        ...overLong,
        ...quiet(asLines(toolInput.warnings)),
      ],
      // Carried, not asked for. The model's guess was wrong every time it was
      // checked — "slightly over 1 page" for a resume that filled two — so the
      // tool no longer requests it. A real measurement replaces this later.
      estimatedPages: current.estimatedPages,
      // And the measurement, now that one is taken: null stays "not measured".
      pageCount: pages,
      // Carried, not recomputed: an edit cuts nothing, and a list that stopped
      // at the version it was made on would be gone by the next question.
      // Plus whatever making room has just taken off, or an entry would go
      // with nothing recording that it went.
      dropped: [...kept.filter((d) => !putBack.has(`${d.section}:${d.index}`)), ...(refit?.dropped ?? [])],
      /*
       * What the sentence said to keep, and anything it asked back.
       *
       * Both are promises about the next fit, and this branch is where most of
       * them arrive: a sentence that asks for something back AND says
       * something else is handled here rather than in the restore-only branch
       * above.
       */
      pins: restore ? alsoPinned([...readPins(instruction, structure), ...restore.entries.map((e) => pinEntry(e.section, e.name))]) : pins,
      mode: 'instructed',
    });

    /*
     * `held` goes back as well as into the log.
     *
     * The log line is the permanent record; this is what lets the screen put
     * "apply to the whole resume" next to the result while the person is still
     * looking at it. The instruction travels with it so the second try does
     * not depend on the box still holding what they typed.
     */
    return NextResponse.json({
      resumeId,
      editsLeft: FREE_EDITS - spent - 1,
      ...(held.frozen.length ? { held: { frozen: held.frozen, instruction } } : {}),
    });
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
