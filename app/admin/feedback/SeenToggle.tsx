'use client';

import { useTransition } from 'react';
import { setFeedbackSeen } from '../../server/actions';

/**
 * Read, or back to the inbox.
 *
 * One state and one toggle, because tonight's question is only "have I looked
 * at this yet". Statuses, replies and threads are what this grows into if it
 * is used; adding them before anybody has sent anything would be furniture.
 */
export default function SeenToggle({ id, seen }: { id: string; seen: boolean }) {
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => start(() => void setFeedbackSeen(id, !seen))}
      className={`shrink-0 rounded border px-2.5 py-1 text-[12px] transition disabled:opacity-50 ${
        seen
          ? 'border-rule-field text-ink-faint hover:text-ink'
          : 'border-accent-line bg-accent-wash text-accent hover:bg-accent-tint'
      }`}
    >
      {pending ? '…' : seen ? 'Seen' : 'Mark seen'}
    </button>
  );
}
