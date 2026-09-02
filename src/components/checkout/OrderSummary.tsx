"use client";

import { formatPrice } from "@/lib/format";
import { missingToFreeDelivery } from "@/lib/cart";
import { useCart } from "@/context/CartContext";
import type { CartItem, OrderTotals, OrderType } from "@/lib/types";
import { CartItemRow } from "@/components/cart/CartItemRow";

interface OrderSummaryProps {
  items: CartItem[];
  totals: OrderTotals;
  orderType: OrderType;
  /** V pokladni je súhrn iba na čítanie s odkazom späť do košíka */
  onEdit?: () => void;
}

export function OrderSummary({ items, totals, orderType, onEdit }: OrderSummaryProps) {
  const { rules } = useCart();
  const toFree = missingToFreeDelivery(totals.subtotal, rules);

  return (
    <div className="rounded-2xl bg-white p-5 ring-1 ring-ink/8 sm:p-6">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="font-display text-[1.2rem] leading-[1.1] text-ink">Tvoja objednávka</h2>
        {onEdit && (
          <button
            type="button"
            onClick={onEdit}
            className="link-underline text-[0.75rem] font-bold tracking-[0.1em] text-burgundy uppercase"
          >
            Upraviť
          </button>
        )}
      </div>

      <ul className="mt-4 divide-y divide-ink/8 border-y border-ink/8">
        {items.map((item) => (
          <CartItemRow
            key={item.key}
            item={item}
            onQuantityChange={() => undefined}
            onRemove={() => undefined}
            readOnly
          />
        ))}
      </ul>

      <dl className="mt-5 flex flex-col gap-2 text-[0.92rem]">
        <div className="flex justify-between">
          <dt className="text-ink/60">Medzisúčet</dt>
          <dd className="font-semibold tabular-nums">{formatPrice(totals.subtotal)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-ink/60">
            {orderType === "pickup" ? "Osobný odber" : "Doručenie"}
          </dt>
          <dd className="font-semibold tabular-nums">
            {totals.deliveryFee === 0 ? "Zdarma" : formatPrice(totals.deliveryFee)}
          </dd>
        </div>
        {orderType === "delivery" && toFree > 0 && (
          <p className="rounded-lg bg-gold/18 px-3 py-2 text-[0.78rem] text-ink/70">
            Do doručenia zdarma ti chýba{" "}
            <strong className="tabular-nums">{formatPrice(toFree)}</strong>.
          </p>
        )}
        <div className="mt-2 flex items-baseline justify-between border-t border-ink/10 pt-4">
          <dt className="font-display text-[1.15rem] text-ink">Celkom</dt>
          <dd className="font-display text-[1.5rem] text-burgundy tabular-nums">
            {formatPrice(totals.total)}
          </dd>
        </div>
      </dl>

      <p className="mt-4 text-[0.72rem] leading-relaxed text-ink/45">
        Ceny sú vrátane DPH. Minimálna hodnota objednávky je{" "}
        {formatPrice(rules.minOrder)}.
      </p>
    </div>
  );
}
