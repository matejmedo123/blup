"use client";

import { useTransition } from "react";

import { resendVerificationEmail } from "@/app/actions/auth";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";

export function ResendVerificationButton() {
  const toast = useToast();
  const [pending, startTransition] = useTransition();

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      loading={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await resendVerificationEmail();
          if (result.ok) toast.success(result.message ?? "Odoslané.");
          else toast.error(result.message);
        })
      }
    >
      Poslať overovací e-mail znova
    </Button>
  );
}
