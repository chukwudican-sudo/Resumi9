import type { ReactNode } from 'react';
import { type FeedbackRow } from '../../server/db/repository';
import { KIND_LABELS, isKind } from '../../lib/feedback';
import InboxList, { type FeedbackItem } from './InboxList';

/**
 * Everything anybody has said.
 *
 * Split from the page it is served on, which does the asking-who-you-are and
 * the reading. Not for tidiness: the inbox shipped broken because nothing had
 * ever rendered it with a row in it, and rendering it needs a signed-in admin
 * session that a test cannot have. Given the rows as a prop, it can be
 * rendered by anything — scripts/inbox.render.ts does exactly that, with real
 * rows read back through the real query inside a transaction it rolls back.
 *
 * The bar comes in as a prop for the same reason. On the page it is `AppNav`,
 * which asks the database who you are; in the render script it is the plain
 * `NavBar` that only draws.
 */
export default function Inbox({ rows, nav }: { rows: FeedbackRow[]; nav?: ReactNode }) {
  const unread = rows.filter((row) => !row.seenAt).length;

  return (
    <main className="min-h-screen bg-ground font-sans text-ink">
      {nav}

      <div className="mx-auto max-w-[920px] px-6 py-10">
        <div className="mb-7 flex items-end justify-between gap-4">
          <h1 className="font-serif text-[34px] leading-[1.08] tracking-[-0.01em]">Feedback</h1>
          <span className="pb-1.5 text-[13px] text-ink-muted">
            {rows.length} {rows.length === 1 ? 'message' : 'messages'}
            {unread ? <span className="ml-2 font-medium text-accent">{unread} new</span> : null}
          </span>
        </div>

        {!rows.length ? (
          <p className="rounded-lg border border-rule-soft bg-ground-surface px-5 py-10 text-center text-[14px] leading-relaxed text-ink-prose">
            Nothing yet. The button is on every page, signed in or not, so this fills up from the
            landing page as well as from inside the app.
          </p>
        ) : (
          // The id is a mount point, not decoration: scripts/inbox.render.ts
          // replaces this subtree with a live one so the page can be clicked.
          <div id="list">
            <InboxList items={rows.map(asItem)} />
          </div>
        )}
      </div>
    </main>
  );
}

/**
 * A row flattened for the browser.
 *
 * The relative time is worked out HERE, on the server, and sent as a string.
 * Computing it in the client component would mean calling Date.now() during
 * the server render and again at hydration, and a minute ticking over between
 * the two is a hydration mismatch.
 */
export function asItem(row: FeedbackRow): FeedbackItem {
  return {
    id: row.id,
    kind: row.kind,
    kindLabel: isKind(row.kind) ? KIND_LABELS[row.kind] : row.kind,
    // At most one address exists: a signed-in report is joined to the
    // account's email and never stores a second copy, and a signed-out one
    // has only what they chose to type.
    replyTo: row.accountEmail ?? row.email,
    hasAccount: Boolean(row.accountEmail),
    message: row.message,
    shots: row.shots.map((shot) => ({ id: shot.id, byteSize: shot.byteSize })),
    attempt: row.attempt,
    pageUrl: row.pageUrl,
    applicationId: row.applicationId,
    viewport: row.viewport,
    appVersion: row.appVersion,
    userAgent: row.userAgent,
    seen: Boolean(row.seenAt),
    ago: when(row.createdAt),
    stamp: row.createdAt.toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
  };
}

/** How long ago, then the date once "ago" stops meaning anything useful. */
function when(at: Date): string {
  const minutes = Math.round((Date.now() - at.getTime()) / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`;
  if (minutes < 60 * 24 * 7) return `${Math.round(minutes / (60 * 24))}d`;
  return at.toISOString().slice(5, 10).replace('-', '/');
}
