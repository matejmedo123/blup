import type { Metadata } from "next";

import { ForgotPasswordForm } from "@/components/forms/PasswordForms";
import { Card } from "@/components/ui/Card";

export const metadata: Metadata = { title: "Zabudnuté heslo", robots: { index: false } };

export default function ForgotPasswordPage() {
  return (
    <div className="mx-auto max-w-[440px] px-5 py-14 lg:py-24">
      <h1 className="text-[34px] leading-tight font-extrabold tracking-[-0.04em]">
        Zabudnuté heslo<span className="text-accent-deep">.</span>
      </h1>
      <p className="mt-2.5 mb-7 text-[15px] text-muted">
        Zadaj e-mail a pošleme ti odkaz na nastavenie nového hesla.
      </p>
      <Card className="p-5 sm:p-6">
        <ForgotPasswordForm />
      </Card>
    </div>
  );
}
