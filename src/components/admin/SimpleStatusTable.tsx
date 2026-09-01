"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { setVendorStatus, setVolunteerStatus } from "@/app/actions/admin-applicants";
import { APPLICATION_STATUS_META, Pill, StatusPill } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/States";
import { IconHeart, IconStore } from "@/components/ui/Icons";
import { useToast } from "@/components/ui/Toast";
import type { ApplicationStatus } from "@/db/enums";
import { formatDateShort } from "@/lib/format";

import { BulkActionBar } from "./BulkActionBar";

export type SimpleRow = {
  id: string;
  title: string;
  subtitle: string;
  meta: string;
  contact: string;
  status: ApplicationStatus;
  createdAt: string;
  tags: string[];
};

export function SimpleStatusTable({
  rows,
  kind,
  canDecide,
}: {
  rows: SimpleRow[];
  kind: "volunteer" | "vendor";
  canDecide: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  function run(status: ApplicationStatus) {
    const ids = [...selected];
    if (ids.length === 0) return;
    startTransition(async () => {
      const result =
        kind === "volunteer"
          ? await setVolunteerStatus({ ids, status })
          : await setVendorStatus({ ids, status });
      if (result.ok) {
        toast.success(result.message ?? "Hotovo.");
        setSelected(new Set());
        router.refresh();
      } else toast.error(result.message);
    });
  }

  const columns: Column<SimpleRow>[] = [
    {
      key: "title",
      header: kind === "vendor" ? "Stánok" : "Meno",
      cell: (row) => (
        <span className="min-w-0">
          <span className="block truncate text-[15px] font-semibold">{row.title}</span>
          <span className="block truncate text-[13px] text-faint">{row.subtitle}</span>
        </span>
      ),
    },
    {
      key: "meta",
      header: kind === "vendor" ? "Sortiment" : "Preferencie",
      cell: (row) => <span className="text-sm text-body">{row.meta || "—"}</span>,
    },
    {
      key: "contact",
      header: "Kontakt",
      cell: (row) => <span className="text-sm text-muted">{row.contact}</span>,
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
          <Button size="sm" disabled={pending} onClick={() => run("approved")}>
            Schváliť
          </Button>
          <Button size="sm" variant="outline" disabled={pending} onClick={() => run("waitlist")}>
            Náhradník
          </Button>
          <Button size="sm" variant="outline" disabled={pending} onClick={() => run("rejected")}>
            Zamietnuť
          </Button>
        </BulkActionBar>
      ) : null}

      <DataTable
        rows={rows}
        columns={columns}
        getKey={(row) => row.id}
        href={(row) => `/admin/${kind === "vendor" ? "vendors" : "volunteers"}/${row.id}`}
        selection={canDecide ? {
          selected,
          onToggle: (key) =>
            setSelected((current) => {
              const next = new Set(current);
              if (next.has(key)) next.delete(key);
              else next.add(key);
              return next;
            }),
          onToggleAll: (keys) =>
            setSelected((current) =>
              keys.every((k) => current.has(k)) ? new Set() : new Set([...current, ...keys]),
            ),
        } : undefined}
        empty={
          <EmptyState
            icon={kind === "vendor" ? <IconStore width={26} height={26} /> : <IconHeart width={26} height={26} />}
            title={kind === "vendor" ? "Žiadni stánkari" : "Žiadni dobrovoľníci"}
            description="Pre zvolené filtre sme nič nenašli. Skús zmeniť stav alebo vymazať hľadanie."
          />
        }
        card={(row) => (
          <>
            <p className="text-[15px] font-semibold">{row.title}</p>
            <p className="text-[13px] text-faint">{row.subtitle}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <StatusPill status={row.status} meta={APPLICATION_STATUS_META} />
              {row.tags.slice(0, 2).map((tag) => (
                <Pill key={tag}>{tag}</Pill>
              ))}
            </div>
            <p className="mt-2 text-[13px] text-muted">{row.contact}</p>
          </>
        )}
      />
    </>
  );
}
