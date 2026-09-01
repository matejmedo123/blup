"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { addStaffNote } from "@/app/actions/admin-applicants";
import { Button } from "@/components/ui/Button";
import { TextAreaField } from "@/components/ui/Field";
import { useToast } from "@/components/ui/Toast";

export function StaffNoteForm({ staffId }: { staffId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | undefined>();

  return (
    <div className="flex flex-col gap-3">
      <TextAreaField
        label="Nová interná poznámka"
        rows={3}
        value={body}
        error={error}
        onChange={(e) => {
          setBody(e.target.value);
          setError(undefined);
        }}
        placeholder="Napríklad: skvelý na bare, ale nechce nočné smeny."
        hint="Vidí ju len admin tím."
      />
      <Button
        className="self-start"
        size="sm"
        loading={pending}
        disabled={body.trim().length === 0}
        onClick={() =>
          startTransition(async () => {
            const result = await addStaffNote({ staffId, body });
            if (result.ok) {
              toast.success(result.message ?? "Poznámka je pridaná.");
              setBody("");
              router.refresh();
            } else {
              setError(result.fieldErrors?.body?.[0]);
              toast.error(result.message);
            }
          })
        }
      >
        Pridať poznámku
      </Button>
    </div>
  );
}
