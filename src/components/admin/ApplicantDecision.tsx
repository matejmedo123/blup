"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import {
  approveApplications,
  rejectApplications,
  saveApplicationNote,
  setApplicationStatus,
} from "@/app/actions/admin-applicants";
import { Button } from "@/components/ui/Button";
import { TextAreaField } from "@/components/ui/Field";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import type { ApplicationStatus } from "@/db/enums";

export function ApplicantDecision({
  applicationId,
  status,
}: {
  applicationId: string;
  status: ApplicationStatus;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState("");

  function run(fn: () => Promise<{ ok: boolean; message?: string }>) {
    startTransition(async () => {
      const result = await fn();
      if (result.ok) {
        toast.success(result.message ?? "Hotovo.");
        setRejectOpen(false);
        router.refresh();
      } else {
        toast.error(result.message ?? "Akcia zlyhala.");
      }
    });
  }

  const approved = status === "approved";

  return (
    <>
      <div className="flex flex-wrap gap-2.5">
        {!approved ? (
          <Button
            disabled={pending}
            onClick={() => run(() => approveApplications({ applicationIds: [applicationId] }))}
          >
            Schváliť a vytvoriť účet
          </Button>
        ) : null}
        {status !== "reviewing" && !approved ? (
          <Button
            variant="outline"
            disabled={pending}
            onClick={() =>
              run(() =>
                setApplicationStatus({ applicationIds: [applicationId], status: "reviewing" }),
              )
            }
          >
            Posudzuje sa
          </Button>
        ) : null}
        {status !== "waitlist" && !approved ? (
          <Button
            variant="outline"
            disabled={pending}
            onClick={() =>
              run(() =>
                setApplicationStatus({ applicationIds: [applicationId], status: "waitlist" }),
              )
            }
          >
            Náhradník
          </Button>
        ) : null}
        {status !== "rejected" ? (
          <Button variant="outline" disabled={pending} onClick={() => setRejectOpen(true)}>
            Zamietnuť
          </Button>
        ) : null}
        {status !== "archived" ? (
          <Button
            variant="ghost"
            disabled={pending}
            onClick={() =>
              run(() =>
                setApplicationStatus({ applicationIds: [applicationId], status: "archived" }),
              )
            }
          >
            Archivovať
          </Button>
        ) : null}
      </div>

      <Modal
        open={rejectOpen}
        onClose={() => setRejectOpen(false)}
        title="Zamietnuť prihlášku"
        description="Uchádzačovi pošleme e-mail. Dôvod je nepovinný, ale pomáha."
        footer={
          <>
            <Button variant="outline" onClick={() => setRejectOpen(false)}>
              Zrušiť
            </Button>
            <Button
              variant="danger"
              loading={pending}
              onClick={() =>
                run(() =>
                  rejectApplications({ applicationIds: [applicationId], reason: reason || undefined }),
                )
              }
            >
              Zamietnuť
            </Button>
          </>
        }
      >
        <TextAreaField
          label="Dôvod (nepovinné)"
          rows={4}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Napríklad: kapacita na bare je naplnená."
          hint="Text sa pošle uchádzačovi v e-maile."
        />
      </Modal>
    </>
  );
}

export function InternalNoteEditor({
  applicationId,
  initialNote,
}: {
  applicationId: string;
  initialNote: string;
}) {
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState(initialNote);
  const [dirty, setDirty] = useState(false);

  return (
    <div className="flex flex-col gap-3">
      <TextAreaField
        label="Interná poznámka"
        rows={4}
        value={note}
        onChange={(e) => {
          setNote(e.target.value);
          setDirty(true);
        }}
        placeholder="Vidí ju len admin tím. Uchádzač ju nikdy neuvidí."
      />
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        disabled={!dirty}
        loading={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await saveApplicationNote({ applicationId, note });
            if (result.ok) {
              toast.success(result.message ?? "Uložené.");
              setDirty(false);
            } else toast.error(result.message);
          })
        }
      >
        Uložiť poznámku
      </Button>
    </div>
  );
}
