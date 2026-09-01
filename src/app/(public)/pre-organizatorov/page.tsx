import type { Metadata } from "next";

import { ButtonLink } from "@/components/ui/Button";
import { Card, PhotoSlot } from "@/components/ui/Card";

export const metadata: Metadata = {
  title: "Pre organizátorov",
  description: "Command center pre nábor, smeny, dochádzku a mzdy na evente.",
};

const FEATURES = [
  {
    title: "Nábor bez tabuliek",
    body: "Prihlášky brigádnikov, dobrovoľníkov aj stánkarov na jednom mieste. Filtre, hromadné akcie, jedno kliknutie na schválenie.",
  },
  {
    title: "Smeny a obsadenosť",
    body: "Kalendár po dňoch a týždňoch. Automatický návrh obsadenia, ktorý nikdy nepriradí človeka na dve prekrývajúce sa smeny.",
  },
  {
    title: "Živá dochádzka",
    body: "Kto pracuje, kto mešká, kto chýba — v reálnom čase. QR check-in, GPS geofence alebo check-in koordinátorom.",
  },
  {
    title: "Mzdy z reálnych dát",
    body: "Hodiny vznikajú z check-inov, nie z papierikov. Korekcie majú audit log. Export do CSV jedným klikom.",
  },
];

export default function ForOrganisersPage() {
  return (
    <>
      <section className="bg-ink px-5 pt-14 pb-16 text-white lg:px-8 lg:pt-20 lg:pb-24">
        <div className="mx-auto grid max-w-[1240px] items-end gap-10 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:gap-16">
          <div>
            <p className="mb-6 text-xs font-semibold tracking-[0.16em] text-accent uppercase">
              Pre organizátorov
            </p>
            <h1 className="mb-6 text-[40px] leading-[0.98] font-extrabold tracking-[-0.045em] lg:text-[64px]">
              Command center
              <br />
              pre celú crew<span className="text-accent">.</span>
            </h1>
            <p className="mb-9 max-w-[460px] text-[17px] leading-[1.55] text-white/62 lg:text-lg">
              Stovky ľudí, desiatky smien, jeden prehľad. Od prihlášky po export miezd.
            </p>
            <div className="flex flex-wrap gap-3">
              <ButtonLink href="/brigada/prihlasenie" variant="accent" size="lg">
                Prihlásiť sa do admina
              </ButtonLink>
            </div>
          </div>
          <PhotoSlot
            caption="foto — produkčný stan, koordinácia"
            tone="dark"
            className="h-[240px] rounded-20 p-5 lg:h-[380px]"
          />
        </div>
      </section>

      <section className="px-5 py-14 lg:px-8 lg:py-20">
        <div className="mx-auto max-w-[1240px]">
          <div className="grid gap-5 lg:grid-cols-2">
            {FEATURES.map((feature) => (
              <Card key={feature.title} className="p-6 lg:p-8">
                <h2 className="text-[22px] font-bold tracking-[-0.03em] lg:text-[26px]">
                  {feature.title}
                </h2>
                <p className="mt-3 text-[15px] leading-[1.6] text-muted">{feature.body}</p>
              </Card>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
