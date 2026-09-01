import type { Metadata } from "next";

import { ButtonLink } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ErrorState } from "@/components/ui/States";
import { getSession } from "@/lib/auth/session";
import { canAccessPortal } from "@/lib/permissions";

export const metadata: Metadata = { title: "Prístup zamietnutý", robots: { index: false } };

const REASONS: Record<string, { title: string; description: string }> = {
  admin: {
    title: "Do admin rozhrania nemáš prístup",
    description:
      "Admin rozhranie je pre organizátorov a koordinátorov. Ak si crew, svoje smeny a dochádzku nájdeš v portáli.",
  },
  permission: {
    title: "Na túto akciu nemáš oprávnenie",
    description:
      "Koordinátor má len tie práva, ktoré mu udelil admin eventu. Ak si myslíš, že ich máš mať, ozvi sa mu.",
  },
  portal: {
    title: "Portál sa otvorí po schválení prihlášky",
    description:
      "Tvoja prihláška ešte čaká na posúdenie. Hneď ako ju koordinátor schváli, dostaneš e-mail a portál sa ti odomkne.",
  },
};

export default async function AccessDeniedPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const { reason } = await searchParams;
  const copy = REASONS[reason ?? "admin"] ?? REASONS.admin;
  const session = await getSession();
  const canPortal = session ? canAccessPortal(session.user) && session.user.status === "active" : false;

  return (
    <div className="mx-auto max-w-[560px] px-5 py-16 lg:py-24">
      <Card className="p-6 sm:p-10">
        <ErrorState
          title={copy.title}
          description={copy.description}
          action={
            <div className="flex flex-wrap justify-center gap-3">
              {canPortal ? (
                <ButtonLink href="/portal">Otvoriť portál</ButtonLink>
              ) : session ? (
                <ButtonLink href="/prihlaska/stav">Stav mojej prihlášky</ButtonLink>
              ) : (
                <ButtonLink href="/brigada/prihlasenie">Prihlásiť sa</ButtonLink>
              )}
              <ButtonLink href="/" variant="outline">
                Späť na úvod
              </ButtonLink>
            </div>
          }
        />
      </Card>
    </div>
  );
}
