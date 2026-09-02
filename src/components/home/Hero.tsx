import Image from "next/image";
import Link from "next/link";
import { ORDER_CONFIG, RESTAURANT } from "@/lib/config";
import { LogoBadge } from "@/components/ui/Logo";

/**
 * Editoriálne hero: krémový typografický blok vľavo, veľká fotka vpravo,
 * bordový pás s claimom a šachovnicové detaily — priamy preklad brand boardu.
 */
export function Hero() {
  return (
    <section aria-labelledby="hero-heading" className="relative overflow-hidden bg-cream">
      <div className="container-enzo">
        <div className="grid items-stretch gap-0 lg:grid-cols-[1.02fr_1fr]">
          {/* Typografický blok */}
          <div className="relative z-10 flex flex-col justify-center py-12 sm:py-16 lg:py-24 lg:pr-12">
            <p className="eyebrow flex items-center gap-3 text-burgundy opacity-0 [animation:reveal_0.7s_cubic-bezier(0.16,1,0.3,1)_0.05s_both]">
              <span
                aria-hidden
                className="checkerboard h-2.5 w-10 text-burgundy"
                style={{ ["--checker-size" as string]: "0.625rem" }}
              />
              {RESTAURANT.since} · {RESTAURANT.place}
            </p>

            <h1
              id="hero-heading"
              className="mt-5 font-slab text-[4.2rem] leading-[0.92] text-burgundy opacity-0 [animation:reveal_0.75s_cubic-bezier(0.16,1,0.3,1)_0.12s_both] sm:text-[6rem] lg:text-[6.8rem] xl:text-[7.6rem]"
            >
              Enzo
              <span className="sr-only"> — Smash Burgers &amp; Pizza</span>
            </h1>

            <p
              aria-hidden
              className="mt-3 flex items-center gap-3 font-sans text-[0.8rem] font-extrabold tracking-[0.24em] text-ink uppercase opacity-0 [animation:reveal_0.7s_cubic-bezier(0.16,1,0.3,1)_0.2s_both] sm:text-[1rem] sm:tracking-[0.3em]"
            >
              <span
                className="checkerboard h-3 w-9 shrink-0 text-burgundy"
                style={{ ["--checker-size" as string]: "0.75rem" }}
              />
              Smash Burgers &amp; Pizza
              <span
                className="checkerboard h-3 w-9 shrink-0 text-burgundy"
                style={{ ["--checker-size" as string]: "0.75rem" }}
              />
            </p>

            <p className="mt-8 max-w-md text-[1.05rem] leading-relaxed text-ink/65 opacity-0 [animation:reveal_0.7s_cubic-bezier(0.16,1,0.3,1)_0.28s_both] sm:text-[1.15rem]">
              Poctivý smash burger, pizza z vlastného cesta a domáce hranolky.
              Smashujeme čerstvo. Servírujeme horúce.{" "}
              <strong className="font-bold text-burgundy">Žiadne kompromisy.</strong>
            </p>

            <div className="mt-9 flex flex-col gap-3 opacity-0 [animation:reveal_0.7s_cubic-bezier(0.16,1,0.3,1)_0.36s_both] sm:flex-row sm:gap-4">
              <Link
                href="/#menu"
                className="inline-flex h-14 items-center justify-center rounded-full bg-burgundy px-8 font-sans text-[0.85rem] font-extrabold tracking-[0.14em] text-cream uppercase shadow-[0_2px_0_0_var(--color-burgundy-900)] transition-colors hover:bg-burgundy-700 sm:h-16 sm:px-10"
              >
                Objednať teraz
              </Link>
              <Link
                href="/#menu"
                className="inline-flex h-14 items-center justify-center rounded-full border-2 border-ink/80 px-8 font-sans text-[0.85rem] font-extrabold tracking-[0.14em] text-ink uppercase transition-colors hover:bg-ink hover:text-cream sm:h-16 sm:px-10"
              >
                Pozrieť menu
              </Link>
            </div>

            <dl className="mt-10 flex flex-wrap gap-x-8 gap-y-4 opacity-0 [animation:reveal_0.7s_cubic-bezier(0.16,1,0.3,1)_0.44s_both]">
              {[
                { k: "Osobný odber", v: ORDER_CONFIG.estimatedTimePickup },
                { k: "Rozvoz", v: ORDER_CONFIG.estimatedTimeDelivery },
                { k: "Smashujeme", v: "100 % hovädzie" },
              ].map((s) => (
                <div key={s.k}>
                  <dt className="eyebrow text-ink/40">{s.k}</dt>
                  <dd className="mt-1 font-display text-[1.05rem] whitespace-nowrap text-ink">{s.v}</dd>
                </div>
              ))}
            </dl>
          </div>

          {/* Fotka */}
          <div className="relative -mx-5 min-h-[22rem] sm:-mx-8 lg:mx-0 lg:min-h-[42rem]">
            <div className="relative h-full min-h-[22rem] w-full overflow-hidden bg-ink lg:min-h-[42rem]">
              <Image
                src="/images/editorial/hero-burger.webp"
                alt="Smash burger ENZO s dvojitým cheddarom, slaninou a nakladanými uhorkami"
                fill
                priority
                sizes="(max-width: 1024px) 100vw, 50vw"
                className="scale-105 object-cover object-center opacity-0 [animation:fade-in_0.9s_ease-out_0.1s_both]"
              />
              <div
                aria-hidden
                className="absolute inset-0 bg-gradient-to-t from-ink/70 via-ink/10 to-transparent lg:bg-gradient-to-r lg:from-ink/45 lg:via-transparent lg:to-ink/25"
              />

              {/* Kruhový odznak z packagingu */}
              <LogoBadge className="absolute top-6 right-6 w-24 text-[6rem] opacity-0 [animation:pop_0.5s_cubic-bezier(0.34,1.56,0.64,1)_0.55s_both] sm:top-8 sm:right-8 sm:w-32 sm:text-[8rem] lg:w-36 lg:text-[9rem]" />

              {/* Claim */}
              <p className="absolute bottom-6 left-5 max-w-[16rem] font-display text-[1.6rem] leading-[0.95] text-cream opacity-0 [animation:reveal_0.7s_cubic-bezier(0.16,1,0.3,1)_0.6s_both] sm:bottom-8 sm:left-8 sm:text-[2.1rem]">
                <span className="whitespace-nowrap">Good burgers.</span>
                <br />
                <span className="whitespace-nowrap text-gold">No bullshit.</span>
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Bežiaci bordový pás */}
      <Marquee />
    </section>
  );
}

const MARQUEE_ITEMS = [
  "SMASHED FRESH. SERVED HOT.",
  "DOUBLE IS BETTER.",
  "BURGER AJ PIZZA.",
  "GET SMASHED.",
  "MEET THE ENZO.",
  "SMASHED IN KONIAROVCE.",
  "GOOD BURGERS. NO BULLSHIT.",
];

function Marquee() {
  const items = [...MARQUEE_ITEMS, ...MARQUEE_ITEMS];
  return (
    <div className="relative overflow-hidden bg-burgundy py-3.5 sm:py-4">
      <div
        aria-hidden
        className="flex w-max items-center gap-10 whitespace-nowrap will-change-transform motion-reduce:animate-none"
        style={{ animation: "marquee 34s linear infinite" }}
      >
        {items.map((t, i) => (
          <span key={i} className="flex items-center gap-10">
            <span className="font-display text-[0.95rem] text-cream sm:text-[1.15rem]">{t}</span>
            <span
              className="checkerboard h-3 w-8 shrink-0 text-gold"
              style={{ ["--checker-size" as string]: "0.75rem" }}
            />
          </span>
        ))}
      </div>
      <span className="sr-only">{RESTAURANT.tagline}</span>
    </div>
  );
}
