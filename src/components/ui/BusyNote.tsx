"use client";

import { useMenu } from "@/context/MenuContext";
import { ClockIcon } from "@/components/ui/Icons";

/**
 * Vysvetlenie, prečo sú časy dlhšie ako inokedy.
 *
 * Časy, ktoré zákazník vidí, už predĺžené sú — server ich prepočítal
 * podľa toho, koľko má kuchyňa rozrobené. Bez tejto vety by to vyzeralo,
 * akoby prevádzka bola pomalá; s ňou je jasné, že je jednoducho nabité.
 */
export function BusyNote({ className }: { className?: string }) {
  const { load, live } = useMenu();

  if (!live || !load.busy) return null;

  return (
    <p
      role="status"
      className={`flex items-start gap-2.5 rounded-xl bg-gold/18 px-4 py-3 text-[0.85rem] leading-relaxed text-ink/80 ${className ?? ""}`}
    >
      <ClockIcon aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-burgundy" />
      <span>
        <strong className="font-sans font-extrabold">Máme nabito.</strong>{" "}
        Časy sú teraz o {load.extraMinutes} min dlhšie ako zvyčajne — rátame
        s tým, koľko objednávok je práve na platni.
      </span>
    </p>
  );
}
