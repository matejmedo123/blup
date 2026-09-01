import type { Metadata } from "next";

import { PageHeader } from "@/components/admin/PageHeader";
import { ShiftsTable } from "@/components/admin/ShiftsTable";
import { ButtonLink } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { FilterBar, FilterSelect, Pagination, SearchInput } from "@/components/ui/Filters";
import { IconPlus } from "@/components/ui/Icons";
import { SHIFT_STATUSES, type ShiftStatus } from "@/db/enums";
import { getAdminContext } from "@/lib/admin-context";
import { eventSettings } from "@/lib/domain/events";
import { countShiftsByStatus, listCoordinators, listPositions, listShifts } from "@/lib/domain/shifts";
import { SHIFT_STATUS_META } from "@/components/ui/Badge";
import { can } from "@/lib/permissions";

export const metadata: Metadata = { title: "Smeny" };

export default async function ShiftsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await getAdminContext();
  if (!context) return null;

  const params = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const statusParam = one(params.status);

  const [result, positions, coordinators, statusCounts] = await Promise.all([
    listShifts(context.eventId, {
      q: one(params.q),
      status: SHIFT_STATUSES.includes(statusParam as ShiftStatus)
        ? (statusParam as ShiftStatus)
        : undefined,
      positionId: one(params.position),
      coordinatorId: one(params.coordinator),
      from: one(params.from) ? new Date(`${one(params.from)}T00:00:00`) : undefined,
      to: one(params.to) ? new Date(`${one(params.to)}T23:59:59`) : undefined,
      page: Number(one(params.page) ?? 1),
    }),
    listPositions(context.eventId),
    listCoordinators(context.eventId),
    countShiftsByStatus(context.eventId),
  ]);

  const canManage = can(context.actor, "can_manage_shifts");
  const activeFilterCount = [params.status, params.position, params.coordinator, params.from].filter(
    Boolean,
  ).length;

  return (
    <>
      <PageHeader
        title="Smeny"
        subtitle={`${result.total} smien · ${statusCounts.published ?? 0} zverejnených · ${statusCounts.draft ?? 0} konceptov`}
        action={
          canManage ? (
            <>
              <ButtonLink href="/admin/calendar" variant="outline" size="sm">
                Kalendár
              </ButtonLink>
              <ButtonLink href="/admin/shifts/nova" size="sm" icon={<IconPlus width={18} height={18} />}>
                Vytvoriť smenu
              </ButtonLink>
            </>
          ) : null
        }
      />

      <div className="mb-5 flex flex-wrap items-end gap-3">
        <SearchInput placeholder="Hľadať pozíciu alebo miesto…" className="min-w-0 flex-1 lg:max-w-[360px]" />
        <FilterBar activeCount={activeFilterCount}>
          <FilterSelect
            paramName="status"
            label="Stav"
            allLabel="Všetky stavy"
            options={SHIFT_STATUSES.map((status) => ({
              value: status,
              label: SHIFT_STATUS_META[status].label,
            }))}
          />
          <FilterSelect
            paramName="position"
            label="Pozícia"
            allLabel="Všetky pozície"
            options={positions.map((p) => ({ value: p.id, label: p.name }))}
          />
          <FilterSelect
            paramName="coordinator"
            label="Koordinátor"
            allLabel="Všetci"
            options={coordinators.map((c) => ({
              value: c.id,
              label: `${c.firstName} ${c.lastName}`,
            }))}
          />
        </FilterBar>
      </div>

      <Card className="overflow-hidden">
        <ShiftsTable
          currency={eventSettings(context.event).currency}
          timezone={context.event.timezone}
          canManage={canManage}
          rows={result.rows.map((row) => ({
            id: row.id,
            positionName: row.title ?? row.positionName,
            positionColor: row.positionColor,
            startsAt: row.startsAt.toISOString(),
            endsAt: row.endsAt.toISOString(),
            location: row.location,
            capacity: row.capacity,
            filled: Number(row.filled),
            status: row.status,
            rate: Number(row.hourlyRate ?? row.positionRate),
            coordinator: row.coordinatorFirstName
              ? `${row.coordinatorFirstName} ${row.coordinatorLastName}`
              : null,
          }))}
        />
        <div className="border-t border-line">
          <Pagination
            page={result.page}
            pageCount={result.pageCount}
            total={result.total}
            pageSize={result.pageSize}
          />
        </div>
      </Card>
    </>
  );
}
