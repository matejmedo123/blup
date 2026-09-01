import type { Metadata } from "next";
import Link from "next/link";

import { PageHeader } from "@/components/admin/PageHeader";
import { ShiftForm } from "@/components/admin/ShiftForm";
import { ButtonLink } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/States";
import { IconChevronLeft } from "@/components/ui/Icons";
import { getAdminContext } from "@/lib/admin-context";
import { eventSettings } from "@/lib/domain/events";
import { listCoordinators, listPositions } from "@/lib/domain/shifts";
import { toDateTimeLocal } from "@/lib/format";

export const metadata: Metadata = { title: "Nová smena" };

export default async function NewShiftPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; position?: string }>;
}) {
  const context = await getAdminContext();
  if (!context) return null;

  const { date, position } = await searchParams;
  const [positions, coordinators] = await Promise.all([
    listPositions(context.eventId, true),
    listCoordinators(context.eventId),
  ]);

  if (positions.length === 0) {
    return (
      <Card>
        <EmptyState
          title="Najprv potrebuješ pozíciu"
          description="Smena musí patriť k pozícii — tá určuje názov práce, sadzbu a farbu v kalendári."
          action={<ButtonLink href="/admin/positions">Vytvoriť pozíciu</ButtonLink>}
        />
      </Card>
    );
  }

  const tz = context.event.timezone;
  const base = date ? new Date(`${date}T18:00:00Z`) : new Date(`${context.event.startDate}T16:00:00Z`);
  const end = new Date(base.getTime() + 6 * 3_600_000);

  return (
    <>
      <Link
        href="/admin/shifts"
        className="mb-5 inline-flex items-center gap-1.5 text-[13px] font-semibold text-muted hover:text-ink"
      >
        <IconChevronLeft width={16} height={16} />
        Späť na smeny
      </Link>

      <PageHeader title="Nová smena" subtitle={context.event.name} />

      <Card className="max-w-[860px] p-5 sm:p-7">
        <ShiftForm
          defaultGeofenceRadius={eventSettings(context.event).default_geofence_radius_m}
          positions={positions.map((p) => ({ id: p.id, name: p.name, hourlyRate: p.hourlyRate }))}
          coordinators={coordinators}
          initial={{
            positionId: position && positions.some((p) => p.id === position) ? position : positions[0].id,
            title: "",
            startsAt: toDateTimeLocal(base, tz),
            endsAt: toDateTimeLocal(end, tz),
            location: context.event.location ?? "",
            lat: context.event.lat ?? "",
            lng: context.event.lng ?? "",
            capacity: "4",
            hourlyRate: "",
            status: "draft",
            checkInMethod: "manual",
            geofenceRadiusM: String(eventSettings(context.event).default_geofence_radius_m),
            coordinatorId: "",
            instructions: "",
            dressCode: "",
            showColleagues: true,
          }}
        />
      </Card>
    </>
  );
}
