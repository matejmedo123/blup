"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { cancelShift } from "@/app/actions/admin-shifts";
import { Button } from "@/components/ui/Button";
import { TextAreaField } from "@/components/ui/Field";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import type { ShiftStatus } from "@/db/enums";

export function ShiftActions({
  shiftId,
  status,
  usesQr,
}: {
  shiftId: string;
  status: ShiftStatus;
  usesQr: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");

  if (status === "cancelled") return null;

  return (
    <>
      {usesQr ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => window.open(`/api/qr/shift/${shiftId}`, "_blank")}
        >
          QR kód
        </Button>
      ) : null}
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        Zrušiť smenu
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Zrušiť smenu?"
        description="Všetkým prideleným pošleme notifikáciu a e-mail. Smenu už nepôjde obsadzovať."
        size="sm"
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Späť
            </Button>
            <Button
              variant="danger"
              loading={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await cancelShift({ shiftId, reason: reason || undefined });
                  if (result.ok) {
                    toast.success(result.message ?? "Smena je zrušená.");
                    setOpen(false);
                    router.refresh();
                  } else toast.error(result.message);
                })
              }
            >
              Zrušiť smenu
            </Button>
          </>
        }
      >
        <TextAreaField
          label="Dôvod (nepovinné)"
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Napríklad: zmena programu, bar sa presúva."
        />
      </Modal>
    </>
  );
}
