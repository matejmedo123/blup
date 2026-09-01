import type { Metadata } from "next";

import { LiveAttendanceTable } from "@/components/admin/LiveAttendanceTable";
import { PageHeader } from "@/components/admin/PageHeader";
import { ButtonLink } from "@/components/ui/Button";
import { Card, Kpi } from "@/components/ui/Card";
import { getAdminContext } from "@/lib/admin-context";
import { liveAttendance, startOfDay } from "@/lib/domain/attendance";
import { formatDateLong, toDateTimeLocal } from "@/lib/format";
import { can } from "@/lib/permissions";

export const metadata: Metadata = { title: "Živá dochádzka" };

export default async function AttendancePage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const context = await getAdminContext();
  if (!context) return null;

  const { date } = await searchParams;
  const anchor = date ? new Date(`${date}T12:00:00`) : new Date();
  const day = Number.isNaN(anchor.getTime()) ? new Date() : anchor;
  const from = startOfDay(day);
  const to = new Date(from.getTime() + 86_400_000);

  const rows = await liveAttendance(context.eventId, { from, to });
  const tz = context.event.timezone;

  const counts = rows.reduce(
    (acc, row) => {
      if (row.status === "checked_in" || row.status === "late") acc.working += 1;
      else if (row.status === "checked_out" || row.status === "manually_corrected") acc.done += 1;
      else if (row.status === "missing") acc.missing += 1;
      else acc.expected += 1;
      return acc;
    },
    { working: 0, expected: 0, missing: 0, done: 0 },
  );

  return (
    <>
      <PageHeader
        title="Dochádzka"
        subtitle={`${formatDateLong(day, tz)} · ${rows.length} ${rows.length === 1 ? "smena" : "pridelení"}`}
        action={
          <ButtonLink href="/admin/attendance/corrections" variant="outline" size="sm">
            História korekcií
          </ButtonLink>
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi tone="dark" label="🟢 Práve pracuje" value={counts.working} note="checknutí na smene" />
        <Kpi label="🟡 Očakáva sa" value={counts.expected} note="smena ešte nezačala" />
        <Kpi
          tone={counts.missing > 0 ? "accent" : "plain"}
          label="🔴 Chýba"
          value={counts.missing}
          note="bez check-inu po začiatku"
        />
        <Kpi label="Ukončené" value={counts.done} note="odpracované smeny" />
      </div>

      <Card className="overflow-hidden">
        <LiveAttendanceTable
          timezone={tz}
          canCheckIn={can(context.actor, "can_check_in_others")}
          canCheckOut={can(context.actor, "can_check_out_others")}
          canEdit={can(context.actor, "can_edit_attendance")}
          rows={rows.map((row) => ({
            attendanceId: row.attendanceId,
            assignmentId: row.assignmentId,
            shiftId: row.shiftId,
            userId: row.userId,
            firstName: row.firstName,
            lastName: row.lastName,
            avatarUrl: row.avatarUrl,
            positionName: row.positionName,
            startsAt: row.startsAt.toISOString(),
            endsAt: row.endsAt.toISOString(),
            status: row.status,
            checkInAt: row.checkInAt?.toISOString() ?? null,
            checkOutAt: row.checkOutAt?.toISOString() ?? null,
            workedMinutes: row.workedMinutes,
            approved: row.approved,
            checkInLocal: row.checkInAt ? toDateTimeLocal(row.checkInAt, tz) : "",
            checkOutLocal: row.checkOutAt ? toDateTimeLocal(row.checkOutAt, tz) : "",
          }))}
        />
      </Card>
    </>
  );
}
