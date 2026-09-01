"use client";

import Link from "next/link";

import { Pill } from "@/components/ui/Badge";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { formatMoney } from "@/lib/format";

export type PayrollRow = {
  userId: string;
  name: string;
  email: string;
  positionName: string;
  hours: number;
  hourlyRate: number;
  gross: number;
  bonus: number;
  adjustments: number;
  total: number;
  allApproved: boolean;
};

export function PayrollTable({ rows, currency }: { rows: PayrollRow[]; currency: string }) {
  const columns: Column<PayrollRow>[] = [
    {
      key: "name",
      header: "Meno",
      cell: (row) => (
        <Link href={`/admin/staff/${row.userId}`} className="min-w-0 hover:underline">
          <span className="block truncate text-[15px] font-semibold">{row.name}</span>
          <span className="block truncate text-[13px] text-faint">{row.email}</span>
        </Link>
      ),
    },
    {
      key: "position",
      header: "Pozícia",
      cell: (row) => <span className="text-sm text-body">{row.positionName}</span>,
    },
    {
      key: "hours",
      header: "Hodiny",
      cell: (row) => <span className="nums text-sm">{row.hours.toFixed(2)}</span>,
    },
    {
      key: "rate",
      header: "Sadzba",
      cell: (row) => (
        <span className="nums text-sm text-muted">{formatMoney(row.hourlyRate, currency)}</span>
      ),
    },
    {
      key: "bonus",
      header: "Bonus / korekcia",
      cell: (row) => (
        <span className="nums text-sm text-muted">
          {formatMoney(row.bonus + row.adjustments, currency)}
        </span>
      ),
      hideOnCard: true,
    },
    {
      key: "total",
      header: "Suma",
      cell: (row) => (
        <span className="nums text-[17px] font-bold">{formatMoney(row.total, currency)}</span>
      ),
    },
    {
      key: "status",
      header: "Stav",
      cell: (row) =>
        row.allApproved ? (
          <Pill kind="ok" dot>
            Schválené
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
      card={(row) => (
        <>
          <p className="text-[15px] font-semibold">{row.name}</p>
          <p className="truncate text-[13px] text-faint">{row.positionName}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {row.allApproved ? (
              <Pill kind="ok" dot>
                Schválené
              </Pill>
            ) : (
              <Pill kind="warn" dot>
                Čaká
              </Pill>
            )}
            <span className="nums text-[13px] text-muted">
              {row.hours.toFixed(2)} h × {formatMoney(row.hourlyRate, currency)}
            </span>
            <span className="nums ml-auto text-base font-bold">
              {formatMoney(row.total, currency)}
            </span>
          </div>
        </>
      )}
    />
  );
}
