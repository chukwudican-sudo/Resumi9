import NavTabs, { type NavKey } from './NavTabs';
import UserMenu from './UserMenu';
import { creditsLabel } from '../lib/credits';
import { currentUserId } from '../server/auth';
import { isAdmin } from '../server/feedback';

export type { NavKey } from './NavTabs';

/**
 * The bar across every signed-in page, drawn.
 *
 * Split from the component that fetches, for the same reason the inbox was:
 * a bar that does IO can only be rendered by something that can do IO, and
 * the one screen nobody had ever rendered outside a browser was the one that
 * shipped broken. This takes what it draws.
 */
export function NavBar({
  active,
  credits,
  admin = false,
}: {
  active: NavKey;
  credits?: number;
  admin?: boolean;
}) {
  return (
    <header className="flex h-[62px] items-center justify-between border-b border-rule bg-ground-surface px-9">
      <NavTabs active={active} />

      <div className="flex items-center gap-4">
        {typeof credits === 'number' ? (
          // Louder as it runs out. A count that looks the same at five and at
          // zero is a count nobody reads until the thing stops working.
          <span
            className={`rounded px-2.5 py-1 text-[13px] ${
              credits === 0
                ? 'bg-flag-bg text-flag'
                : credits === 1
                  ? 'text-flag'
                  : 'text-ink-muted'
            }`}
          >
            {creditsLabel(credits)}
          </span>
        ) : null}
        <UserMenu admin={admin} />
      </div>
    </header>
  );
}

/**
 * The bar, with the one thing it has to ask the database for.
 *
 * Four destinations, all of which are places you return to. Onboarding and the
 * questions are not here on purpose — they are things you pass through, and
 * putting a one-time flow in permanent navigation is how an app ends up feeling
 * like a settings menu.
 *
 * The admin check is asked here rather than passed in by each page, so a page
 * added later cannot forget it. Costs one primary-key lookup per render when
 * an allowlist is configured, and nothing at all when one is not — `isAdmin`
 * returns before touching the database if RESUMI_ADMIN_EMAILS is unset, which
 * is every deploy that has no admin, and it never throws.
 */
export default async function AppNav({ active, credits }: { active: NavKey; credits?: number }) {
  return <NavBar active={active} credits={credits} admin={await isAdmin(await currentUserId())} />;
}
