"use client";

import { Pill, SHIFT_STATUS_META, StatusPill } from "@/components/ui/Badge";
import { ButtonLink } from "@/components/ui/Button";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/States";
import { IconCalendar } from "@/components/ui/Icons";
import type { ShiftStatus } from "@/db/enums";
import { formatDateShort, formatMoney, formatTimeRange } from "@/lib/format";

export type ShiftTableRow = {
  id: string;
  positionName: string;
  positionColor: string;
  startsAt: string;
  endsAt: string;
  location: string | null;
  capacity: number;
  filled: number;
  status: ShiftStatus;
  rate: number;
  coordinator: string | null;
};

export function ShiftsTable({
  rows,
  currency,
  timezone,
  canManage,
}: {
  rows: ShiftTableRow[];
  currency: string;
  timezone: string;
  canManage: boolean;
}) {
  function fillPill(row: ShiftTableRow) {
    if (row.filled >= row.capacity) return <Pill kind="ok" dot>Obsadené</Pill>;
    if (row.filled === 0) return <Pill kind="bad" dot>Prázdne</Pill>;
    return (
      <Pill kind="warn" dot>
        Chýba {row.capacity - row.filled}
      </Pill>
    );
  }

  const columns: Column<ShiftTableRow>[] = [
    {
      key: "position",
      header: "Pozícia",
      cell: (row) => (
        <span className="flex items-center gap-2.5">
          <span
            className="size-2.5 shrink-0 rounded-[3px]"
            style={{ background: row.positionColor }}
            aria-hidden
          />
          <span className="truncate text-[15px] font-semibold">{row.positionName}</span>
        </span>
      ),
    },
    {
      key: "when",
      header: "Kedy",
      cell: (row) => (
        <span className="nums text-sm text-muted">
          {formatDateShort(row.startsAt, timezone)} ·{" "}
          {formatTimeRange(row.startsAt, row.endsAt, timezone)}
        </span>
      ),
    },
    {
      key: "location",
      header: "Miesto",
      cell: (row) => <span className="text-sm text-muted">{row.location ?? "—"}</span>,
    },
    {
      key: "fill",
      header: "Obsadenosť",
      cell: (row) => (
        <span className="nums text-sm font-semibold">
          {row.filled} / {row.capacity}
        </span>
      ),
    },
    {
      key: "rate",
      header: "Sadzba",
      cell: (row) => <span className="nums text-sm">{formatMoney(row.rate, currency)}</span>,
      hideOnCard: true,
    },
    {
      key: "coordinator",
      header: "Koordinátor",
      cell: (row) => <span className="text-sm text-muted">{row.coordinator ?? "—"}</span>,
      hideOnCard: true,
    },
    {
      key: "status",
      header: "Stav",
      cell: (row) => <StatusPill status={row.status} meta={SHIFT_STATUS_META} />,
    },
  ];

  return (
    <DataTable
      rows={rows}
      columns={columns}
      getKey={(row) => row.id}
      href={(row) => `/admin/shifts/${row.id}`}
      empty={
        <EmptyState
          icon={<IconCalendar width={26} height={26} />}
          title="Žiadne smeny"
          description="Pre zvolené filtre sme nič nenašli. Vytvor smenu alebo zmeň filtre."
          action={
            canManage ? <ButtonLink href="/admin/shifts/nova">Vytvoriť smenu</ButtonLink> : undefined
          }
        />
      }
      card={(row) => (
        <>
          <div className="flex items-center gap-2.5">
            <span
              className="size-2.5 shrink-0 rounded-[3px]"
              style={{ background: row.positionColor }}
              aria-hidden
            />
            <p className="truncate text-[15px] font-semibold">{row.positionName}</p>
          </div>
          <p className="nums mt-1 text-[13px] text-muted">
            {formatDateShort(row.startsAt, timezone)} ·{" "}
            {formatTimeRange(row.startsAt, row.endsAt, timezone)}
            {row.location ? ` · ${row.location}` : ""}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <StatusPill status={row.status} meta={SHIFT_STATUS_META} />
            {fillPill(row)}
            <span className="nums text-[13px] font-semibold">
              {row.filled}/{row.capacity} · {formatMoney(row.rate, currency)}
            </span>
          </div>
        </>
      )}
    />
  );
}
