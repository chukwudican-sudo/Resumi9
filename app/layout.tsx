import './globals.css';
import type { Metadata } from 'next';
import { IBM_Plex_Sans, Instrument_Serif } from 'next/font/google';
import { ClerkProvider } from '@clerk/nextjs';
import { currentUserId, syncCurrentUser } from './server/auth';
import UndoProvider from './components/undo/UndoProvider';
import ConfirmProvider from './components/undo/ConfirmProvider';
import FeedbackButton from './components/FeedbackButton';

/**
 * The two faces the design uses. Loaded through next/font so they are
 * self-hosted and carry no render-blocking request to Google.
 */
const sans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-sans',
  display: 'swap',
});

const serif = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  style: ['normal', 'italic'],
  variable: '--font-serif',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Resumi9',
  description: 'A resume that changes for every job you apply to.',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Makes sure a signed-in person exists in the database before any page tries
  // to write something owned by them. Costs one primary-key lookup on a normal
  // request; only a brand-new account pays for anything more. See syncCurrentUser.
  //
  // Guarded, because this is the root layout: an unhandled throw here fails
  // every page at once and takes app/error.tsx down with it, since that renders
  // inside this. When the connection pool was exhausted the whole site went
  // dark rather than showing anyone an error. The pages below already cope with
  // a missing user row, so a failure here should cost the sync, not the site.
  try {
    await syncCurrentUser();
  } catch (error) {
    // Next signals "this route is dynamic" by throwing, so that one has to keep
    // travelling or a page that reads headers gets rendered statically and
    // serves one person's data to the next.
    if ((error as { digest?: string })?.digest === 'DYNAMIC_SERVER_USAGE') throw error;
    console.error('[Resumi9] Could not sync the signed-in user; rendering anyway.', error);
  }

  /*
   * Whether to ask for an email in the feedback panel, and nothing else. A
   * signed-in account already has one; a stranger on the landing page does
   * not, and is exactly the person worth hearing from.
   */
  let signedIn = false;
  try {
    signedIn = Boolean(await currentUserId());
  } catch (error) {
    if ((error as { digest?: string })?.digest === 'DYNAMIC_SERVER_USAGE') throw error;
  }

  return (
    <ClerkProvider>
      <html lang="en" className={`${sans.variable} ${serif.variable}`}>
        <body>
          {/*
            Inside <body> and around everything, so the toast is reachable from
            every page and survives the router.refresh() each save triggers —
            that refresh re-renders the tree below, and an offer held by a page
            component would go with it, taking the undo away half a second
            after it appeared.
          */}
          <UndoProvider>
            <ConfirmProvider>{children}</ConfirmProvider>
          </UndoProvider>
          {/*
            Here rather than in AppNav, so it is also on the landing page, the
            sign-in pages and the 404 — every screen somebody can be standing
            on when something goes wrong.
          */}
          <FeedbackButton signedIn={signedIn} />
        </body>
      </html>
    </ClerkProvider>
  );
}
