import type { Metadata } from "next";
import Link from "next/link";

import { AutoAssignPanel } from "@/components/admin/AutoAssignPanel";
import { PageHeader } from "@/components/admin/PageHeader";
import { ASSIGNMENT_STATUS_META, Pill, StatusPill } from "@/components/ui/Badge";
import { ButtonLink } from "@/components/ui/Button";
import { Card, Kpi } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/States";
import { getAdminContext } from "@/lib/admin-context";
import {
  listShifts,
  occupancy,
  shiftsNeedingReplacement,
  unconfirmedAssignments,
} from "@/lib/domain/shifts";
import { formatDateShort, formatTime } from "@/lib/format";
import { can } from "@/lib/permissions";

export const metadata: Metadata = { title: "Prideľovanie" };

export default async function AssignmentsPage() {
  const context = await getAdminContext();
  if (!context) return null;
  if (!can(context.actor, "can_manage_shifts")) {
    return (
      <Card>
        <EmptyState
          title="Nemáš oprávnenie prideľovať smeny"
          description="Prideľovanie vyžaduje právo „Správa smien“. Požiadaj o neho admina eventu."
        />
      </Card>
    );
  }

  const tz = context.event.timezone;

  const [result, occ, replacements, unconfirmed] = await Promise.all([
    listShifts(context.eventId, { from: new Date(), pageSize: 200 }),
    occupancy(context.eventId),
    shiftsNeedingReplacement(context.eventId),
    unconfirmedAssignments(context.eventId, 72),
  ]);

  const open = result.rows
    .filter((row) => row.status !== "cancelled" && Number(row.filled) < row.capacity)
    .map((row) => ({
      id: row.id,
      positionName: row.title ?? row.positionName,
      startsAt: row.startsAt.toISOString(),
      endsAt: row.endsAt.toISOString(),
      location: row.location,
      capacity: row.capacity,
      filled: Number(row.filled),
    }));

  const occupancyPercent = occ.capacity > 0 ? Math.round((occ.filled / occ.capacity) * 100) : 0;

  return (
    <>
      <PageHeader
        title="Prideľovanie"
        subtitle="Manuálne aj automatické obsadzovanie smien. Systém nikdy nepriradí človeka na dve prekrývajúce sa smeny."
        action={
          <ButtonLink href="/admin/calendar" variant="outline" size="sm">
            Kalendár
          </ButtonLink>
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Kpi
          tone="accent"
          label="Obsadenosť"
          value={`${occupancyPercent} %`}
          note={`${occ.filled} / ${occ.capacity} miest`}
        />
        <Kpi label="Neobsadené smeny" value={open.length} note="do konca eventu" />
        <Kpi
          label="Nepotvrdené"
          value={unconfirmed.length}
          note="začínajú do 72 hodín"
        />
      </div>

      {replacements.length > 0 ? (
        <Card className="mb-5 p-5 sm:p-6">
          <h2 className="section-label mb-3.5">Potrebujú náhradu</h2>
          <ul className="flex flex-col gap-2.5">
            {replacements.map((row) => (
              <li key={row.assignmentId}>
                <Link
                  href={`/admin/shifts/${row.shiftId}`}
                  className="flex flex-wrap items-center gap-3 rounded-12 border border-line p-3.5 transition-colors hover:bg-hover"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-semibold">
                      {row.firstName} {row.lastName} nemôže prísť
                    </span>
                    <span className="nums block truncate text-[13px] text-muted">
                      {row.positionName} · {formatDateShort(row.startsAt, tz)}{" "}
                      {formatTime(row.startsAt, tz)}
                      {row.declineReason ? ` · ${row.declineReason}` : ""}
                    </span>
                  </span>
                  <Pill kind="bad" dot>
                    Nájsť náhradu
                  </Pill>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {unconfirmed.length > 0 ? (
        <Card className="mb-5 p-5 sm:p-6">
          <h2 className="section-label mb-3.5">Čakajú na potvrdenie</h2>
          <ul className="flex flex-col gap-2.5">
            {unconfirmed.slice(0, 8).map((row) => (
              <li key={row.assignmentId}>
                <Link
                  href={`/admin/shifts/${row.shiftId}`}
                  className="flex flex-wrap items-center gap-3 rounded-12 border border-line p-3.5 transition-colors hover:bg-hover"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-semibold">
                      {row.firstName} {row.lastName}
                    </span>
                    <span className="nums block truncate text-[13px] text-muted">
                      {row.positionName} · {formatDateShort(row.startsAt, tz)}{" "}
                      {formatTime(row.startsAt, tz)}
                    </span>
                  </span>
                  <StatusPill status="pending_confirmation" meta={ASSIGNMENT_STATUS_META} />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <AutoAssignPanel shifts={open} timezone={tz} />
    </>
  );
}
