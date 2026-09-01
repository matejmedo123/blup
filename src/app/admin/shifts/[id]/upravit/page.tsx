import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq, isNull } from "drizzle-orm";

import { PageHeader } from "@/components/admin/PageHeader";
import { ShiftForm } from "@/components/admin/ShiftForm";
import { Card } from "@/components/ui/Card";
import { IconChevronLeft } from "@/components/ui/Icons";
import { getDb } from "@/db/client";
import { shifts } from "@/db/schema";
import { getAdminContext } from "@/lib/admin-context";
import { eventSettings } from "@/lib/domain/events";
import { listCoordinators, listPositions } from "@/lib/domain/shifts";
import { toDateTimeLocal } from "@/lib/format";

export const metadata: Metadata = { title: "Upraviť smenu" };

export default async function EditShiftPage({ params }: { params: Promise<{ id: string }> }) {
  const context = await getAdminContext();
  if (!context) return null;

  const { id } = await params;
  const db = await getDb();
  const [shift] = await db
    .select()
    .from(shifts)
    .where(and(eq(shifts.id, id), eq(shifts.eventId, context.eventId), isNull(shifts.deletedAt)))
    .limit(1);
  if (!shift) notFound();

  const [positions, coordinators] = await Promise.all([
    listPositions(context.eventId, true),
    listCoordinators(context.eventId),
  ]);

  const tz = context.event.timezone;

  return (
    <>
      <Link
        href={`/admin/shifts/${id}`}
        className="mb-5 inline-flex items-center gap-1.5 text-[13px] font-semibold text-muted hover:text-ink"
      >
        <IconChevronLeft width={16} height={16} />
        Späť na smenu
      </Link>

      <PageHeader title="Upraviť smenu" subtitle="Zmenu času, miesta alebo sadzby oznámime pridelenej crew." />

      <Card className="max-w-[860px] p-5 sm:p-7">
        <ShiftForm
          defaultGeofenceRadius={eventSettings(context.event).default_geofence_radius_m}
          positions={positions.map((p) => ({ id: p.id, name: p.name, hourlyRate: p.hourlyRate }))}
          coordinators={coordinators}
          initial={{
            id: shift.id,
            positionId: shift.positionId,
            title: shift.title ?? "",
            startsAt: toDateTimeLocal(shift.startsAt, tz),
            endsAt: toDateTimeLocal(shift.endsAt, tz),
            location: shift.location ?? "",
            lat: shift.lat ?? "",
            lng: shift.lng ?? "",
            capacity: String(shift.capacity),
            hourlyRate: shift.hourlyRate ?? "",
            status: shift.status,
            checkInMethod: shift.checkInMethod,
            geofenceRadiusM: String(shift.geofenceRadiusM),
            coordinatorId: shift.coordinatorId ?? "",
            instructions: shift.instructions ?? "",
            dressCode: shift.dressCode ?? "",
            showColleagues: shift.showColleagues,
          }}
        />
      </Card>
    </>
  );
}
