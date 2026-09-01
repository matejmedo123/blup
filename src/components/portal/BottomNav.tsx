"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/cn";

/** Päť položiek, každá ≥56 px vysoká (§60, §71). */
const TABS = [
  { href: "/portal", label: "Domov", exact: true, d: "M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z" },
  { href: "/portal/shifts", label: "Smeny", d: "M4 6h16v15H4zM8 3v4M16 3v4M4 10h16" },
  { href: "/portal/messages", label: "Správy", d: "M4 5h16v11H9l-5 4z" },
  { href: "/portal/notifications", label: "Notifikácie", d: "M6 9a6 6 0 0 1 12 0v5l2 3H4l2-3z" },
  { href: "/portal/profile", label: "Profil", d: "M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M4 21a8 8 0 0 1 16 0" },
];

export function BottomNav({
  unreadMessages,
  unreadNotifications,
}: {
  unreadMessages: number;
  unreadNotifications: number;
}) {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Hlavná navigácia"
      className="safe-bottom fixed inset-x-0 bottom-0 z-30 flex h-[84px] items-start border-t border-line bg-surface/94 px-2 pt-2.5 backdrop-blur-[12px] lg:hidden"
    >
      {TABS.map((tab) => {
        const active = tab.exact
          ? pathname === tab.href
          : pathname === tab.href || pathname.startsWith(`${tab.href}/`);
        const badge =
          tab.href === "/portal/messages"
            ? unreadMessages
            : tab.href === "/portal/notifications"
              ? unreadNotifications
              : 0;

        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "relative flex min-h-14 flex-1 flex-col items-center gap-1.5 px-0.5 py-2",
              active ? "text-ink" : "text-faint",
            )}
          >
            <span className="relative">
              <svg
                viewBox="0 0 24 24"
                width={22}
                height={22}
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d={tab.d} />
              </svg>
              {badge > 0 ? (
                <span className="absolute -top-1 -right-2 flex min-w-[18px] items-center justify-center rounded-full bg-ink px-1 text-[10px] font-bold text-white">
                  {badge > 9 ? "9+" : badge}
                </span>
              ) : null}
            </span>
            <span className="text-[10px] font-semibold">{tab.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

/** Bočná navigácia od `lg` — rovnaké ciele, viac priestoru (§58). */
export function SideNav({
  unreadMessages,
  unreadNotifications,
}: {
  unreadMessages: number;
  unreadNotifications: number;
}) {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Navigácia portálu"
      className="sticky top-[76px] hidden w-[220px] shrink-0 flex-col gap-1 lg:flex"
    >
      {TABS.map((tab) => {
        const active = tab.exact
          ? pathname === tab.href
          : pathname === tab.href || pathname.startsWith(`${tab.href}/`);
        const badge =
          tab.href === "/portal/messages"
            ? unreadMessages
            : tab.href === "/portal/notifications"
              ? unreadNotifications
              : 0;

        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex min-h-11 items-center gap-3 rounded-12 px-3 text-[15px] transition-colors",
              active ? "bg-ink font-semibold text-white" : "font-medium text-muted hover:bg-subtle",
            )}
          >
            <svg
              viewBox="0 0 24 24"
              width={20}
              height={20}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d={tab.d} />
            </svg>
            {tab.label}
            {badge > 0 ? (
              <span
                className={cn(
                  "ml-auto flex min-w-[20px] items-center justify-center rounded-full px-1.5 text-[11px] font-bold",
                  active ? "bg-accent text-ink" : "bg-ink text-white",
                )}
              >
                {badge > 9 ? "9+" : badge}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
