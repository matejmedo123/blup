import type { Metadata } from "next";
import Link from "next/link";

import { BottomNav, SideNav } from "@/components/portal/BottomNav";
import { Avatar } from "@/components/ui/Avatar";
import { requireStaff } from "@/lib/auth/guards";
import { unreadCounts } from "@/lib/domain/portal";

export const metadata: Metadata = {
  title: { default: "Portál", template: "%s · CREW." },
  robots: { index: false, follow: false },
};

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const session = await requireStaff("/portal");
  const counts = await unreadCounts(session.user.id);

  return (
    <div className="min-h-dvh bg-bg">
      <header className="sticky top-0 z-20 border-b border-line bg-bg/94 backdrop-blur-[12px]">
        <div className="mx-auto flex h-14 max-w-[1100px] items-center gap-3 px-4 lg:h-16 lg:px-6">
          <Link
            href="/portal"
            className="flex min-h-11 items-center text-[19px] leading-none font-extrabold tracking-[-0.04em]"
          >
            CREW<span className="text-accent-deep">.</span>
          </Link>
          <Link
            href="/portal/profile"
            className="ml-auto flex items-center gap-2.5 rounded-full"
            aria-label="Môj profil"
          >
            <span className="hidden text-sm font-semibold sm:inline">{session.user.firstName}</span>
            <Avatar
              firstName={session.user.firstName}
              lastName={session.user.lastName}
              src={session.user.avatarUrl}
              size="sm"
              tone="dark"
            />
          </Link>
        </div>
      </header>

      <div className="mx-auto flex max-w-[1100px] gap-8 px-4 lg:px-6">
        <SideNav unreadMessages={counts.messages} unreadNotifications={counts.notifications} />
        <main id="main" className="pb-nav min-w-0 flex-1 pt-4 lg:pt-6 lg:pb-16">
          {children}
        </main>
      </div>

      <BottomNav unreadMessages={counts.messages} unreadNotifications={counts.notifications} />
    </div>
  );
}
