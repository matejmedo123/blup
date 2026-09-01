import type { Metadata } from "next";
import Link from "next/link";
import { and, desc, eq, isNull } from "drizzle-orm";

import { PageHeader } from "@/components/admin/PageHeader";
import { RatingForm } from "@/components/admin/RatingForm";
import { Avatar } from "@/components/ui/Avatar";
import { Card, Kpi } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/States";
import { IconStar } from "@/components/ui/Icons";
import { getDb } from "@/db/client";
import { positions, ratings, shifts, users } from "@/db/schema";
import { getAdminContext } from "@/lib/admin-context";
import { formatDateShort } from "@/lib/format";
import { listStaff } from "@/lib/domain/staff";
import { can } from "@/lib/permissions";

export const metadata: Metadata = { title: "Hodnotenia" };

export default async function RatingsPage() {
  const context = await getAdminContext();
  if (!context) return null;

  const tz = context.event.timezone;
  const db = await getDb();
  const canRate = can(context.actor, "can_rate_staff");

  const staffAlias = users;
  const [rows, staff, shiftRows] = await Promise.all([
    db
      .select({
        id: ratings.id,
        overall: ratings.overall,
        reliability: ratings.reliability,
        punctuality: ratings.punctuality,
        workEthic: ratings.workEthic,
        communication: ratings.communication,
        quality: ratings.quality,
        note: ratings.note,
        createdAt: ratings.createdAt,
        staffId: ratings.staffId,
        staffFirstName: staffAlias.firstName,
        staffLastName: staffAlias.lastName,
        avatarUrl: staffAlias.avatarUrl,
        positionName: positions.name,
      })
      .from(ratings)
      .innerJoin(staffAlias, eq(staffAlias.id, ratings.staffId))
      .leftJoin(shifts, eq(shifts.id, ratings.shiftId))
      .leftJoin(positions, eq(positions.id, shifts.positionId))
      .where(eq(ratings.eventId, context.eventId))
      .orderBy(desc(ratings.createdAt))
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

  const average =
    rows.length > 0
      ? rows.reduce((sum, row) => sum + Number(row.overall), 0) / rows.length
      : null;
  const ratedPeople = new Set(rows.map((row) => row.staffId)).size;

  return (
    <>
      <PageHeader
        title="Hodnotenia"
        subtitle={`${rows.length} hodnotení · ${ratedPeople} hodnotených ľudí`}
        action={
          canRate ? (
            <RatingForm
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
          tone="dark"
          label="Priemerné hodnotenie"
          value={average != null ? `${average.toFixed(2)} / 5` : "—"}
          note={`${rows.length} hodnotení`}
        />
        <Kpi label="Hodnotení ľudia" value={ratedPeople} note={`z ${staff.total} crew`} />
        <Kpi
          label="Bez hodnotenia"
          value={Math.max(0, staff.total - ratedPeople)}
          note="ešte ich nikto neohodnotil"
        />
      </div>

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState
            icon={<IconStar width={26} height={26} />}
            title="Zatiaľ žiadne hodnotenia"
            description="Po skončení smeny ohodnoť crew — hodnotenie sa premietne do Crew Score a pomôže pri ďalšom prideľovaní."
          />
        ) : (
          <ul className="divide-y divide-divider">
            {rows.map((row) => (
              <li key={row.id} className="p-4 sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <Link
                    href={`/admin/staff/${row.staffId}`}
                    className="flex min-w-0 items-center gap-3 hover:underline"
                  >
                    <Avatar
                      firstName={row.staffFirstName}
                      lastName={row.staffLastName}
                      src={row.avatarUrl}
                      size="xs"
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-[15px] font-semibold">
                        {row.staffFirstName} {row.staffLastName}
                      </span>
                      <span className="block truncate text-[13px] text-muted">
                        {row.positionName ?? "Celkové hodnotenie"} ·{" "}
                        {formatDateShort(row.createdAt, tz)}
                      </span>
                    </span>
                  </Link>
                  <p className="nums shrink-0 text-lg font-bold">
                    {Number(row.overall).toFixed(2)} / 5
                  </p>
                </div>

                <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-[13px]">
                  <Score label="Spoľahlivosť" value={row.reliability} />
                  <Score label="Dochvíľnosť" value={row.punctuality} />
                  <Score label="Pracovitosť" value={row.workEthic} />
                  <Score label="Komunikácia" value={row.communication} />
                  <Score label="Kvalita" value={row.quality} />
                </dl>

                {row.note ? (
                  <p className="mt-3 text-sm leading-[1.6] text-body">{row.note}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function Score({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-muted">{label}</dt>
      <dd className="nums font-semibold">{value}/5</dd>
    </div>
  );
}
