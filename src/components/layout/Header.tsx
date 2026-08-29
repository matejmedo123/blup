"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useCart } from "@/context/CartContext";
import { cn } from "@/lib/utils";
import { Logo } from "@/components/ui/Logo";
import { BagIcon, MenuIcon } from "@/components/ui/Icons";
import { MobileNavigation } from "./MobileNavigation";

export const NAV_LINKS = [
  { href: "/#menu", label: "Menu" },
  { href: "/#o-nas", label: "O nás" },
  { href: "/#ako-to-funguje", label: "Ako to funguje" },
  { href: "/#kontakt", label: "Kontakt" },
] as const;

export function Header() {
  const pathname = usePathname();
  const { itemCount, openCart, hydrated, bump } = useCart();
  const [scrolled, setScrolled] = useState(false);
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    // Počiatočný stav čítame mimo tela efektu, aby nevznikol kaskádový render.
    const raf = requestAnimationFrame(onScroll);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- zatvorenie menu po zmene route
    setNavOpen(false);
  }, [pathname]);

  const isCheckout = pathname?.startsWith("/pokladna") || pathname?.startsWith("/objednavka");

  return (
    <>
      <header
        className={cn(
          "no-print sticky top-0 z-50 w-full transition-[background-color,box-shadow,border-color] duration-300",
          scrolled
            ? "border-b border-burgundy-900/25 bg-burgundy shadow-[0_10px_30px_-18px_rgba(0,0,0,0.8)]"
            : "border-b border-transparent bg-burgundy",
        )}
      >
        <div className="container-enzo flex h-18 items-center justify-between gap-4 sm:h-20">
          {/* Logo */}
          <Link
            href="/"
            aria-label="ENZO Smash Burgers & Fries — domovská stránka"
            className="shrink-0 py-2"
          >
            <Logo tone="cream" className="text-[1.85rem] sm:text-[2.15rem]" />
          </Link>

          {/* Desktop navigácia */}
          <nav aria-label="Hlavná navigácia" className="hidden lg:block">
            <ul className="flex items-center gap-8 xl:gap-10">
              {NAV_LINKS.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className="link-underline text-[0.78rem] font-extrabold tracking-[0.18em] text-cream/85 uppercase transition-colors hover:text-cream"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          {/* Akcie */}
          <div className="flex items-center gap-2 sm:gap-3">
            <CartButton
              count={hydrated ? itemCount : 0}
              onClick={openCart}
              bump={bump}
            />

            {!isCheckout && (
              <Link
                href="/#menu"
                className="hidden h-11 items-center rounded-full bg-gold px-6 text-[0.78rem] font-extrabold tracking-[0.16em] text-ink uppercase transition-colors hover:bg-gold-600 sm:inline-flex"
              >
                Objednať
              </Link>
            )}

            <button
              type="button"
              onClick={() => setNavOpen(true)}
              aria-label="Otvoriť menu"
              aria-expanded={navOpen}
              className="flex h-11 w-11 items-center justify-center rounded-full border border-cream/25 text-cream transition-colors hover:bg-cream/10 lg:hidden"
            >
              <MenuIcon className="h-5.5 w-5.5" />
            </button>
          </div>
        </div>

        {/* Šachovnicový prúžok pod hlavičkou */}
        <div
          aria-hidden
          className="checkerboard h-2 w-full text-cream/90"
          style={{ ["--checker-size" as string]: "0.5rem" }}
        />
      </header>

      <MobileNavigation open={navOpen} onClose={() => setNavOpen(false)} />
    </>
  );
}

function CartButton({
  count,
  onClick,
  bump,
}: {
  count: number;
  onClick: () => void;
  bump: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={
        count > 0 ? `Otvoriť košík — ${count} položiek` : "Otvoriť košík — prázdny"
      }
      className="relative flex h-11 w-11 items-center justify-center rounded-full border border-cream/25 text-cream transition-colors hover:bg-cream/10"
    >
      <BagIcon className="h-5.5 w-5.5" />
      {count > 0 && (
        <span
          key={bump}
          className="absolute -top-1 -right-1 flex h-5.5 min-w-5.5 items-center justify-center rounded-full bg-gold px-1.5 font-display text-[0.7rem] text-ink tabular-nums"
          style={{ animation: "cart-bump 0.35s ease-out" }}
        >
          {count}
        </span>
      )}
    </button>
  );
}
