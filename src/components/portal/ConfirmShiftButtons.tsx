"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { respondToShift } from "@/app/actions/portal";
import { Button } from "@/components/ui/Button";
import { TextAreaField } from "@/components/ui/Field";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";

/** „Áno, prídem“ / „Nemôžem prísť“ (§18). */
export function ConfirmShiftButtons({
  assignmentId,
  shiftId,
  compact,
}: {
  assignmentId: string;
  shiftId: string;
  compact?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [declineOpen, setDeclineOpen] = useState(false);
  const [reason, setReason] = useState("");

  function respond(attending: boolean) {
    startTransition(async () => {
      const result = await respondToShift({
        assignmentId,
        attending,
        reason: attending ? undefined : reason || undefined,
      });
      if (result.ok) {
        toast.success(result.message ?? "Uložené.");
        setDeclineOpen(false);
        router.refresh();
      } else toast.error(result.message);
    });
  }

  return (
    <>
      <div className="flex gap-2.5">
        <Button
          className="flex-1"
          size={compact ? "sm" : "md"}
          disabled={pending}
          onClick={() => respond(true)}
        >
          Áno, prídem
        </Button>
        <Button
          variant="outline"
          size={compact ? "sm" : "md"}
          disabled={pending}
          onClick={() => setDeclineOpen(true)}
        >
          Nemôžem
        </Button>
      </div>

      <Modal
        open={declineOpen}
        onClose={() => setDeclineOpen(false)}
        title="Nemôžeš prísť?"
        description="Dáme vedieť koordinátorovi, aby stihol nájsť náhradu. Čím skôr, tým lepšie."
        size="sm"
        footer={
          <>
            <Button variant="outline" onClick={() => setDeclineOpen(false)}>
              Späť
            </Button>
            <Button variant="danger" loading={pending} onClick={() => respond(false)}>
              Nemôžem prísť
            </Button>
          </>
        }
      >
        <TextAreaField
          label="Dôvod (nepovinné)"
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Napríklad: som chorý, mám skúšku."
          hint="Uvidí ho len koordinátor."
        />
        <input type="hidden" value={shiftId} readOnly />
      </Modal>
    </>
  );
}
