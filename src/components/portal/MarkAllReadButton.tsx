"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { markAllNotificationsRead } from "@/app/actions/portal";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";

export function MarkAllReadButton() {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();

  return (
    <Button
      variant="outline"
      size="sm"
      loading={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await markAllNotificationsRead();
          if (result.ok) {
            toast.success(result.message ?? "Označené.");
            router.refresh();
          } else toast.error(result.message);
        })
      }
    >
      Označiť ako prečítané
    </Button>
  );
}
