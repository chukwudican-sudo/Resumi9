'use client';

import { useEffect, useState } from 'react';
import { UserButton } from '@clerk/nextjs';

/**
 * The avatar, and what is under it.
 *
 * Your profile lives here because that is where account things are on every
 * other site. It is not a fifth nav item — it is not a fifth destination, it
 * is where you go to look at yourself.
 *
 * Before this, nothing in the app linked to /profile at all. The single
 * navigation to it was the interview redirecting there on completion, and the
 * interview could only be started from the profile page — so the page you
 * delete your data from sat behind a door that opened only from the inside.
 * The privacy policy and the terms both point people at that button, which
 * made them wrong about the product, not just inconvenient.
 *
 * A client component on purpose. UserButton.MenuItems identifies its children
 * by component type at render, and rather than establish whether that survives
 * the server/client boundary, this puts the whole thing on the side of the
 * boundary where Clerk's API is unambiguously supported.
 *
 * Held back until the browser has it, which is the price of those menu items.
 * Clerk renders them through a portal that exists only on the client, so the
 * server sent one shape and the first client render produced another, and React
 * called it a hydration mismatch on every page with a nav — an overlay in
 * development, a silent re-render in production. Both sides now agree on the
 * placeholder and the real thing arrives a tick later, which is invisible next
 * to the avatar image loading anyway.
 */
export default function UserMenu({ admin = false }: { admin?: boolean }) {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);

  // The same 28px the avatar occupies, so the bar does not shift when it lands.
  if (!ready) {
    return <span aria-hidden="true" className="block h-7 w-7 rounded-full bg-ground-panel" />;
  }

  return (
    <UserButton appearance={{ elements: { avatarBox: 'h-7 w-7' } }} afterSignOutUrl="/">
      {/*
        Listed explicitly so the order is ours: your profile first, then
        Clerk's account — which is about signing in, not about the resume —
        then sign out.
      */}
      <UserButton.MenuItems>
        <UserButton.Link label="Account" href="/account" labelIcon={<AccountIcon />} />
        {/*
          Only for the accounts that can open it. Not a security control —
          /admin/feedback answers 404 to everybody else whether or not they
          were shown a link — but the page holds other people's words, and
          offering a door to somebody who will be told it does not exist is
          its own kind of wrong.
        */}
        {admin ? <UserButton.Link label="Inbox" href="/admin/feedback" labelIcon={<InboxIcon />} /> : null}
        <UserButton.Action label="manageAccount" />
        <UserButton.Action label="signOut" />
      </UserButton.MenuItems>
    </UserButton>
  );
}

/** The same speech mark the feedback button carries, so they read as one thing. */
function InboxIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.9 9.9 0 0 1-4.1-.9L3 21l1.9-4.3A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4Z" />
    </svg>
  );
}

/** Sized to sit with Clerk's own menu icons rather than shout over them. */
function AccountIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}
