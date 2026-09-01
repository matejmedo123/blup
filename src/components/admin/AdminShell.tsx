"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { LogoutButton } from "@/components/layout/LogoutButton";
import { Avatar } from "@/components/ui/Avatar";
import { IconMenu, IconX } from "@/components/ui/Icons";
import { cn } from "@/lib/cn";

import { ADMIN_NAV, isActive } from "./nav-config";
import { CommandMenu } from "./CommandMenu";
import { EventSwitcher } from "./EventSwitcher";

export type AdminShellUser = {
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
  roleLabel: string;
};

export function AdminShell({
  user,
  sections,
  events,
  activeEventId,
  children,
}: {
  user: AdminShellUser;
  sections: string[];
  events: { id: string; name: string }[];
  activeEventId: string | null;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);

  const allowed = new Set(sections);
  const groups = ADMIN_NAV.map((group) => ({
    ...group,
    items: group.items.filter((item) => allowed.has(item.section)),
  })).filter((group) => group.items.length > 0);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCommandOpen((v) => !v);
      }
      if (e.key === "Escape") {
        setCommandOpen(false);
        setMobileNavOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const nav = (
    <nav className="flex flex-col gap-6 p-4" aria-label="Admin navigácia">
      {groups.map((group) => (
        <div key={group.label} className="flex flex-col gap-1">
          <p className="px-2.5 pb-1 text-[11px] font-semibold tracking-[0.12em] text-white/40 uppercase">
            {group.label}
          </p>
          {group.items.map((item) => {
            const active = isActive(pathname, item);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setMobileNavOpen(false)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-11 items-center rounded-10 px-2.5 text-sm transition-colors duration-150",
                  active
                    ? "bg-white/12 font-semibold text-white"
                    : "font-medium text-white/62 hover:bg-white/8 hover:text-white",
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );

  return (
    <div className="flex min-h-dvh bg-bg">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-dvh w-[236px] shrink-0 flex-col overflow-y-auto bg-ink lg:flex">
        <div className="px-6 pt-7 pb-2">
          <Link href="/admin" className="text-[22px] leading-none font-extrabold tracking-[-0.04em] text-white">
            CREW<span className="text-accent">.</span>
          </Link>
        </div>
        {nav}
        <div className="mt-auto border-t border-white/12 p-4">
          <EventSwitcher events={events} activeEventId={activeEventId} tone="dark" />
        </div>
      </aside>

      {/* Mobile drawer */}
      {mobileNavOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-ink/28"
            onClick={() => setMobileNavOpen(false)}
            aria-label="Zavrieť menu"
          />
          <div className="absolute inset-y-0 left-0 flex w-[280px] max-w-[85vw] flex-col overflow-y-auto bg-ink animate-(--animate-crew-drawer)">
            <div className="flex items-center justify-between px-5 pt-6 pb-2">
              <span className="text-[22px] leading-none font-extrabold tracking-[-0.04em] text-white">
                CREW<span className="text-accent">.</span>
              </span>
              <button
                type="button"
                onClick={() => setMobileNavOpen(false)}
                className="touch flex cursor-pointer items-center justify-center rounded-10 text-white/62 hover:text-white"
                aria-label="Zavrieť menu"
              >
                <IconX />
              </button>
            </div>
            {nav}
            <div className="mt-auto border-t border-white/12 p-4">
              <EventSwitcher events={events} activeEventId={activeEventId} tone="dark" />
            </div>
          </div>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 border-b border-line bg-surface/94 backdrop-blur-[12px]">
          <div className="flex h-16 items-center gap-3 px-4 lg:gap-6 lg:px-8">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              className="touch -ml-2 flex cursor-pointer items-center justify-center rounded-10 text-ink lg:hidden"
              aria-label="Otvoriť menu"
            >
              <IconMenu />
            </button>

            <Link
              href="/admin"
              className="text-[19px] leading-none font-extrabold tracking-[-0.04em] lg:hidden"
            >
              CREW<span className="text-accent-deep">.</span>
            </Link>

            <button
              type="button"
              onClick={() => setCommandOpen(true)}
              className="ml-auto flex min-h-10 cursor-pointer items-center gap-2.5 rounded-10 border border-line bg-subtle-2 px-3 text-sm text-faint transition-colors hover:bg-subtle lg:ml-0 lg:min-w-[300px]"
            >
              <span className="hidden lg:inline">Hľadať crew, smeny, prihlášky…</span>
              <span className="lg:hidden">Hľadať</span>
              <span className="ml-auto hidden rounded-[6px] border border-line bg-surface px-1.5 py-0.5 text-xs font-semibold text-muted lg:inline">
                ⌘K
              </span>
            </button>

            <div className="ml-auto hidden items-center gap-3 lg:flex">
              <LogoutButton variant="ghost" label="Odhlásiť" />
              <Avatar
                firstName={user.firstName}
                lastName={user.lastName}
                src={user.avatarUrl}
                size="sm"
                tone="dark"
              />
            </div>
            <div className="lg:hidden">
              <Avatar
                firstName={user.firstName}
                lastName={user.lastName}
                src={user.avatarUrl}
                size="sm"
                tone="dark"
              />
            </div>
          </div>
        </header>

        <main id="main" className="mx-auto w-full max-w-[1440px] flex-1 px-4 pt-6 pb-20 lg:px-8 lg:pt-10">
          {children}
        </main>
      </div>

      {/* Menu sa montuje až pri otvorení — stav sa tak resetuje bez efektu. */}
      {commandOpen ? <CommandMenu onClose={() => setCommandOpen(false)} /> : null}
    </div>
  );
}
