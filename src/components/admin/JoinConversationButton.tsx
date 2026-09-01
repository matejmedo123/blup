"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { joinConversation } from "@/app/actions/messaging";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";

export function JoinConversationButton({ conversationId }: { conversationId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();

  return (
    <Button
      loading={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await joinConversation(conversationId);
          if (result.ok) {
            toast.success(result.message ?? "Pripojené.");
            router.refresh();
          } else toast.error(result.message);
        })
      }
    >
      Pripojiť sa do konverzácie
    </Button>
  );
}
