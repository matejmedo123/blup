import type { Metadata } from "next";

import { PageHeader } from "@/components/admin/PageHeader";
import { ShiftCalendar } from "@/components/admin/ShiftCalendar";
import { ButtonLink } from "@/components/ui/Button";
import { IconPlus } from "@/components/ui/Icons";
import { getAdminContext } from "@/lib/admin-context";
import { listShifts } from "@/lib/domain/shifts";
import { formatDateLong } from "@/lib/format";
import { can } from "@/lib/permissions";

export const metadata: Metadata = { title: "Kalendár" };

/** Pondelok týždňa, do ktorého spadá dátum. */
function startOfWeek(date: Date): Date {
  const copy = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = (copy.getUTCDay() + 6) % 7;
  copy.setUTCDate(copy.getUTCDate() - weekday);
  return copy;
}

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string; view?: string }>;
}) {
  const context = await getAdminContext();
  if (!context) return null;

  const { week, view } = await searchParams;
  const anchor = week ? new Date(`${week}T12:00:00Z`) : new Date();
  const monday = startOfWeek(Number.isNaN(anchor.getTime()) ? new Date() : anchor);

  const days = Array.from({ length: 7 }, (_, i) => {
    const day = new Date(monday);
    day.setUTCDate(monday.getUTCDate() + i);
    return day.toISOString().slice(0, 10);
  });

  const from = new Date(`${days[0]}T00:00:00`);
  const to = new Date(`${days[6]}T23:59:59`);

  const result = await listShifts(context.eventId, { from, to, pageSize: 200 });
  const canManage = can(context.actor, "can_manage_shifts");

  return (
    <>
      <PageHeader
        title="Kalendár"
        subtitle={`${formatDateLong(`${days[0]}T12:00:00Z`, context.event.timezone)} — ${formatDateLong(`${days[6]}T12:00:00Z`, context.event.timezone)} · ${context.event.name}`}
        action={
          canManage ? (
            <ButtonLink href="/admin/shifts/nova" size="sm" icon={<IconPlus width={18} height={18} />}>
              Vytvoriť smenu
            </ButtonLink>
          ) : null
        }
      />

      <ShiftCalendar
        days={days}
        weekStart={days[0]}
        timezone={context.event.timezone}
        canManage={canManage}
        view={view === "list" ? "list" : "week"}
        shifts={result.rows.map((row) => ({
          id: row.id,
          positionName: row.title ?? row.positionName,
          positionColor: row.positionColor,
          startsAt: row.startsAt.toISOString(),
          endsAt: row.endsAt.toISOString(),
          location: row.location,
          capacity: row.capacity,
          filled: Number(row.filled),
          status: row.status,
        }))}
      />
    </>
  );
}
