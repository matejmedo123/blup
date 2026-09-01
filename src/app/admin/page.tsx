import type { Metadata } from "next";
import Link from "next/link";
import { and, count, eq, isNull } from "drizzle-orm";

import { PageHeader } from "@/components/admin/PageHeader";
import { Pill, SHIFT_STATUS_META, StatusDot, StatusPill } from "@/components/ui/Badge";
import { Avatar } from "@/components/ui/Avatar";
import { Card, Kpi, SectionCard } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/States";
import { IconCalendar, IconUsers } from "@/components/ui/Icons";
import { getDb } from "@/db/client";
import { eventMembers, incidents } from "@/db/schema";
import { getAdminContext } from "@/lib/admin-context";
import { countApplicantsByStatus } from "@/lib/domain/applications";
import { currentlyWorking, liveCounts } from "@/lib/domain/attendance";
import { eventSettings } from "@/lib/domain/events";
import { estimatedPayrollCost } from "@/lib/domain/payroll";
import {
  occupancy,
  shiftsNeedingReplacement,
  todaysShifts,
  unconfirmedAssignments,
  upcomingShifts,
} from "@/lib/domain/shifts";
import { formatDateLong, formatDateShort, formatMoney, formatTime, formatTimeRange } from "@/lib/format";

export const metadata: Metadata = { title: "Prehľad" };

function greeting(now: Date): string {
  const hour = now.getHours();
  if (hour < 10) return "Dobré ráno.";
  if (hour < 18) return "Dobrý deň.";
  return "Dobrý večer.";
}

export default async function AdminDashboardPage() {
  const context = await getAdminContext();
  if (!context) return null;

  const now = new Date();
  const tz = context.event.timezone;
  const currency = eventSettings(context.event).currency;
  const db = await getDb();

  const [
    applicantCounts,
    crewCount,
    today,
    upcoming,
    counts,
    working,
    occ,
    openIncidents,
    payrollEstimate,
    replacements,
    unconfirmed,
  ] = await Promise.all([
    countApplicantsByStatus(context.eventId),
    db
      .select({ value: count() })
      .from(eventMembers)
      .where(and(eq(eventMembers.eventId, context.eventId), eq(eventMembers.active, true))),
    todaysShifts(context.eventId, now),
    upcomingShifts(context.eventId, 5),
    liveCounts(context.eventId, now),
    currentlyWorking(context.eventId, 6),
    occupancy(context.eventId),
    db
      .select({ value: count() })
      .from(incidents)
      .where(and(eq(incidents.eventId, context.eventId), isNull(incidents.resolvedAt))),
    estimatedPayrollCost(context.eventId),
    shiftsNeedingReplacement(context.eventId),
    unconfirmedAssignments(context.eventId),
  ]);

  const pendingApplicants = (applicantCounts.pending ?? 0) + (applicantCounts.reviewing ?? 0);
  const occupancyPercent = occ.capacity > 0 ? Math.round((occ.filled / occ.capacity) * 100) : 0;

  const alerts = [
    ...replacements.map((row) => ({
      key: `replacement-${row.assignmentId}`,
      kind: "bad" as const,
      title: `${row.firstName} ${row.lastName} nemôže prísť na smenu`,
      note: `${row.positionName} · ${formatDateShort(row.startsAt, tz)} ${formatTime(row.startsAt, tz)}${row.declineReason ? ` · ${row.declineReason}` : ""}`,
      href: `/admin/shifts/${row.shiftId}`,
    })),
    ...(counts.missing > 0
      ? [
          {
            key: "missing",
            kind: "warn" as const,
            title: `${counts.missing} ${counts.missing === 1 ? "človek nemá" : "ľudí nemá"} check-in`,
            note: "Smena už začala. Pozri živú dochádzku.",
            href: "/admin/attendance",
          },
        ]
      : []),
    ...(unconfirmed.length > 0
      ? [
          {
            key: "unconfirmed",
            kind: "info" as const,
            title: `${unconfirmed.length} ${unconfirmed.length === 1 ? "smena nie je" : "smien nie je"} potvrdených`,
            note: "Začínajú do 48 hodín.",
            href: "/admin/assignments",
          },
        ]
      : []),
    ...(pendingApplicants > 0
      ? [
          {
            key: "applicants",
            kind: "info" as const,
            title: `${pendingApplicants} ${pendingApplicants === 1 ? "prihláška čaká" : "prihlášok čaká"} na posúdenie`,
            note: "Uchádzači čakajú na rozhodnutie.",
            href: "/admin/applicants",
          },
        ]
      : []),
  ].slice(0, 6);

  return (
    <>
      <PageHeader
        size="lg"
        title={greeting(now)}
        subtitle={`${formatDateLong(now, tz)} · ${context.event.name}`}
      />

      <div className="mb-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          tone="dark"
          label="Crew na evente"
          value={Number(crewCount[0]?.value ?? 0)}
          note={`${applicantCounts.approved ?? 0} schválených prihlášok`}
        />
        <Kpi
          label="Smeny dnes"
          value={today.length}
          note={
            today.length > 0
              ? `najbližšia ${formatTime(today[0].startsAt, tz)}`
              : "dnes nič neprebieha"
          }
          href="/admin/calendar"
        />
        <Kpi
          tone="accent"
          label="Obsadenosť"
          value={`${occupancyPercent} %`}
          note={`${occ.filled} / ${occ.capacity} miest`}
          href="/admin/assignments"
        />
        <Kpi
          label="Práve pracuje"
          value={counts.working}
          note={
            counts.missing > 0
              ? `${counts.missing} ${counts.missing === 1 ? "chýba" : "chýbajú"}`
              : `${counts.expected} sa očakáva`
          }
          href="/admin/attendance"
        />
      </div>

      <div className="mb-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          label="Prihlášky čakajú"
          value={pendingApplicants}
          note={`${applicantCounts.waitlist ?? 0} náhradníkov`}
          href="/admin/applicants"
        />
        <Kpi
          label="Chýbajúci"
          value={counts.missing}
          note="bez check-inu po začiatku"
          href="/admin/attendance"
        />
        <Kpi
          label="Otvorené incidenty"
          value={Number(openIncidents[0]?.value ?? 0)}
          note="nevyriešené"
          href="/admin/incidents"
        />
        <Kpi
          label="Odhad mzdových nákladov"
          value={formatMoney(payrollEstimate, currency)}
          note="z aktuálnej dochádzky"
          href="/admin/payroll"
        />
      </div>

      <div className="grid gap-5 xl:grid-cols-[1.4fr_1fr] xl:items-start">
        <SectionCard
          label="Dnešné smeny"
          action={
            <Link href="/admin/calendar" className="text-sm font-semibold text-muted hover:text-ink">
              Kalendár →
            </Link>
          }
          bodyClassName="-mx-1"
        >
          {today.length === 0 ? (
            <EmptyState
              icon={<IconCalendar width={26} height={26} />}
              title="Dnes žiadna smena"
              description="Na dnešok nie je naplánovaná žiadna smena. Vytvor ju v kalendári."
            />
          ) : (
            <ul className="divide-y divide-divider">
              {today.map((shift) => (
                <li key={shift.id}>
                  <Link
                    href={`/admin/shifts/${shift.id}`}
                    className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 rounded-10 px-3 py-4 transition-colors hover:bg-hover xl:grid-cols-[110px_1fr_130px_80px_auto]"
                  >
                    <span className="text-sm font-bold tracking-[-0.01em]">
                      {shift.positionName}
                    </span>
                    <span className="col-start-1 text-sm text-muted xl:col-start-auto">
                      {shift.location ?? "—"}
                    </span>
                    <span className="nums col-start-1 text-sm text-muted xl:col-start-auto">
                      {formatTimeRange(shift.startsAt, shift.endsAt, tz)}
                    </span>
                    <span className="nums col-start-1 text-sm font-semibold xl:col-start-auto">
                      {shift.filled} / {shift.capacity}
                    </span>
                    <span className="col-start-2 row-start-1 justify-self-end xl:col-start-auto xl:row-start-auto">
                      {shift.filled >= shift.capacity ? (
                        <Pill kind="ok" dot>
                          Obsadené
                        </Pill>
                      ) : shift.filled === 0 ? (
                        <Pill kind="bad" dot>
                          Kritické
                        </Pill>
                      ) : (
                        <Pill kind="warn" dot>
                          Chýba {shift.capacity - shift.filled}
                        </Pill>
                      )}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <div className="flex flex-col gap-5">
          <SectionCard label="Vyžaduje pozornosť">
            {alerts.length === 0 ? (
              <p className="text-[15px] text-muted">
                Nič nehorí. Všetky smeny sú potvrdené a dochádzka sedí.
              </p>
            ) : (
              <ul className="flex flex-col gap-3">
                {alerts.map((alert) => (
                  <li key={alert.key}>
                    <Link
                      href={alert.href}
                      className="grid grid-cols-[8px_1fr] items-start gap-3.5 rounded-10 py-1 transition-colors hover:opacity-80"
                    >
                      <StatusDot kind={alert.kind} className="mt-1.5" />
                      <span>
                        <span className="block text-[15px] font-semibold tracking-[-0.01em]">
                          {alert.title}
                        </span>
                        <span className="mt-0.5 block text-[13px] text-muted">{alert.note}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard
            label="Live crew"
            action={
              <Link
                href="/admin/attendance"
                className="text-sm font-semibold text-muted hover:text-ink"
              >
                Dochádzka →
              </Link>
            }
          >
            {working.length === 0 ? (
              <p className="text-[15px] text-muted">Momentálne nikto nie je na smene.</p>
            ) : (
              <ul className="flex flex-col gap-3.5">
                {working.map((person) => (
                  <li key={person.userId}>
                    <Link
                      href={`/admin/staff/${person.userId}`}
                      className="flex items-center gap-3 rounded-10 p-1 transition-colors hover:bg-hover"
                    >
                      <Avatar
                        firstName={person.firstName}
                        lastName={person.lastName}
                        src={person.avatarUrl}
                        size="xs"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold">
                          {person.firstName} {person.lastName}
                        </span>
                        <span className="block truncate text-[13px] text-muted">
                          {person.positionName}
                          {person.location ? ` · ${person.location}` : ""}
                        </span>
                      </span>
                      <Pill kind={person.status === "late" ? "warn" : "ok"} dot>
                        {person.status === "late" ? "Meškal" : "Pracuje"}
                      </Pill>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </div>
      </div>

      <div className="mt-5">
        <SectionCard
          label="Najbližšie smeny"
          action={
            <Link href="/admin/shifts" className="text-sm font-semibold text-muted hover:text-ink">
              Všetky smeny →
            </Link>
          }
        >
          {upcoming.length === 0 ? (
            <EmptyState
              icon={<IconUsers width={26} height={26} />}
              title="Žiadne naplánované smeny"
              description="Vytvor pozície a potom smeny — crew ich uvidí v portáli."
            />
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {upcoming.map((shift) => (
                <li key={shift.id}>
                  <Link
                    href={`/admin/shifts/${shift.id}`}
                    className="block rounded-16 border border-line p-4 transition-colors hover:bg-hover"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-[15px] font-bold">{shift.positionName}</p>
                      <StatusPill status={shift.status} meta={SHIFT_STATUS_META} dot={false} />
                    </div>
                    <p className="nums mt-1.5 text-[13px] text-muted">
                      {formatDateShort(shift.startsAt, tz)} ·{" "}
                      {formatTimeRange(shift.startsAt, shift.endsAt, tz)}
                    </p>
                    <p className="mt-0.5 text-[13px] text-muted">{shift.location ?? "—"}</p>
                    <p className="nums mt-2.5 text-sm font-semibold">
                      {shift.filled} / {shift.capacity} obsadené
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>

      {context.event.status !== "active" ? (
        <Card className="mt-5 p-5">
          <p className="text-[15px] text-muted">
            Event <strong className="text-ink">{context.event.name}</strong> nie je aktívny —
            verejné prihlášky sa naň nedajú podať. Zmeníš to v{" "}
            <Link href="/admin/settings" className="underline underline-offset-4">
              nastaveniach eventu
            </Link>
            .
          </p>
        </Card>
      ) : null}
    </>
  );
}
