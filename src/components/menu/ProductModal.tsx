"use client";

import Image from "next/image";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ExtraOption, Product } from "@/lib/types";
import { formatPrice } from "@/lib/format";
import { round2 } from "@/lib/format";
import { lockScroll, unlockScroll } from "@/lib/scrollLock";
import { cn } from "@/lib/utils";
import { CheckIcon, CloseIcon } from "@/components/ui/Icons";
import { QuantityStepper } from "@/components/ui/QuantityStepper";
import { trapFocus } from "@/components/layout/MobileNavigation";
import { SauceLid } from "./SauceLid";

interface ProductModalProps {
  product: Product | null;
  onClose: () => void;
  onAdd: (product: Product, extras: ExtraOption[], quantity: number, note: string) => void;
}

/** Detail produktu s prispôsobením — bottom-sheet na mobile, dialóg na desktope. */
export function ProductModal({ product, onClose, onAdd }: ProductModalProps) {
  if (!product) return null;
  // `key` zaručí čerstvý stav pre každý produkt — netreba resetovací efekt.
  return <ProductModalPanel key={product.id} product={product} onClose={onClose} onAdd={onAdd} />;
}

interface ProductModalPanelProps {
  product: Product;
  onClose: () => void;
  onAdd: (product: Product, extras: ExtraOption[], quantity: number, note: string) => void;
}

function ProductModalPanel({ product, onClose, onAdd }: ProductModalPanelProps) {
  const [selected, setSelected] = useState<string[]>([]);
  const [quantity, setQuantity] = useState(1);
  const [note, setNote] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    lockScroll();
    const t = window.setTimeout(() => closeRef.current?.focus(), 60);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab") trapFocus(e, panelRef.current);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      unlockScroll();
      document.removeEventListener("keydown", onKey);
      window.clearTimeout(t);
    };
  }, [onClose]);

  const extras = useMemo(() => product.extras ?? [], [product.extras]);
  const chosen = useMemo(
    () => extras.filter((e) => selected.includes(e.id)),
    [extras, selected],
  );
  const unitPrice = round2(
    product.price + chosen.reduce((sum, e) => sum + e.price, 0),
  );
  const total = round2(unitPrice * quantity);

  const toggle = (id: string) =>
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  return (
    <div className="no-print fixed inset-0 z-[80]" role="presentation">
      <div
        onClick={onClose}
        className="absolute inset-0 animate-[fade-in_0.25s_ease-out_both] bg-ink/65 backdrop-blur-[3px]"
      />

      <div className="absolute inset-0 flex items-end justify-center sm:items-center sm:p-6">
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="product-modal-title"
          className={cn(
            "relative flex max-h-[92vh] w-full flex-col overflow-hidden bg-cream sm:max-h-[88vh] sm:max-w-4xl sm:rounded-3xl",
            "rounded-t-3xl animate-[slide-up_0.35s_cubic-bezier(0.16,1,0.3,1)_both] sm:animate-[pop_0.3s_cubic-bezier(0.34,1.56,0.64,1)_both]",
          )}
        >
          {/* Mobilné úchopové pravítko */}
          <div aria-hidden className="mx-auto mt-3 h-1.5 w-12 shrink-0 rounded-full bg-ink/15 sm:hidden" />

          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Zavrieť detail produktu"
            className="absolute top-4 right-4 z-10 flex h-11 w-11 items-center justify-center rounded-full bg-cream/90 text-ink shadow-md backdrop-blur transition-colors hover:bg-white sm:top-5 sm:right-5"
          >
            <CloseIcon className="h-5 w-5" />
          </button>

          <div className="flex-1 overflow-y-auto overscroll-contain">
            <div className="sm:grid sm:grid-cols-[minmax(0,0.95fr)_minmax(0,1fr)]">
              {/* Obrázok */}
              <div className="relative aspect-16/10 w-full shrink-0 bg-cream-200 sm:sticky sm:top-0 sm:aspect-auto sm:h-full sm:min-h-[26rem]">
                {product.image ? (
                  <Image
                    src={product.image}
                    alt={product.imageAlt ?? product.name}
                    fill
                    sizes="(max-width: 640px) 100vw, 45vw"
                    className="object-cover"
                  />
                ) : product.lid ? (
                  <div className="absolute inset-0 bg-gradient-to-b from-cream-200 to-cream-300">
                    <SauceLid
                      lines={product.lid.lines}
                      accent={product.lid.accent}
                      className="absolute inset-0"
                    />
                  </div>
                ) : null}
                {product.badge && (
                  <span className="absolute top-4 left-4 rounded-full bg-gold px-3.5 py-2 font-sans text-[0.65rem] font-extrabold tracking-[0.14em] text-ink uppercase">
                    {product.badge}
                  </span>
                )}
              </div>

              {/* Obsah */}
              <div className="p-5 sm:p-8">
                <h2
                  id="product-modal-title"
                  className="font-display text-[2.1rem] leading-[1.02] text-ink sm:text-[2.6rem]"
                >
                  {product.name}
                </h2>
                <p className="mt-3 text-[0.95rem] leading-relaxed text-ink/65">
                  {product.description}
                </p>
                <p className="mt-4 font-display text-[1.75rem] leading-none text-burgundy tabular-nums">
                  {formatPrice(product.price)}
                </p>

                {extras.length > 0 && (
                  <fieldset className="mt-7">
                    <legend className="eyebrow text-ink/55">
                      Pridať extra{" "}
                      <span className="font-normal normal-case tracking-normal text-ink/35">
                        (voliteľné)
                      </span>
                    </legend>
                    <div className="mt-3 flex flex-col gap-2">
                      {extras.map((extra) => {
                        const isOn = selected.includes(extra.id);
                        return (
                          <label
                            key={extra.id}
                            className={cn(
                              "flex cursor-pointer items-center gap-3 rounded-xl border-2 bg-white px-4 py-3 transition-colors",
                              isOn
                                ? "border-burgundy bg-burgundy/5"
                                : "border-ink/10 hover:border-ink/25",
                            )}
                          >
                            <input
                              type="checkbox"
                              checked={isOn}
                              onChange={() => toggle(extra.id)}
                              className="sr-only"
                            />
                            <span
                              aria-hidden
                              className={cn(
                                "flex h-6 w-6 shrink-0 items-center justify-center rounded-md border-2 transition-colors",
                                isOn
                                  ? "border-burgundy bg-burgundy text-cream"
                                  : "border-ink/20 bg-white",
                              )}
                            >
                              {isOn && <CheckIcon className="h-3.5 w-3.5" strokeWidth={3} />}
                            </span>
                            <span className="flex-1 text-[0.92rem] font-semibold text-ink">
                              {extra.name}
                            </span>
                            <span className="font-sans text-[0.88rem] font-bold text-burgundy tabular-nums">
                              +{formatPrice(extra.price)}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </fieldset>
                )}

                <div className="mt-7">
                  <label
                    htmlFor="product-note"
                    className="eyebrow text-ink/55"
                  >
                    Poznámka pre kuchyňu
                  </label>
                  <input
                    id="product-note"
                    type="text"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    maxLength={120}
                    placeholder="napr. bez cibule, extra prepečené…"
                    className="mt-2 h-13 w-full rounded-xl border-2 border-ink/10 bg-white px-4 text-[0.95rem] placeholder:text-ink/30 focus:border-burgundy focus:outline-none"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Pätička s CTA */}
          <div className="shrink-0 border-t border-ink/10 bg-cream px-5 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-8 sm:pb-5">
            <div className="flex items-center gap-2.5 sm:gap-4">
              <QuantityStepper
                value={quantity}
                onChange={setQuantity}
                label={product.name}
              />
              <button
                type="button"
                onClick={() => onAdd(product, chosen, quantity, note)}
                className="flex h-13 flex-1 items-center justify-center gap-1.5 rounded-full bg-burgundy px-3 font-sans text-[0.75rem] font-extrabold tracking-[0.08em] text-cream uppercase transition-colors hover:bg-burgundy-700 active:bg-burgundy-800 sm:h-14 sm:gap-2 sm:px-4 sm:text-[0.85rem] sm:tracking-[0.1em]"
              >
                <span>
                  Pridať<span className="hidden xs:inline"> do košíka</span>
                </span>
                <span aria-hidden className="opacity-50">—</span>
                <span className="tabular-nums">{formatPrice(total)}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
