'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { markEverythingSeen, setFeedbackSeen } from '../../server/actions';
import { useEscape } from '../../components/useEscape';
import Lightbox from './Lightbox';

/**
 * One report, flattened for the browser.
 *
 * The relative time is computed on the SERVER and sent as a string. Working
 * it out here would mean calling Date.now() during the server render and
 * again at hydration, and a minute ticking over between the two is a
 * hydration mismatch — the kind that shows as a React error in development
 * and silently re-renders in production.
 */
export interface FeedbackItem {
  id: string;
  kind: string;
  kindLabel: string;
  replyTo: string | null;
  hasAccount: boolean;
  message: string;
  shots: { id: string; byteSize: number }[];
  attempt: { stage: string; fault: string | null; reason: string | null; refunded: boolean; ok: boolean | null } | null;
  pageUrl: string | null;
  applicationId: string | null;
  viewport: string | null;
  appVersion: string | null;
  userAgent: string | null;
  seen: boolean;
  ago: string;
  stamp: string;
}

type Filter = 'all' | 'new' | string;

/**
 * The inbox, as a list you open one thing at a time.
 *
 * It used to render every report expanded, which at three was untidy and at
 * thirty is unusable — you cannot see what is there without scrolling past
 * everything that is. So: a line per report, and the one you are reading
 * opens in place. The list stays around it rather than being replaced, which
 * is what makes it possible to read four in a row without losing where you
 * are.
 *
 * The unread treatment is borrowed openly from mail clients, because the
 * convention is forty years old and nobody has to be taught it: unread sits
 * on white and is set in a heavier weight, read drops back to the page's own
 * ground and goes grey. A count, not a badge. Opening something marks it
 * read, and "Mark unread" puts it back — the one gesture people reach for
 * when they open a thing they are not ready to deal with.
 */
export default function InboxList({ items }: { items: FeedbackItem[] }) {
  // Seen state is held here as well as on the row, so the list responds to a
  // click immediately rather than after a round trip to the server and a
  // re-render of the page.
  const [seen, setSeen] = useState<Record<string, boolean>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [zoom, setZoom] = useState<{ src: string; caption: string; from: HTMLElement | null } | null>(null);
  const [, start] = useTransition();

  const isSeen = (item: FeedbackItem) => seen[item.id] ?? item.seen;
  const unread = items.filter((item) => !isSeen(item)).length;

  useEscape(Boolean(openId) && !zoom, () => setOpenId(null));

  function mark(item: FeedbackItem, next: boolean) {
    setSeen((was) => ({ ...was, [item.id]: next }));
    start(() => void setFeedbackSeen(item.id, next));
  }

  function open(item: FeedbackItem) {
    if (openId === item.id) {
      setOpenId(null);
      return;
    }
    setOpenId(item.id);
    // Opening is reading. The same thing every mail client does, and the
    // reason "Mark unread" exists inside the opened message.
    if (!isSeen(item)) mark(item, true);
  }

  const kinds = [...new Set(items.map((item) => item.kind))];
  const shown = items.filter((item) => {
    if (filter === 'all') return true;
    if (filter === 'new') return !isSeen(item);
    return item.kind === filter;
  });

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip active={filter === 'all'} onClick={() => setFilter('all')}>
            All <Count n={items.length} />
          </Chip>
          <Chip active={filter === 'new'} onClick={() => setFilter('new')}>
            New <Count n={unread} />
          </Chip>
          {kinds.map((kind) => (
            <Chip key={kind} active={filter === kind} onClick={() => setFilter(kind)}>
              {items.find((item) => item.kind === kind)?.kindLabel ?? kind}{' '}
              <Count n={items.filter((item) => item.kind === kind).length} />
            </Chip>
          ))}
        </div>

        {unread ? (
          <button
            type="button"
            onClick={() => {
              setSeen(Object.fromEntries(items.map((item) => [item.id, true])));
              start(() => void markEverythingSeen());
            }}
            className="text-[12.5px] text-ink-muted underline decoration-rule-field underline-offset-4 transition hover:text-ink"
          >
            Mark all seen
          </button>
        ) : null}
      </div>

      {!shown.length ? (
        <p className="rounded-lg border border-rule-soft bg-ground-surface px-5 py-8 text-center text-[13.5px] text-ink-muted">
          Nothing here.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-rule bg-ground-surface">
          {shown.map((item, index) => (
            <Row
              key={item.id}
              item={item}
              seen={isSeen(item)}
              open={openId === item.id}
              first={index === 0}
              onOpen={() => open(item)}
              onMark={(next) => mark(item, next)}
              onZoom={(src, caption, from) => setZoom({ src, caption, from })}
            />
          ))}
        </div>
      )}

      {zoom ? (
        <Lightbox
          src={zoom.src}
          caption={zoom.caption}
          returnFocusTo={zoom.from}
          onClose={() => setZoom(null)}
        />
      ) : null}
    </>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full border px-3 py-1 text-[12.5px] transition ${
        active ? 'border-accent-line bg-accent-wash text-accent' : 'border-rule-field text-ink-muted hover:text-ink'
      }`}
    >
      {children}
    </button>
  );
}

const Count = ({ n }: { n: number }) => <span className="tabular-nums opacity-60">{n}</span>;

function Row({
  item,
  seen,
  open,
  first,
  onOpen,
  onMark,
  onZoom,
}: {
  item: FeedbackItem;
  seen: boolean;
  open: boolean;
  first: boolean;
  onOpen: () => void;
  onMark: (next: boolean) => void;
  onZoom: (src: string, caption: string, from: HTMLElement | null) => void;
}) {
  const body = useRef<HTMLDivElement>(null);

  // A report scrolled half off the top when it opens is a report nobody reads
  // the start of.
  useEffect(() => {
    if (open) body.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [open]);

  return (
    <div ref={body} className={first ? '' : 'border-t border-rule-soft'}>
      <div className={`group relative flex items-center ${seen && !open ? 'bg-ground-panel' : 'bg-ground-surface'}`}>
        <button
          type="button"
          onClick={onOpen}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-3 py-3 pl-4 pr-2 text-left"
        >
          <span
            aria-hidden="true"
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${seen ? 'bg-transparent' : 'bg-accent'}`}
          />
          {/* A fixed-width column, so the senders and previews line up down
              the list however long the label is. A list whose columns move
              row to row cannot be read by skimming, which is the only way
              anybody reads a list. */}
          <span className="hidden w-[132px] shrink-0 sm:block">
            <span
              className={`rounded-full px-2.5 py-0.5 text-[11.5px] ${
                seen ? 'bg-ground-panel text-ink-faint' : 'bg-accent-wash text-accent'
              }`}
            >
              {item.kindLabel}
            </span>
          </span>
          <span
            className={`hidden w-[190px] shrink-0 truncate text-[13px] lg:block ${
              seen ? 'text-ink-muted' : 'font-medium text-ink'
            }`}
          >
            {item.replyTo ?? 'signed out'}
          </span>
          {/* The preview is the collapsed row's whole content, and the open
              row has the message in full six lines below — so it goes, and
              what is left reads as a heading for what is underneath. */}
          {open ? (
            <span className="min-w-0 flex-1" />
          ) : (
            <span className={`min-w-0 flex-1 truncate text-[13.5px] ${seen ? 'text-ink-muted' : 'text-ink'}`}>
              <span className={seen ? '' : 'font-medium'}>{item.message}</span>
            </span>
          )}
        </button>

        <span className="flex shrink-0 items-center gap-2 pr-4">
          {item.attempt && item.attempt.ok !== true ? (
            <span title={`Their last attempt failed at ${item.attempt.stage}`} className="text-flag">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
                <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
              </svg>
            </span>
          ) : null}
          {item.shots.length ? (
            <span className="flex items-center gap-0.5 text-[11.5px] text-ink-faint" title={`${item.shots.length} screenshot(s)`}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21.4 11.1 12.3 20.2a5 5 0 0 1-7.1-7.1l9.2-9.2a3.3 3.3 0 0 1 4.7 4.7l-9.2 9.2a1.7 1.7 0 0 1-2.3-2.3l8.5-8.5" />
              </svg>
              {item.shots.length > 1 ? item.shots.length : null}
            </span>
          ) : null}

          {/* The time, and the one action that replaces it on hover — the
              gesture for a thing you have dealt with, or have not. */}
          <span
            title={item.stamp}
            className={`w-[62px] text-right text-[11.5px] tabular-nums group-hover:invisible ${
              seen ? 'text-ink-faint' : 'font-medium text-ink-muted'
            }`}
          >
            {item.ago}
          </span>
          <button
            type="button"
            onClick={() => onMark(!seen)}
            className="invisible absolute right-4 rounded border border-rule-field bg-ground-surface px-2 py-0.5 text-[11.5px] text-ink-muted transition hover:text-ink group-hover:visible"
          >
            {seen ? 'Unread' : 'Mark seen'}
          </button>
        </span>
      </div>

      {open ? <Body item={item} seen={seen} onMark={onMark} onZoom={onZoom} /> : null}
    </div>
  );
}

function Body({
  item,
  seen,
  onMark,
  onZoom,
}: {
  item: FeedbackItem;
  seen: boolean;
  onMark: (next: boolean) => void;
  onZoom: (src: string, caption: string, from: HTMLElement | null) => void;
}) {
  return (
    <div className="border-t border-rule-soft bg-ground-surface px-4 pb-5 pt-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12.5px]">
        {item.replyTo ? (
          <a
            href={`mailto:${item.replyTo}?subject=${encodeURIComponent(`Resumi9 — your feedback (${item.id})`)}`}
            className="text-accent underline decoration-accent-line underline-offset-4 transition hover:decoration-accent"
          >
            Reply to {item.replyTo}
          </a>
        ) : (
          <span className="text-ink-faint">Signed out, left no address — no way to reply</span>
        )}
        {!item.hasAccount && item.replyTo ? <span className="text-[11.5px] text-ink-faint">no account</span> : null}
        <span className="text-ink-faint">{item.stamp}</span>
      </div>

      {/* Their words, exactly as typed — newlines included. */}
      <p className="mt-3 whitespace-pre-wrap text-[14px] leading-relaxed text-ink">{item.message}</p>

      {item.shots.length ? (
        <div className="mt-4 flex flex-wrap gap-2.5">
          {item.shots.map((shot) => (
            <button
              key={shot.id}
              type="button"
              onClick={(event) =>
                onZoom(`/api/feedback/shot/${shot.id}`, `Screenshot from ${item.replyTo ?? 'a signed-out visitor'}`, event.currentTarget)
              }
              className="block cursor-zoom-in rounded border border-rule-field bg-ground p-0 transition hover:border-accent-line"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/feedback/shot/${shot.id}`}
                alt={`Screenshot attached to ${item.id}`}
                className="h-auto max-h-[220px] max-w-full rounded-[3px] object-contain"
              />
            </button>
          ))}
        </div>
      ) : null}

      {item.attempt ? (
        <div
          className={`mt-4 rounded border px-3 py-2 text-[12.5px] leading-relaxed ${
            item.attempt.ok === true
              ? 'border-rule bg-ground-panel text-ink-prose'
              : 'border-flag-line bg-flag-bg text-flag-ink'
          }`}
        >
          <span className="font-medium">Their last attempt:</span> {item.attempt.stage}
          {item.attempt.fault ? ` · ${item.attempt.fault}` : ''}
          {item.attempt.ok === false ? ' · failed' : item.attempt.ok === null ? ' · never finished' : ' · finished ok'}
          {item.attempt.refunded ? ' · refunded' : ''}
          {item.attempt.reason ? <span className="block text-ink-muted">{item.attempt.reason}</span> : null}
        </div>
      ) : null}

      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[11.5px] text-ink-faint">
        <Detail label="page" value={item.pageUrl} />
        <Detail label="application" value={item.applicationId} />
        <Detail label="window" value={item.viewport} />
        <Detail label="build" value={item.appVersion} />
        <Detail label="browser" value={item.userAgent} />
        <Detail label="reference" value={item.id} />
      </dl>

      <div className="mt-4 flex items-center gap-4">
        <button
          type="button"
          onClick={() => onMark(!seen)}
          className="rounded border border-rule-field px-2.5 py-1 text-[12px] text-ink-muted transition hover:text-ink"
        >
          {seen ? 'Mark unread' : 'Mark seen'}
        </button>
        {item.applicationId ? (
          <a
            href={`/applications/${item.applicationId}`}
            className="text-[12px] text-ink-muted underline decoration-rule-field underline-offset-4 transition hover:text-ink"
          >
            Open their application
          </a>
        ) : null}
      </div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <>
      <dt className="uppercase tracking-[0.08em]">{label}</dt>
      <dd className="break-all text-ink-muted">{value}</dd>
    </>
  );
}
