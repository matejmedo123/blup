import Image from "next/image";
import { RESTAURANT } from "@/lib/config";
import { Reveal } from "@/components/ui/Reveal";
import { CheckerRule } from "@/components/ui/Checkerboard";

const VALUES = [
  {
    title: "Čerstvosť",
    text: "Každý burger smažíme a každú pizzu pečieme až na objednávku. Nič nestojí pod lampou.",
  },
  {
    title: "Kvalita",
    text: "Kvalitné suroviny bez kompromisov. 100 % hovädzie, brioška a cesto každý deň.",
  },
  {
    title: "Poctivosť",
    text: "Žiadne polotovary. Len poctivá práca, domáce stripsy a omáčky, ktoré si robíme sami.",
  },
  {
    title: "Atmosféra",
    text: "Miesto, kam sa chceš vrátiť — a keď nestíhaš, dovezieme ti to domov.",
  },
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
              className="mt-5 font-display text-[2.4rem] leading-[1.02] sm:text-[3.2rem] lg:text-[3.8rem]"
            >
              Smashujeme
              <br />
              čerstvo.
              <br />
              <span className="text-gold">Pečieme horúce.</span>
            </h2>
            <p className="mt-7 max-w-md text-[1rem] leading-relaxed text-cream/75 sm:text-[1.05rem]">
              ENZO je miesto pre poctivý smash burger, pizzu z vlastného cesta a dobrú
              atmosféru. Mäso prilepíme na rozpálenú platňu a stlačíme — vznikne kôrka,
              ktorá robí smash burger smash burgerom.
            </p>
            <p className="mt-4 max-w-md text-[1rem] leading-relaxed text-cream/75">
              Žiadne kompromisy, žiadne skratky. Otvorili sme v{" "}
              {RESTAURANT.placeLocative} a rozvážame do celého okolia.
            </p>
            <p className="mt-8 font-display text-[1.5rem] leading-[1.1] text-gold sm:text-[2rem]">
              Good burgers.
              <br />
              No bullshit.
            </p>
          </Reveal>

          <Reveal delay={120} className="relative">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="relative aspect-4/5 w-full overflow-hidden rounded-2xl bg-ink sm:mt-8">
                <Image
                  src="/images/editorial/story-duo.webp"
                  alt="Dva ENZO smash burgery servírované na tmavom stole"
                  fill
                  loading="lazy"
                  sizes="(max-width: 640px) 100vw, 28vw"
                  className="object-cover"
                />
              </div>
              <div className="relative aspect-4/5 w-full overflow-hidden rounded-2xl bg-ink">
                <Image
                  src="/images/editorial/promo-pizza.webp"
                  alt="Horúca pizza s ťahajúcou sa mozzarellou"
                  fill
                  loading="lazy"
                  sizes="(max-width: 640px) 100vw, 28vw"
                  className="object-cover"
                />
              </div>
            </div>
            <div className="mt-5 inline-flex rounded-xl bg-gold px-5 py-4">
              <p className="font-display text-[1.15rem] leading-none text-ink">
                Burger aj pizza. Jedna objednávka.
              </p>
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
                <h4 className="mt-5 font-display text-[1.25rem] leading-[1.1]">{v.title}</h4>
                <p className="mt-2.5 text-[0.9rem] leading-relaxed text-cream/65">{v.text}</p>
              </Reveal>
            ))}
          </ul>
        </div>
      </div>

      <CheckerRule className="text-cream" size="0.75rem" />
    </section>
  );
}
