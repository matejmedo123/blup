"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { login } from "@/app/actions/auth";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/Field";
import { InlineNotice } from "@/components/ui/States";

export function LoginForm({ next }: { next?: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<Record<string, string>>({});

  function onSubmit(formData: FormData) {
    setError(null);
    setFieldError({});
    startTransition(async () => {
      const result = await login({
        email: String(formData.get("email") ?? ""),
        password: String(formData.get("password") ?? ""),
        next,
      });
      if (!result.ok) {
        setError(result.message);
        if (result.fieldErrors) {
          setFieldError(
            Object.fromEntries(Object.entries(result.fieldErrors).map(([k, v]) => [k, v[0]])),
          );
        }
        return;
      }
      router.push(result.data?.redirectTo ?? "/portal");
      router.refresh();
    });
  }

  return (
    <form action={onSubmit} className="flex flex-col gap-4">
      {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}

      <TextField
        label="E-mail"
        name="email"
        type="email"
        required
        autoComplete="email"
        inputMode="email"
        autoFocus
        error={fieldError.email}
      />
      <TextField
        label="Heslo"
        name="password"
        type="password"
        required
        autoComplete="current-password"
        error={fieldError.password}
      />

      <Button type="submit" size="md" fullWidth loading={pending}>
        Prihlásiť sa
      </Button>

      <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-[14px]">
        <Link href="/auth/zabudnute-heslo" className="font-semibold text-muted hover:text-ink">
          Zabudnuté heslo
        </Link>
        <Link href="/brigada/registracia" className="font-semibold text-ink underline underline-offset-4">
          Nemám účet
        </Link>
      </div>
    </form>
  );
}
