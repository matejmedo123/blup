import type { Metadata } from "next";
import { and, count, eq, isNull } from "drizzle-orm";

import { PageHeader } from "@/components/admin/PageHeader";
import { PositionsManager } from "@/components/admin/PositionsManager";
import { getDb } from "@/db/client";
import { shifts } from "@/db/schema";
import { getAdminContext } from "@/lib/admin-context";
import { eventSettings } from "@/lib/domain/events";
import { listPositions } from "@/lib/domain/shifts";
import { can } from "@/lib/permissions";

export const metadata: Metadata = { title: "Pozície" };

export default async function PositionsPage() {
  const context = await getAdminContext();
  if (!context) return null;

  const db = await getDb();
  const [rows, shiftCounts] = await Promise.all([
    listPositions(context.eventId),
    db
      .select({ positionId: shifts.positionId, value: count() })
      .from(shifts)
      .where(and(eq(shifts.eventId, context.eventId), isNull(shifts.deletedAt)))
      .groupBy(shifts.positionId),
  ]);

  const countByPosition = new Map(shiftCounts.map((r) => [r.positionId, Number(r.value)]));

  return (
    <>
      <PageHeader
        title="Pozície"
        subtitle="Názov práce, hodinová sadzba a farba v kalendári. Základ pre každú smenu."
      />
      <PositionsManager
        canManage={can(context.actor, "can_manage_shifts")}
        currency={eventSettings(context.event).currency}
        rows={rows.map((row) => ({
          id: row.id,
          name: row.name,
          description: row.description,
          hourlyRate: row.hourlyRate,
          capacity: row.capacity,
          color: row.color,
          requiredSkills: row.requiredSkills,
          active: row.active,
          shiftCount: countByPosition.get(row.id) ?? 0,
        }))}
      />
    </>
  );
}
