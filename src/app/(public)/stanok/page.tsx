import type { Metadata } from "next";

import { FormPage } from "@/components/forms/FormShell";
import { VendorForm } from "@/components/forms/VendorForm";
import { ButtonLink } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/States";
import { IconStore } from "@/components/ui/Icons";
import { getPublicEvent } from "@/lib/domain/events";
import { formatDateLong } from "@/lib/format";

export const metadata: Metadata = {
  title: "Chcem mať stánok",
  description: "Predávaj, prezentuj alebo ukáž svoju tvorbu.",
};

export default async function VendorPage() {
  const event = await getPublicEvent();

  if (!event) {
    return (
      <div className="mx-auto max-w-[720px] px-5 py-20 lg:px-8">
        <Card>
          <EmptyState
            icon={<IconStore width={26} height={26} />}
            title="Momentálne neprijímame prihlášky stánkov"
            description="Prihlášky otvárame vždy pár mesiacov pred eventom. Skús to neskôr."
            action={<ButtonLink href="/">Späť na úvod</ButtonLink>}
          />
        </Card>
      </div>
    );
  }

  return (
    <FormPage
      eyebrow={`Stánok · ${event.name}`}
      title={
        <>
          Predávaj, prezentuj,
          <br />
          ukáž svoju tvorbu<span className="text-accent">.</span>
        </>
      }
      lead="Jedna prihláška vyrieši miesto, energiu, vodu aj odpad. Ozveme sa ti s rozhodnutím a technickými podmienkami."
      aside={
        <>
          <Card className="p-5">
            <h2 className="eyebrow text-muted">Termín</h2>
            <p className="mt-2.5 text-[15px] font-semibold">{event.name}</p>
            <p className="mt-1 text-[14px] text-muted">
              {formatDateLong(`${event.startDate}T12:00:00Z`, event.timezone)} —{" "}
              {formatDateLong(`${event.endDate}T12:00:00Z`, event.timezone)}
            </p>
            {event.location ? (
              <p className="mt-1 text-[14px] text-muted">{event.location}</p>
            ) : null}
          </Card>
          <Card className="p-5">
            <h2 className="eyebrow text-muted">Čo pripraviť</h2>
            <ul className="mt-3.5 flex flex-col gap-2.5 text-[14px] leading-[1.5] text-body">
              <li>· rozmery stánku v metroch</li>
              <li>· potrebný príkon v kW</li>
              <li>· fotky alebo menu (odkaz)</li>
            </ul>
          </Card>
        </>
      }
    >
      <VendorForm />
    </FormPage>
  );
}
