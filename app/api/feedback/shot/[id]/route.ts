import { NextRequest, NextResponse } from 'next/server';
import { currentUserId } from '../../../../server/auth';
import { isAdmin } from '../../../../server/feedback';
import { getFeedbackShotAcrossUsers } from '../../../../server/db/repository';

/**
 * One screenshot, to whoever may read the inbox.
 *
 * The private half of "screenshots are private": the bytes live in a table no
 * client role can reach, and the only way out of the database is through this
 * handler, which asks who is calling first. There is no signed URL to leak and
 * no bucket to misconfigure, because there is no second system.
 *
 * A caller who is not an admin is told the image does not exist rather than
 * that they may not have it — this path is `/shot/<id>`, and a 403 would
 * confirm which ids are real.
 */
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  if (!(await isAdmin(await currentUserId()))) {
    return new NextResponse('Not found', { status: 404 });
  }

  const shot = await getFeedbackShotAcrossUsers(params.id);
  if (!shot) return new NextResponse('Not found', { status: 404 });

  return new NextResponse(new Uint8Array(shot.bytes), {
    headers: {
      'Content-Type': shot.contentType,
      'Content-Length': String(shot.bytes.byteLength),
      // Immutable — an id names one set of bytes forever — but private, so no
      // shared cache between here and the browser ever holds somebody's
      // screenshot.
      'Cache-Control': 'private, max-age=31536000, immutable',
      // Belt and braces for a route that serves bytes somebody else uploaded.
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
