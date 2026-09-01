import type { Metadata } from "next";

import { verifyEmail } from "@/app/actions/auth";
import { ButtonLink } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { SubmittedState } from "@/components/forms/FormShell";
import { ErrorState } from "@/components/ui/States";

export const metadata: Metadata = { title: "Overenie e-mailu", robots: { index: false } };

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  const result = token ? await verifyEmail(token) : { ok: false as const, message: "Chýba overovací token." };

  return (
    <div className="mx-auto max-w-[560px] px-5 py-16 lg:py-24">
      <Card className="p-6 sm:p-10">
        {result.ok ? (
          <SubmittedState
            title="E-mail je overený."
            action={<ButtonLink href="/brigada/prihlasenie">Prihlásiť sa</ButtonLink>}
          >
            <p>Ďakujeme. Teraz už len počkaj na rozhodnutie o prihláške.</p>
          </SubmittedState>
        ) : (
          <ErrorState
            title="Odkaz nefunguje"
            description={result.message}
            action={<ButtonLink href="/brigada/prihlasenie">Prihlásiť sa</ButtonLink>}
          />
        )}
      </Card>
    </div>
  );
}
