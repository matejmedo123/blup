import type { Metadata } from "next";

import { SubmittedState } from "@/components/forms/FormShell";
import { ButtonLink } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";

export const metadata: Metadata = {
  title: "Prihláška odoslaná",
  robots: { index: false },
};

export default function BrigadeSubmittedPage() {
  return (
    <div className="mx-auto max-w-[720px] px-5 py-16 lg:px-8 lg:py-24">
      <Card className="p-6 sm:p-10">
        <SubmittedState
          title="Prihlášku máme."
          action={
            <>
              <ButtonLink href="/prihlaska/stav">Pozrieť stav prihlášky</ButtonLink>
              <ButtonLink href="/" variant="outline">
                Späť na úvod
              </ButtonLink>
            </>
          }
        >
          <p>
            Poslali sme ti potvrdenie na e-mail. Koordinátor si prihlášku prejde a ozve sa ti,
            väčšinou do 2–3 dní.
          </p>
          <p className="mt-3">
            Zatiaľ si over e-mailovú adresu — odkaz máš v schránke. Po schválení sa prihlásiš a
            uvidíš svoje smeny.
          </p>
        </SubmittedState>
      </Card>
    </div>
  );
}
