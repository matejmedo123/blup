import type { Metadata } from "next";

import { ResetPasswordForm } from "@/components/forms/PasswordForms";
import { ButtonLink } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ErrorState } from "@/components/ui/States";

export const metadata: Metadata = { title: "Nové heslo", robots: { index: false } };

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  if (!token) {
    return (
      <div className="mx-auto max-w-[560px] px-5 py-16 lg:py-24">
        <Card className="p-6 sm:p-10">
          <ErrorState
            title="Chýba odkaz na obnovu"
            description="Otvor prosím odkaz priamo z e-mailu, ktorý sme ti poslali."
            action={<ButtonLink href="/auth/zabudnute-heslo">Poslať nový odkaz</ButtonLink>}
          />
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[440px] px-5 py-14 lg:py-24">
      <h1 className="text-[34px] leading-tight font-extrabold tracking-[-0.04em]">
        Nové heslo<span className="text-accent-deep">.</span>
      </h1>
      <p className="mt-2.5 mb-7 text-[15px] text-muted">
        Nastav si nové heslo. Ostatné prihlásené zariadenia sa odhlásia.
      </p>
      <Card className="p-5 sm:p-6">
        <ResetPasswordForm token={token} />
      </Card>
    </div>
  );
}
