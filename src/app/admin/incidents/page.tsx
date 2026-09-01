import type { Metadata } from "next";
import Link from "next/link";
import { and, desc, eq, isNull } from "drizzle-orm";

import { NewIncidentButton, ResolveIncidentButton } from "@/components/admin/IncidentForms";
import { PageHeader } from "@/components/admin/PageHeader";
import { INCIDENT_SEVERITY_META, Pill, StatusPill } from "@/components/ui/Badge";
import { Card, Kpi } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/States";
import { IconWarning } from "@/components/ui/Icons";
import { getDb } from "@/db/client";
import { incidents, positions, shifts, users } from "@/db/schema";
import { getAdminContext } from "@/lib/admin-context";
import { formatDateShort, formatDateTime } from "@/lib/format";
import { INCIDENT_CATEGORY_LABELS } from "@/lib/labels";
import { listStaff } from "@/lib/domain/staff";
import { can } from "@/lib/permissions";

export const metadata: Metadata = { title: "Incidenty" };

export default async function IncidentsPage() {
  const context = await getAdminContext();
  if (!context) return null;

  const tz = context.event.timezone;
  const db = await getDb();
  const canManage = can(context.actor, "can_rate_staff");

  const [rows, staff, shiftRows] = await Promise.all([
    db
      .select({
        id: incidents.id,
        severity: incidents.severity,
        category: incidents.category,
        description: incidents.description,
        createdAt: incidents.createdAt,
        resolvedAt: incidents.resolvedAt,
        resolution: incidents.resolution,
        staffId: incidents.staffId,
        staffFirstName: users.firstName,
        staffLastName: users.lastName,
        positionName: positions.name,
        shiftStartsAt: shifts.startsAt,
      })
      .from(incidents)
      .leftJoin(users, eq(users.id, incidents.staffId))
      .leftJoin(shifts, eq(shifts.id, incidents.shiftId))
      .leftJoin(positions, eq(positions.id, shifts.positionId))
      .where(eq(incidents.eventId, context.eventId))
      .orderBy(desc(incidents.createdAt))
      .limit(100),
    listStaff(context.eventId, { pageSize: 500 }),
    db
      .select({ id: shifts.id, startsAt: shifts.startsAt, positionName: positions.name })
      .from(shifts)
      .innerJoin(positions, eq(positions.id, shifts.positionId))
      .where(and(eq(shifts.eventId, context.eventId), isNull(shifts.deletedAt)))
      .orderBy(desc(shifts.startsAt))
      .limit(60),
  ]);

  const open = rows.filter((row) => !row.resolvedAt);
  const critical = open.filter((row) => row.severity === "critical" || row.severity === "high");

  return (
    <>
      <PageHeader
        title="Incidenty"
        subtitle={`${open.length} otvorených · ${rows.length} celkom`}
        action={
          canManage ? (
            <NewIncidentButton
              staff={staff.rows.map((row) => ({
                id: row.userId,
                name: `${row.firstName} ${row.lastName}`,
              }))}
              shifts={shiftRows.map((row) => ({
                id: row.id,
                label: `${row.positionName} · ${formatDateShort(row.startsAt, tz)}`,
              }))}
            />
          ) : null
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Kpi
          tone={open.length > 0 ? "dark" : "plain"}
          label="Otvorené incidenty"
          value={open.length}
          note="čakajú na riešenie"
        />
        <Kpi
          tone={critical.length > 0 ? "accent" : "plain"}
          label="Vážne"
          value={critical.length}
          note="vysoká alebo kritická závažnosť"
        />
        <Kpi label="Vyriešené" value={rows.length - open.length} note="uzavreté záznamy" />
      </div>

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState
            icon={<IconWarning width={26} height={26} />}
            title="Žiadne incidenty"
            description="To je dobrá správa. Ak sa niečo stane, zaznamenaj to — pomáha to pri riešení sporov aj pri ďalšom nábore."
          />
        ) : (
          <ul className="divide-y divide-divider">
            {rows.map((row) => (
              <li key={row.id} className="p-4 sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill status={row.severity} meta={INCIDENT_SEVERITY_META} />
                      <Pill>{INCIDENT_CATEGORY_LABELS[row.category]}</Pill>
                      {row.resolvedAt ? <Pill kind="ok">Vyriešené</Pill> : null}
                    </div>
                    <p className="mt-2.5 text-[15px] leading-[1.6] text-body">{row.description}</p>
                    <p className="mt-2 text-[13px] text-faint">
                      {row.staffId ? (
                        <Link
                          href={`/admin/staff/${row.staffId}`}
                          className="font-semibold text-muted hover:text-ink"
                        >
                          {row.staffFirstName} {row.staffLastName}
                        </Link>
                      ) : (
                        "Bez konkrétnej osoby"
                      )}
                      {row.positionName ? ` · ${row.positionName}` : ""} ·{" "}
                      {formatDateTime(row.createdAt, tz)}
                    </p>
                    {row.resolution ? (
                      <p className="mt-2.5 rounded-12 bg-ok-bg px-3.5 py-2.5 text-sm text-ok-fg">
                        {row.resolution}
                      </p>
                    ) : null}
                  </div>

                  {!row.resolvedAt && canManage ? (
                    <ResolveIncidentButton incidentId={row.id} />
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
