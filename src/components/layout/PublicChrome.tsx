"use client";

import Link from "next/link";
import { useState } from "react";

import { IconMenu, IconX } from "@/components/ui/Icons";

const NAV = [
  { href: "/brigada", label: "Pre crew" },
  { href: "/#ako-to-funguje", label: "Ako to funguje" },
  { href: "/#preco-crew", label: "Pre organizátorov" },
];

export function PublicHeader({ homeHref }: { homeHref: string | null }) {
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-20 bg-ink/92 text-white backdrop-blur-[12px]">
      <div className="mx-auto flex max-w-[1240px] items-center gap-6 px-5 py-[18px] lg:gap-10 lg:px-8">
        <Link href="/" className="text-[21px] leading-none font-extrabold tracking-[-0.04em]">
          CREW<span className="text-accent">.</span>
        </Link>

        <nav className="hidden gap-7 text-sm font-medium text-white/72 lg:flex" aria-label="Hlavná navigácia">
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} className="transition-colors hover:text-white">
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          {homeHref ? (
            <Link
              href={homeHref}
              className="touch inline-flex items-center rounded-12 bg-accent px-5 text-sm font-semibold text-ink transition-[filter] hover:brightness-95"
            >
              Môj CREW.
            </Link>
          ) : (
            <>
              <Link
                href="/brigada/prihlasenie"
                className="touch hidden items-center px-2 text-sm font-medium text-white transition-colors hover:text-white/72 sm:inline-flex"
              >
                Prihlásiť sa
              </Link>
              <Link
                href="/brigada/registracia"
                className="touch inline-flex items-center rounded-12 bg-accent px-5 text-sm font-semibold text-ink transition-[filter] hover:brightness-95"
              >
                Chcem robiť
              </Link>
            </>
          )}
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="touch -mr-2 flex cursor-pointer items-center justify-center text-white lg:hidden"
            aria-expanded={open}
            aria-label={open ? "Zavrieť menu" : "Otvoriť menu"}
          >
            {open ? <IconX /> : <IconMenu />}
          </button>
        </div>
      </div>

      {open ? (
        <nav
          className="border-t border-white/12 px-5 pb-4 lg:hidden"
          aria-label="Mobilná navigácia"
        >
          {[...NAV, { href: "/dobrovolnik", label: "Chcem byť dobrovoľník" }, { href: "/stanok", label: "Chcem mať stánok" }].map(
            (item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className="touch flex items-center text-[15px] font-medium text-white/72 transition-colors hover:text-white"
              >
                {item.label}
              </Link>
            ),
          )}
          {!homeHref ? (
            <Link
              href="/brigada/prihlasenie"
              onClick={() => setOpen(false)}
              className="touch flex items-center text-[15px] font-medium text-white/72 sm:hidden"
            >
              Prihlásiť sa
            </Link>
          ) : null}
        </nav>
      ) : null}
    </header>
  );
}

export function PublicFooter() {
  return (
    <footer className="border-t border-line px-5 py-10 lg:px-8">
      <div className="mx-auto flex max-w-[1240px] flex-wrap items-center gap-x-6 gap-y-4 text-[13px] text-muted">
        <span className="text-lg font-extrabold tracking-[-0.04em] text-ink">
          CREW<span className="text-accent-deep">.</span>
        </span>
        <nav className="flex flex-wrap gap-x-5 gap-y-2" aria-label="Pätička">
          <Link href="/brigada" className="hover:text-ink">Brigáda</Link>
          <Link href="/dobrovolnik" className="hover:text-ink">Dobrovoľník</Link>
          <Link href="/stanok" className="hover:text-ink">Stánok</Link>
          <Link href="/gdpr" className="hover:text-ink">Ochrana údajov</Link>
          <Link href="/podmienky" className="hover:text-ink">Podmienky</Link>
        </nav>
        <span className="ml-auto">© {new Date().getFullYear()} CREW. Bratislava</span>
      </div>
    </footer>
  );
}
