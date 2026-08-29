"use client";

import { useEffect, useState } from "react";
import { useCart } from "@/context/CartContext";
import { formatPrice } from "@/lib/format";
import { cn } from "@/lib/utils";
import { CheckIcon } from "@/components/ui/Icons";

/**
 * Nenápadné potvrdenie pridania do košíka. Nechá používateľa ďalej
 * prehliadať menu, ale ponúkne priamu cestu do košíka.
 */
export function CartToast() {
  const { lastAdded, isCartOpen } = useCart();
  if (!lastAdded || isCartOpen) return null;
  // `key` reštartuje animáciu pri každom novom pridaní.
  return <Toast key={lastAdded.token} name={lastAdded.name} quantity={lastAdded.quantity} />;
}

function Toast({ name, quantity }: { name: string; quantity: number }) {
  const { dismissLastAdded, openCart, totals, itemCount } = useCart();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const show = requestAnimationFrame(() => setVisible(true));
    const hide = window.setTimeout(() => setVisible(false), 3200);
    const clear = window.setTimeout(() => dismissLastAdded(), 3600);
    return () => {
      cancelAnimationFrame(show);
      window.clearTimeout(hide);
      window.clearTimeout(clear);
    };
  }, [dismissLastAdded]);

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "no-print fixed inset-x-3 bottom-24 z-[60] transition-[opacity,transform] duration-300 ease-out sm:inset-x-auto sm:right-6 sm:bottom-6 sm:max-w-sm lg:bottom-8",
        visible ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-4 opacity-0",
      )}
    >
      <div className="flex items-center gap-3 rounded-2xl bg-ink px-4 py-3.5 text-cream shadow-[0_20px_45px_-18px_rgba(0,0,0,0.8)]">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gold text-ink">
          <CheckIcon className="h-4.5 w-4.5" strokeWidth={3} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-display text-[1.05rem] leading-tight">
            {quantity}× {name}
          </p>
          <p className="text-[0.75rem] text-cream/55">
            Pridané do košíka · {itemCount}{" "}
            {itemCount === 1 ? "položka" : itemCount < 5 ? "položky" : "položiek"} ·{" "}
            <span className="tabular-nums">{formatPrice(totals.total)}</span>
          </p>
        </div>
        <button
          type="button"
          onClick={openCart}
          className="shrink-0 rounded-full bg-cream/12 px-4 py-2.5 font-sans text-[0.68rem] font-extrabold tracking-[0.12em] uppercase transition-colors hover:bg-cream/22"
        >
          Košík
        </button>
      </div>
    </div>
  );
}
