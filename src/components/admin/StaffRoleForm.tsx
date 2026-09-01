"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { setAccountStatus, updateStaffRole } from "@/app/actions/admin-staff";
import { Button } from "@/components/ui/Button";
import { CheckboxField, SelectField } from "@/components/ui/Field";
import { ConfirmDialog } from "@/components/ui/Modal";
import { InlineNotice } from "@/components/ui/States";
import { useToast } from "@/components/ui/Toast";
import { EVENT_ROLES, type EventRole, type UserStatus } from "@/db/enums";
import type { EventPermissions } from "@/db/schema";
import { EVENT_ROLE_LABELS } from "@/lib/labels";
import {
  COORDINATOR_DEFAULT_PERMISSIONS,
  PERMISSION_DESCRIPTIONS,
  PERMISSION_KEYS,
  PERMISSION_LABELS,
} from "@/lib/permissions";

export function StaffRoleForm({
  userId,
  role: initialRole,
  permissions: initialPermissions,
  accountStatus,
}: {
  userId: string;
  role: EventRole;
  permissions: EventPermissions;
  accountStatus: UserStatus;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [role, setRole] = useState<EventRole>(initialRole);
  const [permissions, setPermissions] = useState<EventPermissions>(initialPermissions);
  const [confirmSuspend, setConfirmSuspend] = useState(false);

  function save() {
    startTransition(async () => {
      const result = await updateStaffRole({ userId, role, permissions });
      if (result.ok) {
        toast.success(result.message ?? "Uložené.");
        router.refresh();
      } else toast.error(result.message);
    });
  }

  function toggleStatus(next: UserStatus) {
    startTransition(async () => {
      const result = await setAccountStatus({ userId, status: next });
      if (result.ok) {
        toast.success(result.message ?? "Uložené.");
        setConfirmSuspend(false);
        router.refresh();
      } else toast.error(result.message);
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <SelectField
        label="Rola v evente"
        value={role}
        onChange={(e) => {
          const next = e.target.value as EventRole;
          setRole(next);
          // Koordinátor bez práv nevie nič — predvyplníme rozumnú sadu.
          if (next === "coordinator" && Object.values(permissions).every((v) => !v)) {
            setPermissions(COORDINATOR_DEFAULT_PERMISSIONS);
          }
        }}
        hint={
          role === "admin"
            ? "Admin má prístup ku všetkému vrátane miezd a nastavení."
            : role === "coordinator"
              ? "Koordinátor má len práva, ktoré mu udelíš nižšie."
              : "Crew vidí iba vlastné smeny, dochádzku a zárobok."
        }
      >
        {EVENT_ROLES.map((value) => (
          <option key={value} value={value}>
            {EVENT_ROLE_LABELS[value]}
          </option>
        ))}
      </SelectField>

      {role === "coordinator" ? (
        <div className="flex flex-col gap-2.5">
          <p className="text-sm font-semibold text-ink">Oprávnenia</p>
          {PERMISSION_KEYS.map((key) => (
            <CheckboxField
              key={key}
              label={PERMISSION_LABELS[key]}
              hint={PERMISSION_DESCRIPTIONS[key]}
              checked={permissions[key] === true}
              onChange={(e) => setPermissions({ ...permissions, [key]: e.target.checked })}
            />
          ))}
        </div>
      ) : null}

      {role === "admin" ? (
        <InlineNotice tone="warning" title="Plný prístup">
          Admin vidí mzdy, môže meniť dochádzku aj oprávnenia ostatných.
        </InlineNotice>
      ) : null}

      <div className="flex flex-wrap gap-2.5">
        <Button onClick={save} loading={pending}>
          Uložiť rolu
        </Button>
        {accountStatus === "suspended" ? (
          <Button variant="outline" disabled={pending} onClick={() => toggleStatus("active")}>
            Aktivovať účet
          </Button>
        ) : (
          <Button variant="outline" disabled={pending} onClick={() => setConfirmSuspend(true)}>
            Deaktivovať účet
          </Button>
        )}
      </div>

      <ConfirmDialog
        open={confirmSuspend}
        onClose={() => setConfirmSuspend(false)}
        onConfirm={() => toggleStatus("suspended")}
        pending={pending}
        title="Deaktivovať účet?"
        description="Používateľ sa okamžite odhlási zo všetkých zariadení a stratí prístup do portálu. Odpracované hodiny ostávajú zachované."
        confirmLabel="Deaktivovať"
      />
    </div>
  );
}
