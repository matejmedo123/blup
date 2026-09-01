"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import {
  approveApplications,
  rejectApplications,
  setApplicationStatus,
} from "@/app/actions/admin-applicants";
import { APPLICATION_STATUS_META, StatusPill } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { ConfirmDialog } from "@/components/ui/Modal";
import { EmptyState } from "@/components/ui/States";
import { IconClipboard } from "@/components/ui/Icons";
import { Avatar } from "@/components/ui/Avatar";
import { useToast } from "@/components/ui/Toast";
import type { ApplicationStatus } from "@/db/enums";
import { formatDateShort } from "@/lib/format";
import { POSITION_KEY_LABELS } from "@/lib/labels";

import { BulkActionBar } from "./BulkActionBar";

export type ApplicantTableRow = {
  applicationId: string;
  userId: string;
  firstName: string;
  lastName: string;
  email: string;
  city: string | null;
  birthYear: number | null;
  avatarUrl: string | null;
  status: ApplicationStatus;
  createdAt: string;
  score: number | null;
  experienceCount: number;
  positions: string[];
};

export function ApplicantsTable({
  rows,
  canDecide,
}: {
  rows: ApplicantTableRow[];
  canDecide: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<null | "approve" | "reject">(null);

  function toggle(key: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleAll(keys: string[]) {
    setSelected((current) =>
      keys.every((k) => current.has(k)) ? new Set() : new Set([...current, ...keys]),
    );
  }

  function run(action: "approve" | "reject" | ApplicationStatus) {
    const ids = [...selected];
    if (ids.length === 0) return;
    startTransition(async () => {
      const result =
        action === "approve"
          ? await approveApplications({ applicationIds: ids })
          : action === "reject"
            ? await rejectApplications({ applicationIds: ids })
            : await setApplicationStatus({ applicationIds: ids, status: action });

      if (result.ok) {
        toast.success(result.message ?? "Hotovo.");
        setSelected(new Set());
        setConfirm(null);
        router.refresh();
      } else {
        toast.error(result.message);
      }
    });
  }

  const columns: Column<ApplicantTableRow>[] = [
    {
      key: "name",
      header: "Meno",
      cell: (row) => (
        <span className="flex items-center gap-3">
          <Avatar
            firstName={row.firstName}
            lastName={row.lastName}
            src={row.avatarUrl}
            size="sm"
          />
          <span className="min-w-0">
            <span className="block truncate text-[15px] font-semibold">
              {row.firstName} {row.lastName}
            </span>
            <span className="block truncate text-[13px] text-faint">{row.city ?? "—"}</span>
          </span>
        </span>
      ),
    },
    {
      key: "positions",
      header: "Pozícia",
      cell: (row) => (
        <span className="text-sm text-body">
          {row.positions.length === 0
            ? "—"
            : row.positions
                .slice(0, 2)
                .map((p) => POSITION_KEY_LABELS[p as keyof typeof POSITION_KEY_LABELS] ?? p)
                .join(", ") + (row.positions.length > 2 ? ` +${row.positions.length - 2}` : "")}
        </span>
      ),
    },
    {
      key: "experience",
      header: "Skúsenosti",
      cell: (row) => (
        <span className="text-sm text-muted">
          {row.experienceCount === 0
            ? "—"
            : `${row.experienceCount} ${row.experienceCount === 1 ? "záznam" : row.experienceCount < 5 ? "záznamy" : "záznamov"}`}
        </span>
      ),
    },
    {
      key: "score",
      header: "Score",
      cell: (row) => (
        <span className="nums text-[15px] font-bold">{row.score ?? "—"}</span>
      ),
    },
    {
      key: "created",
      header: "Prihlásená",
      cell: (row) => <span className="nums text-sm text-muted">{formatDateShort(row.createdAt)}</span>,
      hideOnCard: true,
    },
    {
      key: "status",
      header: "Stav",
      cell: (row) => <StatusPill status={row.status} meta={APPLICATION_STATUS_META} />,
    },
  ];

  return (
    <>
      {canDecide ? (
        <BulkActionBar count={selected.size} onClear={() => setSelected(new Set())}>
          <Button size="sm" variant="dark" disabled={pending} onClick={() => setConfirm("approve")}>
            Schváliť
          </Button>
          <Button size="sm" variant="outline" disabled={pending} onClick={() => run("waitlist")}>
            Náhradník
          </Button>
          <Button size="sm" variant="outline" disabled={pending} onClick={() => setConfirm("reject")}>
            Zamietnuť
          </Button>
        </BulkActionBar>
      ) : null}

      <DataTable
        rows={rows}
        columns={columns}
        getKey={(row) => row.applicationId}
        href={(row) => `/admin/applicants/${row.applicationId}`}
        selection={
          canDecide ? { selected, onToggle: toggle, onToggleAll: toggleAll } : undefined
        }
        empty={
          <EmptyState
            icon={<IconClipboard width={26} height={26} />}
            title="Žiadne prihlášky"
            description="Pre zvolené filtre sme nič nenašli. Skús zmeniť stav alebo vymazať hľadanie."
          />
        }
        card={(row) => (
          <>
            <div className="flex items-center gap-3">
              <Avatar firstName={row.firstName} lastName={row.lastName} src={row.avatarUrl} size="sm" />
              <div className="min-w-0">
                <p className="truncate text-[15px] font-semibold">
                  {row.firstName} {row.lastName}
                </p>
                <p className="truncate text-[13px] text-faint">
                  {[row.city, row.birthYear ? `${row.birthYear}` : null].filter(Boolean).join(" · ")}
                </p>
              </div>
            </div>
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <StatusPill status={row.status} meta={APPLICATION_STATUS_META} />
              <span className="text-[13px] text-muted">
                {row.positions
                  .slice(0, 2)
                  .map((p) => POSITION_KEY_LABELS[p as keyof typeof POSITION_KEY_LABELS] ?? p)
                  .join(", ") || "bez preferencie"}
              </span>
              {row.score != null ? (
                <span className="nums text-[13px] font-bold">Score {row.score}</span>
              ) : null}
            </div>
          </>
        )}
      />

      <ConfirmDialog
        open={confirm === "approve"}
        onClose={() => setConfirm(null)}
        onConfirm={() => run("approve")}
        pending={pending}
        tone="primary"
        title={`Schváliť ${selected.size} ${selected.size === 1 ? "prihlášku" : "prihlášok"}?`}
        description="Vytvoríme im crew účet, pošleme e-mail a sprístupníme portál. Smenu tým nepriradíme — tú pridelíš samostatne."
        confirmLabel="Schváliť"
      />
      <ConfirmDialog
        open={confirm === "reject"}
        onClose={() => setConfirm(null)}
        onConfirm={() => run("reject")}
        pending={pending}
        title={`Zamietnuť ${selected.size} ${selected.size === 1 ? "prihlášku" : "prihlášok"}?`}
        description="Pošleme im e-mail s rozhodnutím. Profil ostane uložený pre ďalší event."
        confirmLabel="Zamietnuť"
      />
    </>
  );
}
