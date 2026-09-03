"use client";

import { useMenu } from "@/context/MenuContext";
import { ClockIcon } from "@/components/ui/Icons";
import { RESTAURANT } from "@/lib/config";

/**
 * Pruh, ktorý povie, že sa práve nedá objednať.
 *
 * Bez neho by si zákazník naplnil košík, prešiel celú pokladňu a až na
 * konci by mu server povedal, že máme zatvorené. Stav aj text určuje
 * server podľa otváracích hodín — web ho len zobrazuje.
 */
export function ClosedBanner() {
  const { open, live } = useMenu();

  // Kým sa server neozve, nič nesľubujeme ani nestrašíme.
  if (!live || open.now) return null;

  return (
    <div role="status" className="bg-ink text-cream">
      <div className="container-enzo flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:gap-5">
        <span
          aria-hidden
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gold text-ink"
        >
          <ClockIcon className="h-5 w-5" />
        </span>

        <div className="min-w-0 flex-1">
          <p className="font-display text-[1.15rem] leading-[1.1] sm:text-[1.3rem]">
            Teraz neprijímame objednávky
          </p>
          <p className="mt-1 text-[0.88rem] leading-relaxed text-cream/75">
            {open.reason || "Skús to prosím neskôr."}
          </p>
        </div>

        <a
          href={`tel:${RESTAURANT.phone.replace(/\s/g, "")}`}
          className="inline-flex h-12 shrink-0 items-center justify-center rounded-full bg-cream px-6 font-sans text-[0.75rem] font-extrabold tracking-[0.12em] text-ink uppercase transition-colors hover:bg-gold"
        >
          Zavolať {RESTAURANT.phone}
        </a>
      </div>
    </div>
  );
}
