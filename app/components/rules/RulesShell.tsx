'use client';

import { useState, useTransition } from 'react';
import {
  addRule,
  editRule,
  removeRule,
  reorderRules,
  restoreRule,
  toggleRule,
} from '../../server/actions';
import { useUndo } from '../undo/UndoProvider';
import { useConfirm } from '../undo/ConfirmProvider';
import { useEscape } from '../useEscape';
import { RULE_MAX_LENGTH, describeCheck, type RuleCheck } from '../../lib/rules';
import { deriveRuleCheck } from '../../server/actions';
import Spinner from '../Spinner';

export interface Rule {
  id: string;
  text: string;
  active: boolean;
  source: string;
  /** The app's reading of the rule. Null means guidance — most rules. */
  check: RuleCheck | null;
}

/**
 * Examples, not templates.
 *
 * Someone landing on an empty page with a text box has to invent both the
 * content and the genre at once. These are phrased the way a real rule is —
 * specific, and about this person's judgement rather than generic advice — so
 * the first one they write is theirs rather than a paraphrase of ours.
 */
const EXAMPLES = [
  'Never use the word "spearheaded".',
  'Keep every bullet to one line — two at the absolute most.',
  'Call it Ontario Tech, never UOIT.',
  'Lead with impact, then the technology, never the other way round.',
  'Do not put my GPA on anything.',
];

export default function RulesShell({ initialRules }: { initialRules: Rule[] }) {
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');
  const [pending, startTransition] = useTransition();
  const { offer, dismiss } = useUndo();
  const ask = useConfirm();

  const rules = initialRules;
  const activeCount = rules.filter((r) => r.active).length;

  /**
   * Rules whose reading is still being worked out, and any contradiction found.
   *
   * Both are local and transient on purpose. The reading lands in the database
   * and comes back as a prop; the conflict does not — a stored contradiction
   * goes stale the moment either rule is edited, and a stale one is worse than
   * none. It is shown at the moment it can be acted on.
   */
  const [reading, setReading] = useState<Set<string>>(new Set());
  /**
   * A rule that has been written but has not come back from the server yet.
   *
   * The textarea empties the instant you press Add, and the row does not arrive
   * until the write and the re-render have both landed — so the words went
   * somewhere and nothing said where. Showing them straight away also makes the
   * whole sequence one motion: the row appears, then works out how to check
   * itself, then says what it will check. Before this it was blank, pop,
   * checking.
   *
   * Plain state rather than useOptimistic, which is React 19 — this app is on
   * 18.3, and which canary Next resolved is not a thing to bet a feature on.
   */
  const [adding, setAdding] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ ruleId: string; index: number; text: string; reason: string } | null>(null);

  function derive(ruleId: string) {
    setReading((s) => new Set(s).add(ruleId));
    void deriveRuleCheck(ruleId)
      .then((result) => {
        if (result.conflict) setConflict({ ruleId, ...result.conflict });
      })
      .finally(() => setReading((s) => {
        const next = new Set(s);
        next.delete(ruleId);
        return next;
      }));
  }

  /**
   * Leaving a rule mid-edit, from the button or from Escape.
   *
   * It used to discard silently while the entry editor two screens over asked
   * first — the same gesture, on the same kind of half-written text, answered
   * two ways. A rule is one sentence somebody worked out the wording of, which
   * is exactly the sort of thing that is annoying to lose and quick to lose.
   */
  async function cancelEdit() {
    const before = rules.find((r) => r.id === editingId)?.text ?? '';
    if (editingText.trim() !== before.trim()) {
      const ok = await ask({
        title: 'Discard this edit?',
        body: 'Your changes to this rule have not been saved.',
        action: 'Discard',
      });
      if (!ok) return;
    }
    setEditingId(null);
  }

  useEscape(editingId !== null, () => void cancelEdit());

  function submit() {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    setAdding(text);
    startTransition(async () => {
      const id = await addRule(text);
      // Cleared once the real row exists. A failed write takes the ghost with
      // it rather than leaving a rule on screen that was never saved.
      setAdding(null);
      if (!id) return;
      offer({ message: 'Rule added.', undo: () => removeRule(id) });
      // After the rule exists, never before. The row is already on screen; the
      // reading fills in a moment later, and an outage costs the check rather
      // than the rule.
      setConflict(null);
      derive(id);
    });
  }

  function move(index: number, direction: -1 | 1) {
    const next = [...rules];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    // The swap. It was missing — this copied the array, checked the bounds, and
    // posted the UNCHANGED order, so Move up and Move down have never done
    // anything since the day they were written.
    [next[index], next[target]] = [next[target], next[index]];
    // Reordering offers nothing — moving it back is the undo — but it still has
    // to take away an offer standing from the last change. An offer that
    // outlives the change it belongs to reverts the wrong step.
    dismiss();
    startTransition(() => reorderRules(next.map((r) => r.id)));
  }

  return (
    <div className="mx-auto max-w-[680px] px-6 py-12 sm:px-10">
      <h1 className="font-serif text-[36px] leading-tight">Your rules</h1>
      <p className="mt-3 text-[15px] leading-relaxed text-ink-prose">
        Things you want applied to every resume you make. Write them the way you&rsquo;d say them
        to someone editing your resume &mdash; they are read in order, and they outrank
        anything the job posting suggests.
      </p>

      {/* composer */}
      <div className="mt-8">
        <textarea
          rows={2}
          value={draft}
          maxLength={RULE_MAX_LENGTH}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter submits; Shift+Enter is a newline. A rule is one sentence,
            // so reaching for a button every time would be the wrong default.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Never use the word &quot;spearheaded&quot;."
          className="[field-sizing:content] max-h-[10lh] w-full resize-none rounded border border-rule-field bg-ground-surface px-4 py-3.5 text-[15px] leading-relaxed outline-none transition placeholder:text-ink-ghost focus:border-accent"
        />
        <div className="mt-2.5 flex items-center justify-between">
          <span className="text-[12.5px] text-ink-faint">
            {draft.length > RULE_MAX_LENGTH - 40
              ? `${RULE_MAX_LENGTH - draft.length} characters left`
              : 'Enter to add'}
          </span>
          <button
            type="button"
            onClick={submit}
            disabled={pending || !draft.trim()}
            className="rounded bg-accent px-5 py-2.5 text-[13px] font-medium text-ground transition hover:bg-accent-hover disabled:pointer-events-none disabled:bg-rule-field disabled:text-ink-ghost"
          >
            {adding ? 'Adding…' : 'Add rule'}
          </button>
        </div>
      </div>

      {/* the rules */}
      {/*
        `|| adding` so the very first rule has somewhere to land. Without it the
        examples block is still on screen while the first rule is being written,
        and the ghost row is missing at exactly the moment it matters most.
      */}
      {rules.length > 0 || adding ? (
        <>
          <div className="mt-10 flex items-baseline justify-between">
            <span className="text-[11px] uppercase tracking-[0.12em] text-ink-faint">
              In priority order
            </span>
            <span className="text-[12.5px] text-ink-muted">
              {activeCount} of {rules.length} on
            </span>
          </div>
          {/* Said out loud, because it is now true. The order was always stored
              and always shown; until this week nothing told the model to read
              the numbers as rank. */}
          <div className="mt-1.5">
            <span className="text-[12px] text-ink-faint">
              Where two rules cannot both be met, the higher one wins.
            </span>
          </div>

          <ul className="mt-3 flex flex-col gap-2">
            {rules.map((rule, index) => (
              <li
                key={rule.id}
                className={`rounded-md border bg-ground-surface p-4 transition ${
                  rule.active ? 'border-rule' : 'border-dashed border-rule-field'
                }`}
              >
                {editingId === rule.id ? (
                  <div>
                    <textarea
                      rows={2}
                      autoFocus
                      value={editingText}
                      maxLength={RULE_MAX_LENGTH}
                      onChange={(e) => setEditingText(e.target.value)}
                      className="[field-sizing:content] max-h-[10lh] w-full resize-none rounded border border-accent bg-ground px-3.5 py-2.5 text-[14.5px] leading-relaxed outline-none"
                    />
                    <div className="mt-2.5 flex justify-end gap-3">
                      <button
                        type="button"
                        onClick={() => void cancelEdit()}
                        className="text-[13px] text-ink-muted transition hover:text-ink"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          const text = editingText;
                          const before = rule.text;
                          setEditingId(null);
                          startTransition(async () => {
                            await editRule(rule.id, text);
                            offer({
                              message: 'Rule updated.',
                              undo: () => editRule(rule.id, before),
                            });
                            // The old reading described the sentence that was
                            // just replaced, and editRule cleared it.
                            setConflict(null);
                            derive(rule.id);
                          });
                        }}
                        disabled={!editingText.trim()}
                        className="rounded bg-accent px-4 py-1.5 text-[13px] font-medium text-ground transition hover:bg-accent-hover disabled:opacity-50"
                      >
                        Save
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start gap-3">
                    <span className="w-4 shrink-0 pt-[3px] text-right text-[12px] tabular-nums text-ink-ghost">
                      {index + 1}
                    </span>

                    <div className="flex-grow">
                      <p
                        className={`text-[14.5px] leading-relaxed ${
                          rule.active ? 'text-ink' : 'text-ink-ghost line-through decoration-1'
                        }`}
                      >
                        {rule.text}
                      </p>

                      {/*
                        What the app believes this rule means, standing under it.
                        
                        Not a confirmation step — a permanent statement, so a
                        wrong reading is visible rather than mysterious. Without
                        it, a rule quietly checked for the wrong word reports
                        failures on a resume nothing looks wrong with.
                        
                        And a rule with no check says so, so guidance never
                        passes for enforcement.
                      */}
                      {reading.has(rule.id) ? (
                        <span className="mt-1.5 flex items-center gap-2 text-[12px] text-ink-faint">
                          <Spinner /> Working out how to check this…
                        </span>
                      ) : rule.check ? (
                        <span className="mt-1.5 flex items-start gap-1.5 text-[12px] leading-snug text-accent">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" className="mt-[3px] shrink-0" aria-hidden="true">
                            <path d="M20 6L9 17l-5-5" />
                          </svg>
                          {describeCheck(rule.check)}
                        </span>
                      ) : (
                        <span className="mt-1.5 block text-[12px] leading-snug text-ink-faint">
                          Guidance &mdash; this one shapes every resume, but nothing can check it
                          afterwards.
                        </span>
                      )}

                      {/* Shown while it can be acted on, then gone. */}
                      {conflict?.ruleId === rule.id ? (
                        <span className="mt-2 block rounded-md border border-flag-line bg-flag-bg px-3 py-2 text-[12px] leading-relaxed text-flag-ink">
                          This may contradict rule {conflict.index}, &ldquo;{conflict.text}&rdquo;
                          &mdash; {conflict.reason}
                        </span>
                      ) : null}
                    </div>

                    <div className="flex shrink-0 items-center gap-1">
                      <IconButton
                        label="Move up"
                        disabled={index === 0 || pending}
                        onClick={() => move(index, -1)}
                      >
                        <path d="M18 15l-6-6-6 6" />
                      </IconButton>
                      <IconButton
                        label="Move down"
                        disabled={index === rules.length - 1 || pending}
                        onClick={() => move(index, 1)}
                      >
                        <path d="M6 9l6 6 6-6" />
                      </IconButton>
                    </div>
                  </div>
                )}

                {editingId !== rule.id ? (
                  <div className="mt-2.5 flex items-center justify-between border-t border-rule pt-2.5 pl-7">
                    <button
                      type="button"
                      onClick={() => {
                        // On and off is its own undo. The offer still goes.
                        dismiss();
                        startTransition(() => toggleRule(rule.id, !rule.active));
                      }}
                      // It had no disabled state at all, so the pill sat in its
                      // old position — fully clickable — for the whole round
                      // trip, and double-pressing was trivial.
                      disabled={pending}
                      className="flex items-center gap-2 text-[12.5px] text-ink-muted transition hover:text-ink disabled:pointer-events-none disabled:opacity-50"
                    >
                      <span
                        className={`flex h-[15px] w-[26px] items-center rounded-full px-[2px] transition ${
                          rule.active ? 'justify-end bg-accent' : 'justify-start bg-rule-field'
                        }`}
                      >
                        <span className="h-[11px] w-[11px] rounded-full bg-ground-surface" />
                      </span>
                      {rule.active ? 'On' : 'Off'}
                    </button>

                    <div className="flex items-center gap-4">
                      <button
                        type="button"
                        onClick={() => {
                          setEditingId(rule.id);
                          setEditingText(rule.text);
                        }}
                        className="text-[12.5px] text-accent transition hover:text-accent-hover"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          // Quoted back, because a rule is a sentence somebody
                          // wrote and the list can be long — "delete a rule?"
                          // would not tell you WHICH one you were about to lose.
                          const confirmed = await ask({
                            title: 'Delete this rule?',
                            body:
                              rule.text.length > 120
                                ? `“${rule.text.slice(0, 117)}…”`
                                : `“${rule.text}”`,
                            action: 'Delete',
                          });
                          if (!confirmed) return;
                          startTransition(async () => {
                            const removed = await removeRule(rule.id);
                            if (removed) {
                              offer({
                                message: 'Rule deleted.',
                                undo: () => restoreRule(removed),
                              });
                            }
                          });
                        }}
                        disabled={pending}
                        className="text-[12.5px] text-ink-faint transition hover:text-flag disabled:opacity-50"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ) : null}
              </li>
            ))}

            {/*
              The rule you just wrote, before the server has said so.
              
              Same shape as a real row so nothing shifts when it becomes one —
              a ghost that resized on arrival would be worse than the blank it
              replaces.
            */}
            {adding ? (
              <li className="rounded-md border border-dashed border-rule-field bg-ground-surface p-4">
                <div className="flex items-start gap-3">
                  <span className="w-4 shrink-0 pt-[3px] text-right text-[12px] tabular-nums text-ink-ghost">
                    {rules.length + 1}
                  </span>
                  <div className="flex-grow">
                    <p className="text-[14.5px] leading-relaxed text-ink-muted">{adding}</p>
                    <span className="mt-1.5 flex items-center gap-2 text-[12px] text-ink-faint">
                      <Spinner /> Adding…
                    </span>
                  </div>
                </div>
              </li>
            ) : null}
          </ul>
        </>
      ) : (
        <div className="mt-10">
          <span className="text-[11px] uppercase tracking-[0.12em] text-ink-faint">
            For example
          </span>
          <ul className="mt-3 flex flex-col gap-2">
            {EXAMPLES.map((example) => (
              <li key={example}>
                <button
                  type="button"
                  onClick={() => setDraft(example)}
                  className="w-full rounded-md border border-dashed border-rule-field px-4 py-3 text-left text-[14px] text-ink-muted transition hover:border-accent hover:text-ink"
                >
                  {example}
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-[13px] leading-relaxed text-ink-faint">
            Tap one to put it in the box, then change it to something true of you.
          </p>
        </div>
      )}
    </div>
  );
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="rounded p-1 text-ink-ghost transition hover:bg-ground-panel hover:text-ink-prose disabled:pointer-events-none disabled:opacity-25"
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </button>
  );
}
