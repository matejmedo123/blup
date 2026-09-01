import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { ButtonLink } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ErrorState } from "@/components/ui/States";
import { requireStaff } from "@/lib/auth/guards";

export const metadata: Metadata = { title: "Check-in", robots: { index: false } };

/**
 * Cieľ QR kódu. Telefón naskenuje kód bežnou appkou fotoaparátu, otvorí sa
 * táto stránka a rovno presmeruje na smenu aj s podpísaným tokenom (§63).
 */
export default async function CheckInLandingPage({
  searchParams,
}: {
  searchParams: Promise<{ s?: string; t?: string }>;
}) {
  await requireStaff("/portal/checkin");
  const { s, t } = await searchParams;

  if (s && t) redirect(`/portal/shifts/${s}?t=${encodeURIComponent(t)}`);

  return (
    <Card>
      <ErrorState
        title="QR kód nie je platný"
        description="Skús kód naskenovať znova. Ak to nepomôže, ozvi sa koordinátorovi — checkne ťa manuálne."
        action={<ButtonLink href="/portal/shifts">Moje smeny</ButtonLink>}
      />
    </Card>
  );
}
