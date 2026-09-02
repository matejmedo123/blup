import { ORDER_CONFIG } from "@/lib/config";
import { formatPrice } from "@/lib/format";
import { Reveal } from "@/components/ui/Reveal";

const STEPS = [
  {
    n: "01",
    title: "Vyber si",
    text: "Prejdi menu, otvor produkt a prispôsob si ho. Extra porcia, horúci chedar, jalapeños — je to na tebe.",
  },
  {
    n: "02",
    title: "Odber alebo doručenie",
    text: "V pokladni si zvolíš osobný odber alebo doručenie domov. Doručujeme po Koniarovciach a okolí.",
  },
  {
    n: "03",
    title: "Zaplať",
    text: "Kartou online alebo v hotovosti pri prevzatí. Nič viac riešiť nemusíš.",
  },
  {
    n: "04",
    title: "Smashujeme",
    text: "Objednávku pustíme na platňu a do pece až keď dorazí. Preto je vždy horúca a čerstvá.",
  },
];

export function HowItWorks() {
  return (
    <section
      id="ako-to-funguje"
      aria-labelledby="ako-heading"
      className="bg-cream py-16 lg:py-24"
    >
      <div className="container-enzo">
        <Reveal className="max-w-2xl">
          <p className="eyebrow text-burgundy">Ako to funguje</p>
          <h2
            id="ako-heading"
            className="mt-5 font-display text-[2.2rem] leading-[1.05] text-ink sm:text-[3rem] lg:text-[3.5rem]"
          >
            Štyri kroky
            <br />k horúcemu jedlu
          </h2>
        </Reveal>

        <ol className="mt-12 grid gap-px overflow-hidden rounded-2xl bg-ink/10 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s, i) => (
            <Reveal as="li" key={s.n} delay={i * 90} className="h-full">
              <div className="flex h-full flex-col bg-cream p-6 transition-colors duration-300 hover:bg-white lg:p-8">
                <span className="font-display text-[3.2rem] leading-none text-burgundy/22 tabular-nums lg:text-[4rem]">
                  {s.n}
                </span>
                <h3 className="mt-4 font-display text-[1.2rem] leading-[1.1] text-ink lg:text-[1.35rem]">
                  {s.title}
                </h3>
                <p className="mt-3 text-[0.9rem] leading-relaxed text-ink/60">{s.text}</p>
              </div>
            </Reveal>
          ))}
        </ol>

        <Reveal delay={120}>
          <ul className="mt-10 grid gap-3 sm:grid-cols-3">
            {[
              { k: "Minimálna objednávka", v: formatPrice(ORDER_CONFIG.minOrder) },
              {
                k: "Doručenie",
                v: `${formatPrice(ORDER_CONFIG.deliveryFee)} · zdarma od ${formatPrice(ORDER_CONFIG.freeDeliveryFrom)}`,
              },
              { k: "Čas doručenia", v: ORDER_CONFIG.estimatedTimeDelivery },
            ].map((item) => (
              <li
                key={item.k}
                className="flex flex-col gap-1 rounded-xl border border-ink/10 bg-white/60 px-5 py-4"
              >
                <span className="eyebrow text-ink/45">{item.k}</span>
                <span className="font-display text-[1.35rem] leading-none text-burgundy">
                  {item.v}
                </span>
              </li>
            ))}
          </ul>
        </Reveal>
      </div>
    </section>
  );
}
