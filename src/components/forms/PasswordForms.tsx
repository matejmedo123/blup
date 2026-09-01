"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { requestPasswordReset, resetPassword } from "@/app/actions/auth";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/Field";
import { InlineNotice } from "@/components/ui/States";
import { useToast } from "@/components/ui/Toast";

export function ForgotPasswordForm() {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function onSubmit(formData: FormData) {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const result = await requestPasswordReset({ email: String(formData.get("email") ?? "") });
      if (result.ok) setMessage(result.message ?? "Odkaz sme odoslali.");
      else setError(result.message);
    });
  }

  if (message) {
    return (
      <div className="flex flex-col gap-4">
        <InlineNotice tone="success" title="Skontroluj si schránku">
          {message}
        </InlineNotice>
        <Link
          href="/brigada/prihlasenie"
          className="text-[14px] font-semibold text-ink underline underline-offset-4"
        >
          Späť na prihlásenie
        </Link>
      </div>
    );
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
        autoFocus
        hint="Pošleme naň odkaz na nastavenie nového hesla."
      />
      <Button type="submit" fullWidth loading={pending}>
        Poslať odkaz
      </Button>
    </form>
  );
}

export function ResetPasswordForm({ token }: { token: string }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>();

  function onSubmit(formData: FormData) {
    setError(null);
    setFieldError(undefined);
    const password = String(formData.get("password") ?? "");
    const repeat = String(formData.get("passwordRepeat") ?? "");
    if (password !== repeat) {
      setFieldError("Heslá sa nezhodujú.");
      return;
    }
    startTransition(async () => {
      const result = await resetPassword({ token, password });
      if (!result.ok) {
        setError(result.message);
        if (result.fieldErrors?.password) setFieldError(result.fieldErrors.password[0]);
        return;
      }
      toast.success("Heslo je zmenené.");
      router.push("/brigada/prihlasenie");
    });
  }

  return (
    <form action={onSubmit} className="flex flex-col gap-4">
      {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}
      <TextField
        label="Nové heslo"
        name="password"
        type="password"
        required
        autoComplete="new-password"
        autoFocus
        error={fieldError}
        hint="Aspoň 10 znakov, jedno písmeno a jedna číslica."
      />
      <TextField
        label="Nové heslo znova"
        name="passwordRepeat"
        type="password"
        required
        autoComplete="new-password"
      />
      <Button type="submit" fullWidth loading={pending}>
        Nastaviť heslo
      </Button>
    </form>
  );
}
