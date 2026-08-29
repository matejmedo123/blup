"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { RESTAURANT } from "@/lib/config";
import { lockScroll, unlockScroll } from "@/lib/scrollLock";
import { cn } from "@/lib/utils";
import { Logo } from "@/components/ui/Logo";
import { CloseIcon, PhoneIcon, PinIcon } from "@/components/ui/Icons";
import { NAV_LINKS } from "./Header";

interface MobileNavigationProps {
  open: boolean;
  onClose: () => void;
}

/** Celoobrazovková mobilná navigácia — veľké dotykové ciele, brand blok. */
export function MobileNavigation({ open, onClose }: MobileNavigationProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    lockScroll();
    closeRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab") trapFocus(e, panelRef.current);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      unlockScroll();
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  return (
    <div
      className={cn(
        "no-print fixed inset-0 z-[70] overflow-hidden lg:hidden",
        open ? "pointer-events-auto" : "pointer-events-none",
      )}
      aria-hidden={!open}
    >
      <div
        onClick={onClose}
        className={cn(
          "absolute inset-0 bg-ink/60 backdrop-blur-[2px] transition-opacity duration-300",
          open ? "opacity-100" : "opacity-0",
        )}
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal={open}
        aria-label="Navigácia"
        className={cn(
          "absolute inset-y-0 right-0 flex w-full max-w-sm flex-col bg-burgundy transition-transform duration-350 ease-[cubic-bezier(0.16,1,0.3,1)]",
          open ? "translate-x-0" : "translate-x-full",
        )}
      >
        <div className="flex items-center justify-between px-6 pt-6 pb-4">
          <Logo tone="cream" className="text-[2rem]" />
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Zavrieť menu"
            className="flex h-11 w-11 items-center justify-center rounded-full border border-cream/25 text-cream transition-colors hover:bg-cream/10"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        <div
          aria-hidden
          className="checkerboard mx-6 h-2.5 text-cream/85"
          style={{ ["--checker-size" as string]: "0.625rem" }}
        />

        <nav aria-label="Mobilná navigácia" className="flex-1 overflow-y-auto px-6 py-8">
          <ul className="flex flex-col gap-1">
            {NAV_LINKS.map((link, i) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  onClick={onClose}
                  className="flex items-baseline gap-3 py-3 font-display text-[2.4rem] leading-[1.02] text-cream transition-colors hover:text-gold"
                >
                  <span className="font-sans text-[0.7rem] font-bold text-cream/40 tabular-nums">
                    0{i + 1}
                  </span>
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>

          <Link
            href="/#menu"
            onClick={onClose}
            className="mt-8 flex h-14 w-full items-center justify-center rounded-full bg-gold font-sans text-[0.85rem] font-extrabold tracking-[0.16em] text-ink uppercase"
          >
            Objednať teraz
          </Link>
        </nav>

        <div className="border-t border-cream/15 px-6 py-6 text-cream/75">
          <p className="font-display text-lg text-gold">{RESTAURANT.claim}</p>
          <a
            href={`tel:${RESTAURANT.phoneHref}`}
            className="mt-4 flex items-center gap-3 text-sm font-semibold text-cream"
          >
            <PhoneIcon className="h-4.5 w-4.5 shrink-0" />
            {RESTAURANT.phone}
          </a>
          <p className="mt-2 flex items-center gap-3 text-sm">
            <PinIcon className="h-4.5 w-4.5 shrink-0" />
            {RESTAURANT.address.street}, {RESTAURANT.address.city}
          </p>
        </div>
      </div>
    </div>
  );
}

/** Jednoduchá focus pasca pre modálne panely. */
export function trapFocus(e: KeyboardEvent, container: HTMLElement | null) {
  if (!container) return;
  const focusable = container.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  );
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}
