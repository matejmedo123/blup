"use client";

import Image from "next/image";
import type { CartItem } from "@/lib/types";
import { itemLineTotal, itemUnitPrice } from "@/lib/cart";
import { formatPrice } from "@/lib/format";
import { getProductById } from "@/lib/products";
import { QuantityStepper } from "@/components/ui/QuantityStepper";
import { TrashIcon } from "@/components/ui/Icons";
import { SauceLid } from "@/components/menu/SauceLid";

interface CartItemRowProps {
  item: CartItem;
  onQuantityChange: (key: string, quantity: number) => void;
  onRemove: (key: string) => void;
  /** Kompaktný variant bez ovládania (rekapitulácia v pokladni) */
  readOnly?: boolean;
}

export function CartItemRow({
  item,
  onQuantityChange,
  onRemove,
  readOnly = false,
}: CartItemRowProps) {
  const product = getProductById(item.productId);

  return (
    <li className="flex gap-3 py-4 sm:gap-4">
      {/* Náhľad */}
      <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-xl bg-cream-200 sm:h-22 sm:w-22">
        {item.image ? (
          <Image
            src={item.image}
            alt=""
            fill
            sizes="88px"
            className="object-cover"
          />
        ) : product?.lid ? (
          <SauceLid lines={product.lid.lines} accent={product.lid.accent} className="absolute inset-0" />
        ) : null}
        {readOnly && (
          <span className="absolute right-0 bottom-0 rounded-tl-lg bg-burgundy px-2 py-0.5 font-display text-xs text-cream tabular-nums">
            ×{item.quantity}
          </span>
        )}
      </div>

      {/* Detail */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-start justify-between gap-3">
          <h3 className="font-display text-[1.05rem] leading-tight text-ink">{item.name}</h3>
          <p className="shrink-0 font-display text-[1.05rem] leading-tight text-burgundy tabular-nums">
            {formatPrice(itemLineTotal(item))}
          </p>
        </div>

        {item.extras.length > 0 && (
          <ul className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[0.75rem] text-ink/55">
            {item.extras.map((e) => (
              <li key={e.id}>
                + {e.name}{" "}
                <span className="text-ink/35 tabular-nums">({formatPrice(e.price)})</span>
              </li>
            ))}
          </ul>
        )}

        {item.note && (
          <p className="mt-1 text-[0.75rem] text-ink/50 italic">&bdquo;{item.note}&ldquo;</p>
        )}

        {!readOnly && (
          <div className="mt-auto flex items-center justify-between gap-2 pt-3">
            <QuantityStepper
              value={item.quantity}
              onChange={(q) => onQuantityChange(item.key, q)}
              label={item.name}
              size="sm"
            />
            <div className="flex items-center gap-2">
              <span className="text-[0.72rem] text-ink/40 tabular-nums">
                {formatPrice(itemUnitPrice(item))} / ks
              </span>
              <button
                type="button"
                onClick={() => onRemove(item.key)}
                aria-label={`Odstrániť z košíka — ${item.name}`}
                className="flex h-10 w-10 items-center justify-center rounded-full text-ink/40 transition-colors hover:bg-burgundy/8 hover:text-burgundy"
              >
                <TrashIcon className="h-4.5 w-4.5" />
              </button>
            </div>
          </div>
        )}
      </div>
    </li>
  );
}
