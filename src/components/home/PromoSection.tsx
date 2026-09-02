import Image from "next/image";
import Link from "next/link";
import { Reveal } from "@/components/ui/Reveal";

const TILES = [
  {
    src: "/images/editorial/promo-combo.webp",
    alt: "ENZO burger s hranolkami a nápojom",
    title: "Double is better.",
    text: "Pridaj extra porciu mäsa a rozdiel pocítiš hneď pri prvom hryzení.",
    tone: "gold" as const,
  },
  {
    src: "/images/editorial/dark-burger.webp",
    alt: "Detail smash burgera na tmavom pozadí",
    title: "Meet the Enzo.",
    text: "Náš signature smash burger. Chedar, ENZO omáčka, žiadne kompromisy.",
    tone: "cream" as const,
  },
  {
    src: "/images/editorial/promo-pizza.webp",
    alt: "Pizza s ťahajúcou sa mozzarellou",
    title: "Burger aj pizza.",
    text: "Dvanásť druhov pizze z vlastného cesta — v tej istej objednávke.",
    tone: "burgundy" as const,
  },
];

export function PromoSection() {
  return (
    <section aria-labelledby="promo-heading" className="bg-ink py-16 text-cream lg:py-24">
      <div className="container-enzo">
        <Reveal className="flex flex-wrap items-end justify-between gap-6">
          <div>
            <p className="eyebrow text-gold">Sociálne siete</p>
            <h2
              id="promo-heading"
              className="mt-5 font-display text-[2.2rem] leading-[1.05] sm:text-[3.2rem]"
            >
              Smashed daily
            </h2>
          </div>
          <Link
            href="/#menu"
            className="inline-flex h-13 items-center rounded-full border-2 border-cream/70 px-7 font-sans text-[0.78rem] font-extrabold tracking-[0.14em] text-cream uppercase transition-colors hover:bg-cream hover:text-ink"
          >
            Objednať
          </Link>
        </Reveal>

        <ul className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {TILES.map((t, i) => (
            <Reveal as="li" key={t.title} delay={i * 100} className="h-full">
              <article className="group relative flex h-full min-h-[22rem] flex-col justify-end overflow-hidden rounded-2xl">
                <Image
                  src={t.src}
                  alt={t.alt}
                  fill
                  loading="lazy"
                  sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
                  className="object-cover transition-transform duration-700 ease-out group-hover:scale-105 motion-reduce:group-hover:scale-100"
                />
                <div
                  aria-hidden
                  className="absolute inset-0 bg-gradient-to-t from-ink via-ink/55 to-transparent"
                />
                <div className="relative p-6">
                  <span
                    aria-hidden
                    className={
                      "checkerboard block h-2.5 w-9 " +
                      (t.tone === "gold"
                        ? "text-gold"
                        : t.tone === "burgundy"
                          ? "text-burgundy-500"
                          : "text-cream")
                    }
                    style={{ ["--checker-size" as string]: "0.625rem" }}
                  />
                  <h3 className="mt-3 font-display text-[2rem] leading-none">{t.title}</h3>
                  <p className="mt-2 max-w-xs text-[0.9rem] leading-relaxed text-cream/70">
                    {t.text}
                  </p>
                </div>
              </article>
            </Reveal>
          ))}
        </ul>
      </div>
    </section>
  );
}
