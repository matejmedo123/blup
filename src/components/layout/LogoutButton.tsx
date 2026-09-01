"use client";

import { useTransition } from "react";

import { logout } from "@/app/actions/auth";
import { Button } from "@/components/ui/Button";
import { IconLogout } from "@/components/ui/Icons";

export function LogoutButton({
  variant = "outline",
  label = "Odhlásiť sa",
  fullWidth,
}: {
  variant?: "outline" | "ghost" | "quiet";
  label?: string;
  fullWidth?: boolean;
}) {
  const [pending, startTransition] = useTransition();

  return (
    <Button
      type="button"
      variant={variant}
      fullWidth={fullWidth}
      loading={pending}
      icon={<IconLogout width={18} height={18} />}
      onClick={() => startTransition(() => logout())}
    >
      {label}
    </Button>
  );
}
