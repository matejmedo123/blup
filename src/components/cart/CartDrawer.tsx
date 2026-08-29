"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { useCart } from "@/context/CartContext";
import { meetsMinimum, missingToFreeDelivery, missingToMinimum } from "@/lib/cart";
import { ORDER_CONFIG } from "@/lib/config";
import { formatPrice } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ArrowIcon, BagIcon, CloseIcon } from "@/components/ui/Icons";
import { trapFocus } from "@/components/layout/MobileNavigation";
import { CartItemRow } from "./CartItemRow";

/** Bočný košík (desktop) / celoobrazovkový panel (mobil). */
export function CartDrawer() {
  const {
    items,
    isCartOpen,
    closeCart,
    updateQuantity,
    removeLine,
    totals,
    orderType,
    setOrderType,
    subtotal,
  } = useCart();
  const router = useRouter();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isCartOpen) return;
    const t = window.setTimeout(() => closeRef.current?.focus(), 60);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeCart();
      if (e.key === "Tab") trapFocus(e, panelRef.current);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.clearTimeout(t);
    };
  }, [isCartOpen, closeCart]);

  const belowMinimum = !meetsMinimum(subtotal);
  const toFree = missingToFreeDelivery(subtotal);
  const isEmpty = items.length === 0;

  const goToCheckout = () => {
    closeCart();
    router.push("/pokladna");
  };

  return (
    <div
      className={cn(
        "no-print fixed inset-0 z-[75] overflow-hidden",
        isCartOpen ? "pointer-events-auto" : "pointer-events-none",
      )}
      aria-hidden={!isCartOpen}
    >
      <div
        onClick={closeCart}
        className={cn(
          "absolute inset-0 bg-ink/60 backdrop-blur-[2px] transition-opacity duration-300",
          isCartOpen ? "opacity-100" : "opacity-0",
        )}
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal={isCartOpen}
        aria-label="Košík"
        className={cn(
          "absolute inset-y-0 right-0 flex w-full flex-col bg-cream transition-transform duration-350 ease-[cubic-bezier(0.16,1,0.3,1)] sm:max-w-md lg:max-w-lg",
          isCartOpen ? "translate-x-0" : "translate-x-full",
        )}
      >
        {/* Hlavička */}
        <div className="shrink-0 bg-burgundy px-5 pt-5 pb-4 text-cream sm:px-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="eyebrow text-cream/55">Tvoja objednávka</p>
              <h2 className="mt-1.5 font-display text-[2.2rem] leading-none">Košík</h2>
            </div>
            <button
              ref={closeRef}
              type="button"
              onClick={closeCart}
              aria-label="Zavrieť košík"
              className="flex h-11 w-11 items-center justify-center rounded-full border border-cream/25 transition-colors hover:bg-cream/10"
            >
              <CloseIcon className="h-5 w-5" />
            </button>
          </div>

          {/* Prepínač spôsobu */}
          <div
            role="radiogroup"
            aria-label="Spôsob prevzatia"
            className="mt-5 grid grid-cols-2 gap-1 rounded-full bg-burgundy-800/60 p-1"
          >
            {(["pickup", "delivery"] as const).map((type) => (
              <button
                key={type}
                type="button"
                role="radio"
                aria-checked={orderType === type}
                onClick={() => setOrderType(type)}
                className={cn(
                  "h-10 rounded-full font-sans text-[0.7rem] font-extrabold tracking-[0.12em] uppercase transition-colors",
                  orderType === type
                    ? "bg-cream text-burgundy"
                    : "text-cream/65 hover:text-cream",
                )}
              >
                {type === "pickup" ? "Osobný odber" : "Doručenie"}
              </button>
            ))}
          </div>
        </div>

        <div
          aria-hidden
          className="checkerboard h-2 shrink-0 text-burgundy"
          style={{ ["--checker-size" as string]: "0.5rem" }}
        />

        {/* Položky */}
        <div className="flex-1 overflow-y-auto overscroll-contain px-5 sm:px-6">
          {isEmpty ? (
            <div className="flex h-full flex-col items-center justify-center py-16 text-center">
              <span className="flex h-20 w-20 items-center justify-center rounded-full bg-cream-200 text-ink/25">
                <BagIcon className="h-9 w-9" />
              </span>
              <h3 className="mt-6 font-display text-2xl text-ink">Košík je prázdny</h3>
              <p className="mt-2 max-w-xs text-sm text-ink/55">
                Pozri si menu a vyber si svoj smash burger. Smashujeme čerstvo,
                servírujeme horúce.
              </p>
              <Link
                href="/#menu"
                onClick={closeCart}
                className="mt-6 inline-flex h-12 items-center rounded-full bg-burgundy px-7 font-sans text-[0.78rem] font-extrabold tracking-[0.14em] text-cream uppercase transition-colors hover:bg-burgundy-700"
              >
                Pozrieť menu
              </Link>
            </div>
          ) : (
            <>
              <ul className="divide-y divide-ink/8">
                {items.map((item) => (
                  <CartItemRow
                    key={item.key}
                    item={item}
                    onQuantityChange={updateQuantity}
                    onRemove={removeLine}
                  />
                ))}
              </ul>

              {orderType === "delivery" && toFree > 0 && (
                <div className="mt-4 mb-2 rounded-xl bg-gold/18 px-4 py-3 text-[0.82rem] text-ink/75">
                  Do <strong className="text-burgundy">doručenia zdarma</strong> ti chýba{" "}
                  <strong className="tabular-nums">{formatPrice(toFree)}</strong>.
                </div>
              )}
            </>
          )}
        </div>

        {/* Súhrn */}
        {!isEmpty && (
          <div className="shrink-0 border-t border-ink/10 bg-cream px-5 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6 sm:pb-5">
            <dl className="flex flex-col gap-1.5 text-[0.9rem]">
              <div className="flex justify-between">
                <dt className="text-ink/60">Medzisúčet</dt>
                <dd className="font-semibold text-ink tabular-nums">{formatPrice(totals.subtotal)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink/60">
                  {orderType === "pickup" ? "Osobný odber" : "Doručenie"}
                </dt>
                <dd className="font-semibold text-ink tabular-nums">
                  {totals.deliveryFee === 0 ? "Zdarma" : formatPrice(totals.deliveryFee)}
                </dd>
              </div>
              <div className="mt-2 flex items-baseline justify-between border-t border-ink/10 pt-3">
                <dt className="font-display text-xl text-ink">Celkom</dt>
                <dd className="font-display text-2xl text-burgundy tabular-nums">
                  {formatPrice(totals.total)}
                </dd>
              </div>
            </dl>

            {belowMinimum && (
              <p role="status" className="mt-3 rounded-xl bg-burgundy/8 px-4 py-3 text-[0.8rem] text-burgundy">
                Minimálna objednávka je{" "}
                <strong className="tabular-nums">{formatPrice(ORDER_CONFIG.minOrder)}</strong>. Pridaj
                ešte za <strong className="tabular-nums">{formatPrice(missingToMinimum(subtotal))}</strong>.
              </p>
            )}

            <button
              type="button"
              onClick={goToCheckout}
              disabled={belowMinimum}
              className="mt-4 flex h-14 w-full items-center justify-center gap-3 rounded-full bg-burgundy font-sans text-[0.85rem] font-extrabold tracking-[0.14em] text-cream uppercase transition-colors hover:bg-burgundy-700 disabled:cursor-not-allowed disabled:bg-ink/20 disabled:text-ink/45"
            >
              Pokladňa
              <ArrowIcon className="h-4.5 w-4.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
