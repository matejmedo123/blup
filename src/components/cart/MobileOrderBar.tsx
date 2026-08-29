"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useCart } from "@/context/CartContext";
import { formatPrice } from "@/lib/format";
import { cn } from "@/lib/utils";
import { BagIcon } from "@/components/ui/Icons";

/**
 * Lepivá spodná lišta na mobile — objaví sa, keď je niečo v košíku
 * a používateľ je na stránke s menu.
 */
export function MobileOrderBar() {
  const { itemCount, totals, openCart, hydrated, isCartOpen } = useCart();
  const pathname = usePathname();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > 420);
    const raf = requestAnimationFrame(onScroll);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  const hiddenRoute =
    pathname?.startsWith("/pokladna") || pathname?.startsWith("/objednavka");

  const show = hydrated && itemCount > 0 && visible && !hiddenRoute && !isCartOpen;

  return (
    <div
      className={cn(
        "no-print fixed inset-x-0 bottom-0 z-40 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] transition-[transform,opacity] duration-300 ease-out lg:hidden",
        show ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-full opacity-0",
      )}
    >
      <button
        type="button"
        onClick={openCart}
        tabIndex={show ? 0 : -1}
        aria-hidden={!show}
        className="flex h-15 w-full items-center justify-between gap-3 rounded-full bg-burgundy px-5 text-cream shadow-[0_16px_36px_-12px_rgba(50,10,10,0.7)] transition-colors active:bg-burgundy-700"
      >
        <span className="flex items-center gap-3">
          <span className="relative flex h-9 w-9 items-center justify-center rounded-full bg-cream/12">
            <BagIcon className="h-5 w-5" />
          </span>
          <span className="font-sans text-[0.78rem] font-extrabold tracking-[0.12em] uppercase">
            Košík · {itemCount} {itemCount === 1 ? "položka" : itemCount < 5 ? "položky" : "položiek"}
          </span>
        </span>
        <span className="font-display text-xl tabular-nums">{formatPrice(totals.total)}</span>
      </button>
    </div>
  );
}
