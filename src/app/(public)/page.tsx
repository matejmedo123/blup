import type { Metadata } from "next";

import { ButtonLink } from "@/components/ui/Button";
import { PhotoSlot } from "@/components/ui/Card";

export const metadata: Metadata = {
  title: "CREW. — ľudia, ktorí držia event v pohybe",
  description:
    "Nájdi smenu, odpracuj ju, dostaň zaplatené. Bez telefonátov, bez excelu, bez chaosu za pódiom.",
};

const PATHWAYS = [
  {
    eyebrow: "Brigáda",
    title: "Zarábaj na eventoch.",
    body: "Bar, vstupy, produkcia. Vidíš sadzbu aj čas dopredu, výplatu máš do 14 dní.",
    cta: "Pozrieť smeny",
    href: "/brigada",
    photo: "foto — barman v akcii",
    tone: "light" as const,
  },
  {
    eyebrow: "Dobrovoľník",
    title: "Buď súčasťou eventu.",
    body: "Odpracuj si vstup. Zázemie, jedlo a crew, ktorá sa neskôr hodí.",
    cta: "Prihlásiť sa",
    href: "/dobrovolnik",
    photo: "foto — dobrovoľníci pri stage",
    tone: "dark" as const,
  },
  {
    eyebrow: "Stánok",
    title: "Ukáž svoj brand.",
    body: "Prihláška, miesto, energia, povolenia. Všetko na jednom mieste.",
    cta: "Podať prihlášku",
    href: "/stanok",
    photo: "foto — food stánok večer",
    tone: "outline" as const,
  },
];

const STEPS = [
  { n: "01", title: "Prihlás sa", body: "Profil vyplníš raz. Šesť krokov, dve minúty." },
  { n: "02", title: "Dostaneš smenu", body: "Pozícia, čas, miesto a sadzba. Potvrdíš jedným ťuknutím." },
  { n: "03", title: "Príď a zarob", body: "Check-in v appke, hodiny sa rátajú samé, výplata sedí." },
];

const BENEFITS = [
  {
    title: "Jedna appka namiesto piatich skupín",
    body: "Smeny, správy aj dochádzka na jednom mieste.",
  },
  {
    title: "Crew Score, ktorý niečo znamená",
    body: "Spoľahliví ľudia dostávajú lepšie smeny. Bez hviezdičiek a odznakov.",
  },
  {
    title: "Hodiny, ktoré netreba dohadovať",
    body: "Check-in a check-out vytvoria podklad pre výplatu automaticky.",
  },
];

const STATS = [
  { value: "340", label: "odbavených eventov" },
  { value: "12 400", label: "odpracovaných hodín" },
  { value: "96 %", label: "obsadenosť smien", accent: true },
  { value: "€1,2 M", label: "vyplatené crew" },
];

export default function LandingPage() {
  return (
    <>
      {/* ---------------------------------------------------------------- hero */}
      <section className="bg-ink px-5 pt-16 text-white lg:px-8 lg:pt-24">
        <div className="mx-auto max-w-[1240px]">
          <div className="grid items-end gap-10 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:gap-16">
            <div>
              <p className="mb-6 text-xs font-semibold tracking-[0.16em] text-accent uppercase lg:mb-7">
                Eventová crew platforma
              </p>
              <h1 className="mb-7 text-[40px] leading-[0.96] font-extrabold tracking-[-0.045em] sm:text-[56px] lg:text-[76px]">
                Ľudia, ktorí
                <br />
                držia event
                <br />
                v pohybe<span className="text-accent">.</span>
              </h1>
              <p className="mb-8 max-w-[460px] text-[17px] leading-[1.55] text-white/62 lg:mb-10 lg:text-lg">
                Nájdi smenu, odpracuj ju, dostaň zaplatené. Bez telefonátov, bez excelu, bez chaosu
                za pódiom.
              </p>
              <div className="mb-10 flex flex-wrap gap-3 lg:mb-14">
                <ButtonLink href="/brigada/registracia" variant="accent" size="lg">
                  Nájsť brigádu
                </ButtonLink>
                <ButtonLink href="/pre-organizatorov" variant="onDark" size="lg">
                  Som organizátor
                </ButtonLink>
              </div>
            </div>
            <PhotoSlot
              caption="foto — crew v backstage"
              tone="dark"
              className="mb-10 h-[240px] rounded-20 p-5 lg:mb-14 lg:h-[380px]"
            />
          </div>
          <PhotoSlot
            caption="foto — festivalový dav, široký záber"
            tone="dark"
            className="h-[180px] rounded-t-20 p-[22px] lg:h-[260px]"
          />
        </div>
      </section>

      {/* ------------------------------------------------------------ pathways */}
      <section id="pathways" className="px-5 py-16 lg:px-8 lg:py-[104px]">
        <div className="mx-auto max-w-[1240px]">
          <h2 className="mb-3 text-[28px] leading-[1.05] font-extrabold tracking-[-0.035em] lg:text-[40px]">
            Tri spôsoby, ako byť pri tom.
          </h2>
          <p className="mb-10 text-[17px] text-muted lg:mb-12">
            Vyber si, prečo prichádzaš. Zvyšok vybavíme za teba.
          </p>

          <div className="grid gap-5 lg:grid-cols-3">
            {PATHWAYS.map((card) => {
              const dark = card.tone === "dark";
              return (
                <article
                  key={card.href}
                  className={
                    "flex flex-col rounded-20 p-3.5 pb-6 " +
                    (dark ? "bg-ink text-white" : "border border-line bg-surface")
                  }
                >
                  <PhotoSlot
                    caption={card.photo}
                    tone={dark ? "dark" : "light"}
                    className="h-[200px] rounded-14 lg:h-[260px]"
                  />
                  <div className="flex flex-1 flex-col gap-2.5 px-2.5 pt-6">
                    <span
                      className={
                        "text-[11px] font-bold tracking-[0.14em] uppercase " +
                        (dark ? "text-accent" : "text-muted")
                      }
                    >
                      {card.eyebrow}
                    </span>
                    <h3 className="text-[22px] font-bold tracking-[-0.03em] lg:text-[26px]">
                      {card.title}
                    </h3>
                    <p
                      className={
                        "mb-5 text-[15px] leading-[1.55] " + (dark ? "text-white/60" : "text-muted")
                      }
                    >
                      {card.body}
                    </p>
                    <ButtonLink
                      href={card.href}
                      variant={dark ? "accent" : card.tone === "outline" ? "outline" : "dark"}
                      className="mt-auto self-start"
                    >
                      {card.cta}
                    </ButtonLink>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      {/* --------------------------------------------------------- ako to ide */}
      <section id="ako-to-funguje" className="scroll-mt-20 px-5 pb-16 lg:px-8 lg:pb-[104px]">
        <div className="mx-auto max-w-[1240px] border-t border-[rgba(17,17,17,0.1)] pt-12 lg:pt-16">
          <h2 className="mb-10 text-[28px] font-extrabold tracking-[-0.035em] lg:mb-14 lg:text-[40px]">
            Ako to funguje
          </h2>
          <div className="grid gap-10 lg:grid-cols-3 lg:gap-12">
            {STEPS.map((step) => (
              <div key={step.n}>
                <div
                  className="text-[52px] leading-none font-extrabold tracking-[-0.05em] text-accent lg:text-[64px]"
                  style={{ WebkitTextStroke: "1px rgba(17,17,17,.18)" }}
                >
                  {step.n}
                </div>
                <h3 className="mt-5 mb-2 text-[22px] font-bold tracking-[-0.03em] lg:text-2xl">
                  {step.title}
                </h3>
                <p className="text-[15px] leading-[1.6] text-muted">{step.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------- prečo CREW */}
      <section id="preco-crew" className="scroll-mt-20 px-5 pb-16 lg:px-8 lg:pb-[104px]">
        <div className="mx-auto grid max-w-[1240px] items-center gap-10 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] lg:gap-16">
          <PhotoSlot
            caption="foto — koordinátorka s vysielačkou"
            className="h-[260px] rounded-20 p-5 lg:h-[460px]"
          />
          <div>
            <h2 className="mb-7 text-[28px] leading-[1.08] font-extrabold tracking-[-0.035em] lg:mb-8 lg:text-[40px]">
              Prečo CREW.
            </h2>
            <div className="flex flex-col gap-6">
              {BENEFITS.map((benefit) => (
                <div key={benefit.title} className="grid grid-cols-[28px_minmax(0,1fr)] items-start gap-4">
                  <span className="mt-2 block size-2.5 rounded-[3px] bg-accent" aria-hidden />
                  <div>
                    <h3 className="mb-1.5 text-[19px] font-semibold tracking-[-0.02em]">
                      {benefit.title}
                    </h3>
                    <p className="text-[15px] leading-[1.6] text-muted">{benefit.body}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- čísla */}
      <section className="bg-ink px-5 py-14 text-white lg:px-8 lg:py-20">
        <div className="mx-auto grid max-w-[1240px] grid-cols-2 gap-8 lg:grid-cols-4">
          {STATS.map((stat) => (
            <div key={stat.label}>
              <div
                className={
                  "text-[38px] leading-none font-extrabold tracking-[-0.05em] lg:text-[56px] " +
                  (stat.accent ? "text-accent" : "")
                }
              >
                {stat.value}
              </div>
              <div className="mt-2.5 text-sm text-white/55">{stat.label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ------------------------------------------------------------- záver CTA */}
      <section className="px-5 py-16 lg:px-8 lg:py-[104px]">
        <div className="mx-auto flex max-w-[1240px] flex-wrap items-center gap-8 rounded-28 bg-accent px-5 py-10 sm:px-7 sm:py-12 lg:gap-12 lg:px-16 lg:py-20">
          <h2 className="min-w-0 flex-1 text-[28px] leading-[1.02] font-extrabold tracking-[-0.04em] sm:min-w-[280px] sm:text-[32px] lg:text-[52px]">
            Najbližší event
            <br />
            už zháňa ľudí.
          </h2>
          <div className="flex flex-wrap gap-3">
            <ButtonLink href="/brigada/registracia" variant="dark" size="lg">
              Chcem robiť
            </ButtonLink>
            <ButtonLink href="/pre-organizatorov" variant="onAccent" size="lg">
              Hľadám crew
            </ButtonLink>
          </div>
        </div>
      </section>
    </>
  );
}
