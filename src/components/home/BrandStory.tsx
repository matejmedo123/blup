import Image from "next/image";
import { RESTAURANT } from "@/lib/config";
import { Reveal } from "@/components/ui/Reveal";
import { CheckerRule } from "@/components/ui/Checkerboard";

const VALUES = [
  {
    title: "Čerstvosť",
    text: "Každý burger smažíme čerstvo až na objednávku. Nič nestojí pod lampou.",
  },
  {
    title: "Kvalita",
    text: "Používame kvalitné suroviny bez kompromisov. 100 % hovädzie, brioška každý deň.",
  },
  {
    title: "Poctivosť",
    text: "Žiadne polotovary. Len poctivá práca a omáčky, ktoré si robíme sami.",
  },
  {
    title: "Atmosféra",
    text: "Miesto, kam sa chceš vrátiť. Hlasná hudba, teplé svetlo, dobré jedlo.",
  },
];

const PACKAGING = [
  { src: "/images/brand/pack-wrap.webp", label: "Wrap papier" },
  { src: "/images/brand/pack-fries.webp", label: "Krabička na hranolky" },
  { src: "/images/brand/pack-cup.webp", label: "Pohár" },
  { src: "/images/brand/pack-box.webp", label: "Krabička na burger" },
  { src: "/images/brand/pack-sauces.webp", label: "Omáčky" },
  { src: "/images/brand/pack-bag.webp", label: "Taška" },
];

export function BrandStory() {
  return (
    <section id="o-nas" aria-labelledby="o-nas-heading" className="bg-burgundy text-cream">
      <CheckerRule className="text-cream" size="0.75rem" />

      <div className="container-enzo py-16 lg:py-24">
        {/* Úvod */}
        <div className="grid gap-10 lg:grid-cols-[1fr_1.1fr] lg:gap-16">
          <Reveal>
            <p className="eyebrow text-gold">O značke</p>
            <h2
              id="o-nas-heading"
              className="mt-5 font-display text-[2.8rem] leading-[1.02] sm:text-[4rem] lg:text-[4.75rem]"
            >
              Smashujeme
              <br />
              čerstvo.
              <br />
              <span className="text-gold">Servírujeme horúce.</span>
            </h2>
            <p className="mt-7 max-w-md text-[1rem] leading-relaxed text-cream/75 sm:text-[1.05rem]">
              ENZO je miesto pre poctivý smash burger, chrumkavé hranolky a dobrú
              atmosféru. Mäso prilepíme na rozpálenú platňu a stlačíme — vznikne
              kôrka, ktorá robí smash burger smash burgerom.
            </p>
            <p className="mt-4 max-w-md text-[1rem] leading-relaxed text-cream/75">
              Žiadne kompromisy, žiadne skratky. Otvorili sme v{" "}
              {RESTAURANT.placeLocative} a robíme presne to, čo vieme robiť najlepšie.
            </p>
            <p className="mt-8 font-display text-[1.9rem] leading-none text-gold sm:text-[2.4rem]">
              {RESTAURANT.claim}
            </p>
          </Reveal>

          <Reveal delay={120} className="relative">
            <div className="relative aspect-4/3 w-full overflow-hidden rounded-2xl bg-ink lg:aspect-3/2">
              <Image
                src="/images/editorial/story-duo.webp"
                alt="Dva ENZO smash burgery servírované na tmavom stole"
                fill
                loading="lazy"
                sizes="(max-width: 1024px) 100vw, 55vw"
                className="object-cover"
              />
            </div>
            <div className="absolute -bottom-5 -left-3 hidden rounded-xl bg-gold px-5 py-4 sm:block lg:-left-6">
              <p className="font-display text-[1.4rem] leading-none text-ink">Double is better.</p>
            </div>
          </Reveal>
        </div>

        {/* Hodnoty */}
        <div className="mt-16 border-t border-cream/15 pt-12 lg:mt-24 lg:pt-16">
          <h3 className="eyebrow text-cream/50">Naše hodnoty</h3>
          <ul className="mt-7 grid gap-x-8 gap-y-9 sm:grid-cols-2 lg:grid-cols-4">
            {VALUES.map((v, i) => (
              <Reveal as="li" key={v.title} delay={i * 90}>
                <span
                  aria-hidden
                  className="checkerboard block h-2.5 w-9 text-gold"
                  style={{ ["--checker-size" as string]: "0.625rem" }}
                />
                <h4 className="mt-5 font-display text-[1.5rem] leading-none">{v.title}</h4>
                <p className="mt-2.5 text-[0.9rem] leading-relaxed text-cream/65">{v.text}</p>
              </Reveal>
            ))}
          </ul>
        </div>

        {/* Balenie */}
        <div className="mt-16 border-t border-cream/15 pt-12 lg:mt-24 lg:pt-16">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h3 className="eyebrow text-cream/50">Balenie</h3>
              <p className="mt-3 max-w-lg font-display text-[1.7rem] leading-[1.05] sm:text-[2.2rem]">
                Zabalené tak, aby dorazilo horúce
              </p>
            </div>
            <p className="max-w-sm text-[0.88rem] text-cream/60">
              Vlastný wrap papier, mastnotu-odolné krabičky a izolovaná taška —
              každá objednávka odchádza v ENZO balení.
            </p>
          </div>

          <ul className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6 lg:gap-4">
            {PACKAGING.map((p, i) => (
              <Reveal as="li" key={p.src} delay={i * 60}>
                <figure className="group">
                  <div className="relative aspect-square overflow-hidden rounded-xl bg-cream-200">
                    <Image
                      src={p.src}
                      alt={`ENZO ${p.label.toLowerCase()}`}
                      fill
                      loading="lazy"
                      sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 16vw"
                      className="object-cover transition-transform duration-500 group-hover:scale-105 motion-reduce:group-hover:scale-100"
                    />
                  </div>
                  <figcaption className="mt-2 text-[0.7rem] font-bold tracking-[0.1em] text-cream/55 uppercase">
                    {p.label}
                  </figcaption>
                </figure>
              </Reveal>
            ))}
          </ul>
        </div>
      </div>

      <CheckerRule className="text-cream" size="0.75rem" />
    </section>
  );
}
