import { notFound } from 'next/navigation';
import { currentUserId } from '../../server/auth';
import { isAdmin } from '../../server/feedback';
import { getUser, listFeedbackAcrossUsers } from '../../server/db/repository';
import AppNav from '../../components/AppNav';
import Inbox from './Inbox';

export const dynamic = 'force-dynamic';

/**
 * Who is asking, and what there is to read. The rendering is in Inbox.
 *
 * **A 404 to everybody else**, including a signed-in stranger who guesses the
 * path. Not a 403: this address either exists for you or it does not, and a
 * 403 tells somebody there is something here worth coming back for.
 *
 * It carries the app's own bar rather than a lone wordmark. This is a page
 * you arrive at from the avatar menu and leave for somewhere else, and a
 * header with nothing in it makes it feel like a different site.
 */
export default async function FeedbackInboxPage() {
  const userId = await currentUserId();
  if (!(await isAdmin(userId))) notFound();

  const [rows, user] = await Promise.all([
    listFeedbackAcrossUsers(200),
    userId ? getUser(userId) : null,
  ]);

  // `active="account"` highlights nothing, which is right: this is not one of
  // the four destinations, it is somewhere you were sent from the menu.
  return <Inbox rows={rows} nav={<AppNav active="account" credits={user?.credits} />} />;
}
