import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { BrigadeRegistrationForm } from "@/components/forms/BrigadeRegistrationForm";
import { FormPage } from "@/components/forms/FormShell";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/States";
import { ButtonLink } from "@/components/ui/Button";
import { IconCalendar } from "@/components/ui/Icons";
import { getSession } from "@/lib/auth/session";
import { eventDays, getPublicEvent } from "@/lib/domain/events";

export const metadata: Metadata = {
  title: "Registrácia na brigádu",
  description: "Vyplň prihlášku a staň sa súčasťou crew.",
};

export default async function BrigadeRegistrationPage() {
  const session = await getSession();
  if (session?.user.status === "active") redirect("/portal");

  const event = await getPublicEvent();

  if (!event) {
    return (
      <div className="mx-auto max-w-[720px] px-5 py-20 lg:px-8">
        <Card>
          <EmptyState
            icon={<IconCalendar width={26} height={26} />}
            title="Momentálne nenaberáme"
            description="Práve neprebieha nábor na žiadny event. Skús to o pár dní — nové eventy pribúdajú priebežne."
            action={<ButtonLink href="/">Späť na úvod</ButtonLink>}
          />
        </Card>
      </div>
    );
  }

  return (
    <FormPage
      eyebrow={`Prihláška · ${event.name}`}
      title={
        <>
          Vyplň to raz.
          <br />
          Zvyšok už ide samo<span className="text-accent">.</span>
        </>
      }
      lead="Šesť krokov, dve minúty. Prihlášku si prejde koordinátor a ozve sa ti e-mailom."
      aside={
        <>
          <Card className="p-5">
            <h2 className="eyebrow text-muted">Čo budeš potrebovať</h2>
            <ul className="mt-3.5 flex flex-col gap-2.5 text-[14px] leading-[1.5] text-body">
              <li>· kontaktné údaje a rok narodenia</li>
              <li>· aspoň jednu pracovnú skúsenosť</li>
              <li>· dni, kedy môžeš pracovať</li>
            </ul>
          </Card>
          <Card className="p-5">
            <h2 className="eyebrow text-muted">Už máš účet?</h2>
            <p className="mt-2.5 text-[14px] leading-[1.5] text-muted">
              Stav prihlášky nájdeš po prihlásení.
            </p>
            <Link
              href="/brigada/prihlasenie"
              className="-ml-1 mt-1 inline-flex min-h-11 items-center px-1 text-[14px] font-semibold text-ink underline underline-offset-4"
            >
              Prihlásiť sa
            </Link>
          </Card>
        </>
      }
    >
      <BrigadeRegistrationForm
        eventDays={eventDays(event)}
        eventName={event.name}
        timezone={event.timezone}
      />
    </FormPage>
  );
}
