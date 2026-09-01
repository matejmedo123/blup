import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { LoginForm } from "@/components/forms/LoginForm";
import { Card } from "@/components/ui/Card";
import { landingRouteForCurrentUser } from "@/app/actions/auth";
import { getSession } from "@/lib/auth/session";

export const metadata: Metadata = {
  title: "Prihlásenie",
  description: "Prihlás sa do CREW. portálu.",
  robots: { index: false },
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const session = await getSession();
  if (session) redirect(await landingRouteForCurrentUser());

  const { next } = await searchParams;
  const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : undefined;

  return (
    <div className="mx-auto flex max-w-[440px] flex-col px-5 py-14 lg:py-24">
      <h1 className="text-[34px] leading-tight font-extrabold tracking-[-0.04em]">
        Vitaj späť<span className="text-accent-deep">.</span>
      </h1>
      <p className="mt-2.5 mb-7 text-[15px] text-muted">
        Prihlás sa a pozri si svoje smeny, dochádzku a zárobok.
      </p>
      <Card className="p-5 sm:p-6">
        <LoginForm next={safeNext} />
      </Card>
    </div>
  );
}
