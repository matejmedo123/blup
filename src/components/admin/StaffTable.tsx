"use client";

import { Avatar } from "@/components/ui/Avatar";
import { Pill } from "@/components/ui/Badge";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/States";
import { IconUsers } from "@/components/ui/Icons";
import type { EventRole, UserStatus } from "@/db/enums";
import { formatDuration } from "@/lib/format";
import { EVENT_ROLE_LABELS } from "@/lib/labels";

export type StaffTableRow = {
  userId: string;
  firstName: string;
  lastName: string;
  email: string;
  city: string | null;
  avatarUrl: string | null;
  status: UserStatus;
  role: EventRole;
  score: number;
  shiftCount: number;
  minutes: number;
  noShows: number;
};

export function StaffTable({ rows }: { rows: StaffTableRow[] }) {
  const columns: Column<StaffTableRow>[] = [
    {
      key: "name",
      header: "Meno",
      cell: (row) => (
        <span className="flex items-center gap-3">
          <Avatar firstName={row.firstName} lastName={row.lastName} src={row.avatarUrl} size="sm" />
          <span className="min-w-0">
            <span className="block truncate text-[15px] font-semibold">
              {row.firstName} {row.lastName}
            </span>
            <span className="block truncate text-[13px] text-faint">{row.city ?? row.email}</span>
          </span>
        </span>
      ),
    },
    {
      key: "role",
      header: "Rola",
      cell: (row) => (
        <Pill kind={row.role === "staff" ? "neutral" : "info"}>{EVENT_ROLE_LABELS[row.role]}</Pill>
      ),
    },
    {
      key: "shifts",
      header: "Smeny",
      cell: (row) => <span className="nums text-sm">{row.shiftCount}</span>,
    },
    {
      key: "hours",
      header: "Hodiny",
      cell: (row) => <span className="nums text-sm">{formatDuration(row.minutes)}</span>,
    },
    {
      key: "score",
      header: "Score",
      cell: (row) => <span className="nums text-[15px] font-bold">{row.score}</span>,
    },
    {
      key: "status",
      header: "Stav",
      cell: (row) =>
        row.status === "active" ? (
          <Pill kind="ok" dot>
            Aktívny
          </Pill>
        ) : row.status === "suspended" ? (
          <Pill kind="bad" dot>
            Deaktivovaný
          </Pill>
        ) : (
          <Pill kind="warn" dot>
            Čaká
          </Pill>
        ),
    },
  ];

  return (
    <DataTable
      rows={rows}
      columns={columns}
      getKey={(row) => row.userId}
      href={(row) => `/admin/staff/${row.userId}`}
      empty={
        <EmptyState
          icon={<IconUsers width={26} height={26} />}
          title="Žiadna crew"
          description="Schválené prihlášky sa sem pridajú automaticky. Skús zmeniť filtre alebo schváliť prihlášku."
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
              <p className="truncate text-[13px] text-faint">{row.city ?? row.email}</p>
            </div>
          </div>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <Pill kind={row.status === "active" ? "ok" : row.status === "suspended" ? "bad" : "warn"} dot>
              {row.status === "active" ? "Aktívny" : row.status === "suspended" ? "Deaktivovaný" : "Čaká"}
            </Pill>
            <span className="nums text-[13px] text-muted">
              {row.shiftCount} smien · {formatDuration(row.minutes)}
            </span>
            <span className="nums text-[13px] font-bold">Score {row.score}</span>
          </div>
        </>
      )}
    />
  );
}
