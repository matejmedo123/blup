"use client";

import type { PaymentMethod } from "@/lib/types";
import { cn } from "@/lib/utils";

const OPTIONS: {
  id: PaymentMethod;
  title: string;
  text: string;
  icon: string;
}[] = [
  {
    id: "card",
    title: "Platobná karta",
    text: "Zaplatíš online pri odoslaní objednávky.",
    icon: "▭",
  },
  {
    id: "cash",
    title: "Hotovosť",
    text: "Zaplatíš pri prevzatí objednávky.",
    icon: "€",
  },
];

export function PaymentSelector({
  value,
  onChange,
  allowed,
}: {
  value: PaymentMethod;
  onChange: (v: PaymentMethod) => void;
  /** Ktoré platby má prevádzka zapnuté (z nastavení na serveri) */
  allowed?: { cash: boolean; card: boolean };
}) {
  const enabled = OPTIONS.filter((o) => allowed?.[o.id] ?? true);
  const list = enabled.length > 0 ? enabled : OPTIONS.filter((o) => o.id === "cash");

  return (
    <fieldset>
      <legend className="sr-only">Spôsob platby</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        {list.map((o) => {
          const active = value === o.id;
          return (
            <label
              key={o.id}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-xl border-2 bg-white p-4 transition-colors",
                active ? "border-burgundy bg-burgundy/4" : "border-ink/10 hover:border-ink/25",
              )}
            >
              <input
                type="radio"
                name="payment"
                value={o.id}
                checked={active}
                onChange={() => onChange(o.id)}
                className="sr-only"
              />
              <span
                aria-hidden
                className={cn(
                  "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 transition-colors",
                  active ? "border-burgundy" : "border-ink/25",
                )}
              >
                {active && <span className="h-3 w-3 rounded-full bg-burgundy" />}
              </span>
              <span className="flex-1">
                <span className="block font-display text-[1.15rem] leading-none text-ink">
                  {o.title}
                </span>
                <span className="mt-1.5 block text-[0.82rem] text-ink/55">{o.text}</span>
              </span>
            </label>
          );
        })}
      </div>

      {value === "card" && (
        <p className="mt-3 flex gap-2.5 rounded-xl border border-gold/50 bg-gold/12 px-4 py-3 text-[0.8rem] leading-relaxed text-ink/75">
          <span aria-hidden className="text-gold-600">●</span>
          <span>
            Po odoslaní ťa presmerujeme na zabezpečenú platobnú bránu. Objednávku
            pustíme na platňu hneď po zaplatení.
          </span>
        </p>
      )}
    </fieldset>
  );
}
