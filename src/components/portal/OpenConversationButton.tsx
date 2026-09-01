"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { openDirectConversation, openShiftConversation } from "@/app/actions/messaging";
import { Button, type ButtonProps } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";

/** Otvorí (alebo vytvorí) priamu konverzáciu a presmeruje do nej. */
export function MessageUserButton({
  userId,
  label = "Napísať",
  target = "portal",
  ...buttonProps
}: {
  userId: string;
  label?: string;
  target?: "portal" | "admin";
} & Omit<ButtonProps, "onClick" | "loading">) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();

  return (
    <Button
      {...buttonProps}
      loading={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await openDirectConversation(userId);
          if (result.ok && result.data) {
            router.push(
              target === "admin"
                ? `/admin/messages/${result.data.conversationId}`
                : `/portal/messages/${result.data.conversationId}`,
            );
          } else if (!result.ok) {
            toast.error(result.message);
          }
        })
      }
    >
      {label}
    </Button>
  );
}

/** Otvorí chat k smene — členov doplní podľa aktuálnych pridelení. */
export function ShiftChatButton({
  shiftId,
  label = "Chat k smene",
  target = "portal",
  ...buttonProps
}: {
  shiftId: string;
  label?: string;
  target?: "portal" | "admin";
} & Omit<ButtonProps, "onClick" | "loading">) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();

  return (
    <Button
      {...buttonProps}
      loading={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await openShiftConversation(shiftId);
          if (result.ok && result.data) {
            router.push(
              target === "admin"
                ? `/admin/messages/${result.data.conversationId}`
                : `/portal/messages/${result.data.conversationId}`,
            );
          } else if (!result.ok) {
            toast.error(result.message);
          }
        })
      }
    >
      {label}
    </Button>
  );
}
