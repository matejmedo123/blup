"use client";

import { useCallback, useMemo, useState } from "react";
import { useMenu } from "@/context/MenuContext";
import { formatPrice } from "@/lib/format";
import type { CategoryId, ExtraOption, Product } from "@/lib/types";
import { useCart } from "@/context/CartContext";
import { CheckerRule } from "@/components/ui/Checkerboard";
import { Reveal } from "@/components/ui/Reveal";
import { MenuCategoryTabs } from "./MenuCategoryTabs";
import { ProductCard } from "./ProductCard";
import { ProductModal } from "./ProductModal";

export function MenuSection() {
  const { addProduct } = useCart();
  const { menu, settings } = useMenu();
  const [active, setActive] = useState<CategoryId>("burgers");
  const [modalProduct, setModalProduct] = useState<Product | null>(null);

  const counts = useMemo(
    () =>
      Object.fromEntries(menu.map(({ category, products }) => [category.id, products.length])),
    [menu],
  );

  // po zmene menu môže zvolená kategória zmiznúť
  const current = menu.find((m) => m.category.id === active) ?? menu[0];

  const handleQuickAdd = useCallback(
    (product: Product) => addProduct(product),
    [addProduct],
  );

  const handleAddFromModal = useCallback(
    (product: Product, extras: ExtraOption[], quantity: number, note: string) => {
      addProduct(product, { extras, quantity, note });
      setModalProduct(null);
    },
    [addProduct],
  );

  if (!current) {
    return (
      <section id="menu" className="bg-cream py-20">
        <div className="container-enzo text-center">
          <p className="eyebrow text-ink/40">Menu sa načítava…</p>
        </div>
      </section>
    );
  }

  return (
    <section id="menu" aria-labelledby="menu-heading" className="bg-cream pb-20 lg:pb-28">
      {/* Hlavička sekcie */}
      <div className="container-enzo pt-16 pb-8 lg:pt-24 lg:pb-10">
        <Reveal className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl">
            <p className="eyebrow text-burgundy">Objednaj online</p>
            <h2
              id="menu-heading"
              className="mt-4 font-display text-[2.8rem] leading-[1.02] text-ink sm:text-[3.8rem] lg:text-[4.4rem]"
            >
              Menu
            </h2>
            <p className="mt-5 max-w-lg text-[1rem] leading-relaxed text-ink/60 sm:text-[1.05rem]">
              Vyber si, prispôsob a objednaj. Pripravujeme až po objednávke —
              burgery smashujeme na platni, pizzu pečieme na kameni.
            </p>
          </div>

          <div className="shrink-0 rounded-2xl border border-ink/10 bg-white/70 p-5 sm:max-w-xs">
            <p className="eyebrow text-burgundy">Dobré vedieť</p>
            <ul className="mt-3 flex flex-col gap-2 text-[0.85rem] text-ink/65">
              <li className="flex gap-2">
                <span aria-hidden className="text-gold">■</span>
                Minimálna objednávka {formatPrice(settings.minOrder)}
              </li>
              <li className="flex gap-2">
                <span aria-hidden className="text-gold">■</span>
                Doručenie {formatPrice(settings.deliveryFee)} — zdarma od{" "}
                {formatPrice(settings.freeDeliveryFrom)}
              </li>
              <li className="flex gap-2">
                <span aria-hidden className="text-gold">■</span>
                Osobný odber za {settings.prepTimePickup}
              </li>
            </ul>
          </div>
        </Reveal>
      </div>

      <div className="container-enzo">
        {!settings.acceptingOrders && (
          <div
            role="status"
            className="mb-6 rounded-2xl border border-burgundy/30 bg-burgundy/8 px-5 py-4 text-[0.95rem] text-burgundy"
          >
            <strong>Momentálne neprijímame objednávky.</strong>{" "}
            {settings.closedMessage}
          </div>
        )}

        <MenuCategoryTabs
          categories={menu.map((m) => m.category)}
          active={active}
          onChange={setActive}
          counts={counts}
        />

        {/* Panel kategórie */}
        <div
          key={current.category.id}
          role="tabpanel"
          id={`panel-${current.category.id}`}
          aria-labelledby={`tab-${current.category.id}`}
          className="pt-10 lg:pt-14"
        >
          <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
            <div>
              <h3 className="font-display text-[1.55rem] leading-[1.06] text-burgundy sm:text-[2.1rem]">
                {current.category.title}
              </h3>
              <p className="mt-2 text-[0.9rem] text-ink/55">{current.category.caption}</p>
            </div>
            <CheckerRule
              className="hidden h-3 max-w-40 flex-1 text-burgundy/30 sm:block"
              size="0.75rem"
            />
          </div>

          <ul className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3 lg:gap-5 xl:grid-cols-4">
            {current.products.map((product, i) => (
              <Reveal as="li" key={product.id} delay={Math.min(i * 55, 330)} className="h-full">
                <ProductCard
                  product={product}
                  onSelect={setModalProduct}
                  onQuickAdd={handleQuickAdd}
                  priority={i < 4 && active === "burgers"}
                />
              </Reveal>
            ))}
          </ul>
        </div>
      </div>

      <ProductModal
        product={modalProduct}
        onClose={() => setModalProduct(null)}
        onAdd={handleAddFromModal}
      />
    </section>
  );
}
