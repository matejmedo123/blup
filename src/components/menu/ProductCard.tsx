"use client";

import Image from "next/image";
import { memo } from "react";
import type { Product } from "@/lib/types";
import { formatPrice } from "@/lib/format";
import { cn } from "@/lib/utils";
import { SauceLid } from "./SauceLid";

interface ProductCardProps {
  product: Product;
  onSelect: (product: Product) => void;
  onQuickAdd: (product: Product) => void;
  priority?: boolean;
}

/**
 * Karta produktu. Celá plocha otvára detail; tlačidlo PRIDAŤ
 * pridá produkt priamo (rýchla cesta pre nápoje/omáčky).
 */
export const ProductCard = memo(function ProductCard({
  product,
  onSelect,
  onQuickAdd,
  priority,
}: ProductCardProps) {
  const hasExtras = (product.extras?.length ?? 0) > 0;

  return (
    <article className="group relative flex h-full flex-col overflow-hidden rounded-2xl bg-white ring-1 ring-ink/8 transition-[transform,box-shadow] duration-300 ease-out hover:-translate-y-1 hover:shadow-[0_22px_40px_-24px_rgba(58,13,13,0.55)] motion-reduce:hover:translate-y-0">
      {/* Médium */}
      <button
        type="button"
        onClick={() => onSelect(product)}
        aria-label={`Zobraziť detail — ${product.name}`}
        className="relative block aspect-4/3 w-full overflow-hidden bg-cream-200"
      >
        {product.image ? (
          <Image
            src={product.image}
            alt={product.imageAlt ?? product.name}
            fill
            sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
            priority={priority}
            loading={priority ? undefined : "lazy"}
            className="object-cover transition-transform duration-500 ease-out group-hover:scale-105 motion-reduce:group-hover:scale-100"
          />
        ) : product.lid ? (
          <div className="absolute inset-0 bg-gradient-to-b from-cream-200 to-cream-300">
            <div
              aria-hidden
              className="checkerboard absolute inset-x-0 bottom-0 h-4 text-burgundy/25"
              style={{ ["--checker-size" as string]: "0.5rem" }}
            />
            <SauceLid
              lines={product.lid.lines}
              accent={product.lid.accent}
              className="absolute inset-0 transition-transform duration-500 ease-out group-hover:scale-105 motion-reduce:group-hover:scale-100"
            />
          </div>
        ) : null}

        {product.badge && (
          <span className="absolute top-3 left-3 rounded-full bg-gold px-3 py-1.5 font-sans text-[0.6rem] font-extrabold tracking-[0.14em] text-ink uppercase">
            {product.badge}
          </span>
        )}
      </button>

      {/* Obsah */}
      <div className="flex flex-1 flex-col p-4 sm:p-5">
        <button
          type="button"
          onClick={() => onSelect(product)}
          className="text-left"
        >
          <h3 className="font-display text-[0.98rem] leading-[1.12] text-ink sm:text-[1.12rem]">
            {product.name}
          </h3>
        </button>

        <p className="mt-2 line-clamp-2 text-[0.82rem] leading-snug text-ink/55 sm:text-[0.875rem]">
          {product.description}
        </p>

        {product.tags && product.tags.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-1.5">
            {product.tags.map((t, i) => (
              <li
                key={t}
                className={cn(
                  "rounded-full bg-cream-200 px-2.5 py-1 text-[0.62rem] font-bold tracking-[0.08em] text-burgundy uppercase",
                  // na malých displejoch necháme len prvý tag, aby karta ostala kompaktná
                  i > 0 && "hidden sm:block",
                )}
              >
                {t}
              </li>
            ))}
          </ul>
        )}

        <div className="mt-auto flex flex-col gap-2.5 pt-4 sm:flex-row sm:items-end sm:justify-between sm:gap-3">
          <p className="font-display text-[1.15rem] leading-none text-burgundy tabular-nums sm:text-[1.3rem]">
            {formatPrice(product.price)}
          </p>

          <button
            type="button"
            onClick={() => (hasExtras ? onSelect(product) : onQuickAdd(product))}
            aria-label={
              hasExtras
                ? `Prispôsobiť a pridať — ${product.name}`
                : `Pridať do košíka — ${product.name}`
            }
            className={cn(
              "inline-flex h-11 w-full shrink-0 items-center justify-center gap-1.5 rounded-full px-4 font-sans text-[0.7rem] font-extrabold tracking-[0.12em] uppercase transition-colors duration-200 sm:w-auto sm:px-5 sm:text-[0.74rem]",
              "bg-burgundy text-cream hover:bg-burgundy-700 active:bg-burgundy-800",
            )}
          >
            <span aria-hidden className="text-base leading-none">+</span>
            Pridať
          </button>
        </div>
      </div>
    </article>
  );
});
