import type { Metadata } from "next";
import Link from "next/link";
import { desc, eq } from "drizzle-orm";

import { PageHeader } from "@/components/admin/PageHeader";
import { Avatar } from "@/components/ui/Avatar";
import { Pill } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/States";
import { IconChevronLeft, IconClipboard } from "@/components/ui/Icons";
import { getDb } from "@/db/client";
import { attendance, attendanceCorrections, positions, shifts, users } from "@/db/schema";
import { getAdminContext } from "@/lib/admin-context";
import { formatDateTime } from "@/lib/format";

export const metadata: Metadata = { title: "Korekcie dochádzky" };

const FIELD_LABELS: Record<string, string> = {
  check_in_at: "Check-in",
  check_out_at: "Check-out",
  break_minutes: "Prestávka",
  worked_minutes: "Odpracované minúty",
  bonus: "Bonus",
  adjustments: "Korekcia sumy",
};

function displayValue(field: string, value: string | null, tz: string): string {
  if (value == null || value === "") return "—";
  if (field === "check_in_at" || field === "check_out_at") return formatDateTime(value, tz);
  if (field === "worked_minutes" || field === "break_minutes") return `${value} min`;
  return value;
}

export default async function CorrectionsPage() {
  const context = await getAdminContext();
  if (!context) return null;

  const tz = context.event.timezone;
  const db = await getDb();

  const rows = await db
    .select({
      id: attendanceCorrections.id,
      field: attendanceCorrections.field,
      beforeValue: attendanceCorrections.beforeValue,
      afterValue: attendanceCorrections.afterValue,
      reason: attendanceCorrections.reason,
      createdAt: attendanceCorrections.createdAt,
      actorFirstName: users.firstName,
      actorLastName: users.lastName,
      staffId: attendance.userId,
      positionName: positions.name,
      shiftStartsAt: shifts.startsAt,
    })
    .from(attendanceCorrections)
    .innerJoin(attendance, eq(attendance.id, attendanceCorrections.attendanceId))
    .innerJoin(users, eq(users.id, attendanceCorrections.actorId))
    .innerJoin(shifts, eq(shifts.id, attendance.shiftId))
    .innerJoin(positions, eq(positions.id, shifts.positionId))
    .where(eq(attendance.eventId, context.eventId))
    .orderBy(desc(attendanceCorrections.createdAt))
    .limit(200);

  const staffIds = [...new Set(rows.map((r) => r.staffId))];
  const staffRows =
    staffIds.length > 0
      ? await db
          .select({ id: users.id, firstName: users.firstName, lastName: users.lastName })
          .from(users)
      : [];
  const staffById = new Map(staffRows.map((s) => [s.id, s]));

  return (
    <>
      <Link
        href="/admin/attendance"
        className="mb-5 inline-flex items-center gap-1.5 text-[13px] font-semibold text-muted hover:text-ink"
      >
        <IconChevronLeft width={16} height={16} />
        Späť na dochádzku
      </Link>

      <PageHeader
        title="Korekcie dochádzky"
        subtitle="Každá zmena dochádzky je nemenne zaznamenaná — kto, čo, kedy a prečo."
      />

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState
            icon={<IconClipboard width={26} height={26} />}
            title="Žiadne korekcie"
            description="Dochádzku zatiaľ nikto neopravoval. To je dobrá správa."
          />
        ) : (
          <ul className="divide-y divide-divider">
            {rows.map((row) => {
              const staff = staffById.get(row.staffId);
              return (
                <li key={row.id} className="p-4 sm:p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      {staff ? (
                        <Avatar firstName={staff.firstName} lastName={staff.lastName} size="xs" />
                      ) : null}
                      <div className="min-w-0">
                        <p className="truncate text-[15px] font-semibold">
                          {staff ? `${staff.firstName} ${staff.lastName}` : "Neznámy pracovník"}
                        </p>
                        <p className="truncate text-[13px] text-muted">
                          {row.positionName} · {formatDateTime(row.shiftStartsAt, tz)}
                        </p>
                      </div>
                    </div>
                    <Pill>{FIELD_LABELS[row.field] ?? row.field}</Pill>
                  </div>

                  <p className="nums mt-3 text-sm">
                    <span className="text-muted line-through">
                      {displayValue(row.field, row.beforeValue, tz)}
                    </span>
                    <span className="mx-2 text-faint">→</span>
                    <span className="font-semibold">
                      {displayValue(row.field, row.afterValue, tz)}
                    </span>
                  </p>

                  <p className="mt-2 text-sm leading-[1.6] text-body">{row.reason}</p>
                  <p className="mt-2 text-[13px] text-faint">
                    {row.actorFirstName} {row.actorLastName} · {formatDateTime(row.createdAt, tz)}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </>
  );
}
