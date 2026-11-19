import { notFound } from 'next/navigation';
import { currentUserId } from '../../server/auth';
import { isAdmin } from '../../server/feedback';
import { listFeedbackAcrossUsers } from '../../server/db/repository';
import Inbox from './Inbox';

export const dynamic = 'force-dynamic';

/**
 * Who is asking, and what there is to read. The rendering is in Inbox.
 *
 * **A 404 to everybody else**, including a signed-in stranger who guesses the
 * path. Not a 403: this address either exists for you or it does not, and a
 * 403 tells somebody there is something here worth coming back for.
 */
export default async function FeedbackInboxPage() {
  if (!(await isAdmin(await currentUserId()))) notFound();
  return <Inbox rows={await listFeedbackAcrossUsers(200)} />;
}
