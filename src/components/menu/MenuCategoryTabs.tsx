"use client";

import { useEffect, useRef } from "react";
import type { Category, CategoryId } from "@/lib/types";
import { cn } from "@/lib/utils";

interface MenuCategoryTabsProps {
  categories: Category[];
  active: CategoryId;
  onChange: (id: CategoryId) => void;
  counts: Record<string, number>;
}

/** Lepivé taby kategórií — horizontálny scroll na mobile, plná lišta na desktope. */
export function MenuCategoryTabs({
  categories,
  active,
  onChange,
  counts,
}: MenuCategoryTabsProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const isFirstRender = useRef(true);

  /**
   * Aktívny tab vycentrujeme v horizontálnej lište. Posúvame výhradne
   * kontajner tabov (nie `scrollIntoView`), aby sa stránka nikdy
   * nehýbala vertikálne — a preskakujeme prvý render po načítaní.
   */
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    const list = listRef.current;
    const el = list?.querySelector<HTMLElement>(`[data-tab="${active}"]`);
    if (!list || !el) return;
    const left = el.offsetLeft - (list.clientWidth - el.offsetWidth) / 2;
    list.scrollTo({ left: Math.max(0, left), behavior: "smooth" });
  }, [active]);

  return (
    <div className="no-print sticky top-18 z-30 -mx-5 border-y border-ink/10 bg-cream/95 backdrop-blur-md sm:-mx-8 sm:top-20 lg:-mx-12">
      <div
        ref={listRef}
        role="tablist"
        aria-label="Kategórie menu"
        className="no-scrollbar flex gap-1.5 overflow-x-auto px-5 py-3 sm:px-8 lg:justify-center lg:px-12"
      >
        {categories.map((c) => {
          const isActive = c.id === active;
          return (
            <button
              key={c.id}
              data-tab={c.id}
              role="tab"
              type="button"
              aria-selected={isActive}
              aria-controls={`panel-${c.id}`}
              id={`tab-${c.id}`}
              onClick={() => onChange(c.id)}
              className={cn(
                "flex h-11 shrink-0 items-center gap-2 rounded-full px-5 font-sans text-[0.76rem] font-extrabold tracking-[0.14em] uppercase transition-colors duration-200",
                isActive
                  ? "bg-burgundy text-cream"
                  : "bg-transparent text-ink/55 hover:bg-ink/6 hover:text-ink",
              )}
            >
              {c.label}
              <span
                className={cn(
                  "font-sans text-[0.65rem] tabular-nums",
                  isActive ? "text-cream/60" : "text-ink/35",
                )}
              >
                {counts[c.id] ?? 0}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
