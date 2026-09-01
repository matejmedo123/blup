import type { Metadata } from "next";

import { FormPage } from "@/components/forms/FormShell";
import { VolunteerForm } from "@/components/forms/VolunteerForm";
import { ButtonLink } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/States";
import { IconCalendar } from "@/components/ui/Icons";
import { eventDays, getPublicEvent } from "@/lib/domain/events";

export const metadata: Metadata = {
  title: "Chcem byť dobrovoľník",
  description: "Pomôž vytvoriť event, na ktorý sa nezabúda.",
};

export default async function VolunteerPage() {
  const event = await getPublicEvent();

  if (!event) {
    return (
      <div className="mx-auto max-w-[720px] px-5 py-20 lg:px-8">
        <Card>
          <EmptyState
            icon={<IconCalendar width={26} height={26} />}
            title="Momentálne nenaberáme dobrovoľníkov"
            description="Práve neprebieha nábor. Nové eventy pribúdajú priebežne — skús to o pár dní."
            action={<ButtonLink href="/">Späť na úvod</ButtonLink>}
          />
        </Card>
      </div>
    );
  }

  return (
    <FormPage
      eyebrow={`Dobrovoľník · ${event.name}`}
      title={
        <>
          Pomôž vytvoriť event,
          <br />
          na ktorý sa nezabúda<span className="text-accent">.</span>
        </>
      }
      lead="Krátka prihláška, žiadne skúsenosti netreba. Ozveme sa ti s konkrétnou úlohou a časom."
      aside={
        <>
          <Card className="p-5">
            <h2 className="eyebrow text-muted">Čo z toho máš</h2>
            <ul className="mt-3.5 flex flex-col gap-2.5 text-[14px] leading-[1.5] text-body">
              <li>· vstup na event</li>
              <li>· jedlo a pitie v crew zóne</li>
              <li>· crew tričko a zázemie</li>
              <li>· ľudí, ktorí sa neskôr hodia</li>
            </ul>
          </Card>
          <Card className="p-5">
            <h2 className="eyebrow text-muted">Chceš radšej platenú brigádu?</h2>
            <ButtonLink href="/brigada" variant="outline" size="sm" className="mt-3">
              Pozrieť brigády
            </ButtonLink>
          </Card>
        </>
      }
    >
      <VolunteerForm eventDays={eventDays(event)} timezone={event.timezone} />
    </FormPage>
  );
}
