import type { Metadata } from "next";

import { ButtonLink } from "@/components/ui/Button";
import { Card, PhotoSlot } from "@/components/ui/Card";
import { getPublicEvent } from "@/lib/domain/events";
import { formatDateLong } from "@/lib/format";

export const metadata: Metadata = {
  title: "Chcem brigádovať",
  description: "Zarob si na eventoch. Vyber si pozíciu, sleduj svoje smeny a zárobok.",
};

const FAQ = [
  {
    q: "Kedy dostanem zaplatené?",
    a: "Podklad pre výplatu vzniká automaticky z check-inu a check-outu. Peniaze posielame do 14 dní po skončení eventu.",
  },
  {
    q: "Musím prísť na každú smenu, ktorú mi pridelíte?",
    a: "Nie. Každú pridelenú smenu musíš najprv potvrdiť. Ak nemôžeš, klikneš „Nemôžem prísť“ a nájdeme náhradu.",
  },
  {
    q: "Čo je Crew Score?",
    a: "Číslo od 0 do 100, ktoré rastie za spoľahlivosť a dochvíľnosť. Vyššie skóre znamená lepší výber smien. Žiadne odznaky ani hviezdičky.",
  },
  {
    q: "Potrebujem skúsenosti?",
    a: "Aspoň jednu pracovnú skúsenosť do prihlášky áno — nemusí byť z eventu. Na väčšinu pozícií zaškolíme na mieste.",
  },
];

export default async function BrigadePage() {
  const event = await getPublicEvent();

  return (
    <>
      <section className="bg-ink px-5 pt-14 pb-16 text-white lg:px-8 lg:pt-20 lg:pb-24">
        <div className="mx-auto grid max-w-[1240px] items-end gap-10 lg:grid-cols-[1.15fr_0.85fr] lg:gap-16">
          <div>
            <p className="mb-6 text-xs font-semibold tracking-[0.16em] text-accent uppercase">
              Brigáda
            </p>
            <h1 className="mb-6 text-[40px] leading-[0.98] font-extrabold tracking-[-0.045em] lg:text-[64px]">
              Zarábaj na
              <br />
              eventoch<span className="text-accent">.</span>
            </h1>
            <p className="mb-9 max-w-[460px] text-[17px] leading-[1.55] text-white/62 lg:text-lg">
              Vyber si pozíciu, sleduj svoje smeny a zárobok. Bar, vstupy, produkcia — vidíš sadzbu
              aj čas dopredu.
            </p>
            <div className="flex flex-wrap gap-3">
              <ButtonLink href="/brigada/registracia" variant="accent" size="lg">
                Prihlásiť sa na brigádu
              </ButtonLink>
              <ButtonLink href="/brigada/prihlasenie" variant="onDark" size="lg">
                Už mám účet
              </ButtonLink>
            </div>
          </div>
          <PhotoSlot
            caption="foto — barman v akcii"
            tone="dark"
            className="h-[240px] rounded-20 p-5 lg:h-[380px]"
          />
        </div>
      </section>

      <section className="px-5 py-14 lg:px-8 lg:py-20">
        <div className="mx-auto max-w-[1240px]">
          {event ? (
            <Card className="mb-12 flex flex-wrap items-center gap-6 p-6 lg:p-8">
              <div className="min-w-0 flex-1">
                <p className="eyebrow text-muted">Práve naberáme na</p>
                <h2 className="mt-2 text-[26px] font-extrabold tracking-[-0.035em]">{event.name}</h2>
                <p className="mt-1.5 text-[15px] text-muted">
                  {formatDateLong(`${event.startDate}T12:00:00Z`, event.timezone)} —{" "}
                  {formatDateLong(`${event.endDate}T12:00:00Z`, event.timezone)}
                  {event.location ? ` · ${event.location}` : ""}
                </p>
              </div>
              <ButtonLink href="/brigada/registracia">Podať prihlášku</ButtonLink>
            </Card>
          ) : null}

          <h2 className="mb-8 text-[28px] font-extrabold tracking-[-0.035em] lg:text-[40px]">
            Časté otázky
          </h2>
          <div className="grid gap-5 lg:grid-cols-2">
            {FAQ.map((item) => (
              <Card key={item.q} className="p-6">
                <h3 className="text-[19px] font-bold tracking-[-0.02em]">{item.q}</h3>
                <p className="mt-2.5 text-[15px] leading-[1.6] text-muted">{item.a}</p>
              </Card>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
