import type { Metadata } from "next";
import Link from "next/link";

import { ConfirmShiftButtons } from "@/components/portal/ConfirmShiftButtons";
import { OnShiftCard } from "@/components/portal/OnShiftCard";
import { ShiftCard } from "@/components/portal/ShiftCard";
import { Pill } from "@/components/ui/Badge";
import { ButtonLink } from "@/components/ui/Button";
import { Card, DarkCard, StatTile } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/States";
import { IconCalendar } from "@/components/ui/Icons";
import { requireStaff } from "@/lib/auth/guards";
import { eventSettings, getEventById } from "@/lib/domain/events";
import { calculateEarnings } from "@/lib/domain/payroll";
import { portalShifts, shiftsAwaitingConfirmation } from "@/lib/domain/portal";
import { getCrewScore } from "@/lib/domain/score";
import {
  formatDateShort,
  formatDateWithWeekday,
  formatDuration,
  formatMoney,
  formatTime,
  formatTimeRange,
} from "@/lib/format";

export const metadata: Metadata = { title: "Domov" };

function greeting(now: Date): string {
  const hour = now.getHours();
  if (hour < 10) return "Dobré ráno";
  if (hour < 18) return "Ahoj";
  return "Dobrý večer";
}

export default async function PortalHomePage() {
  const session = await requireStaff("/portal");
  if (!session.eventId) {
    return (
      <Card>
        <EmptyState
          title="Zatiaľ nie si na žiadnom evente"
          description="Keď ťa organizátor pridá na event, uvidíš tu svoje smeny."
        />
      </Card>
    );
  }

  const event = await getEventById(session.eventId);
  if (!event) return null;

  const tz = event.timezone;
  const settings = eventSettings(event);
  const now = new Date();

  const [shifts, awaiting, score] = await Promise.all([
    portalShifts(session.user.id, session.eventId),
    shiftsAwaitingConfirmation(session.user.id, session.eventId),
    getCrewScore(session.user.id, session.eventId),
  ]);

  const active = shifts.active[0] ?? null;
  const next = shifts.upcoming[0] ?? null;

  const totalMinutes = shifts.all.reduce((sum, row) => sum + (row.workedMinutes ?? 0), 0);
  const totalEarned = shifts.all.reduce((sum, row) => {
    if (!row.workedMinutes) return sum;
    return (
      sum +
      calculateEarnings(
        {
          workedMinutes: row.workedMinutes,
          hourlyRate: row.rate,
          bonus: Number(row.bonus ?? 0),
          adjustments: Number(row.adjustments ?? 0),
        },
        settings,
      ).total
    );
  }, 0);

  const weekAhead = shifts.upcoming.filter(
    (row) => row.startsAt.getTime() < now.getTime() + 7 * 86_400_000,
  );

  return (
    <div className="animate-(--animate-crew-up) flex flex-col gap-6">
      <div>
        <p className="text-[13px] text-muted capitalize">{formatDateWithWeekday(now, tz)}</p>
        <h1 className="mt-1 text-[26px] leading-tight font-extrabold tracking-[-0.035em] sm:text-[28px]">
          {greeting(now)}, {session.user.firstName} 👋
        </h1>
      </div>

      {active ? (
        <OnShiftCard
          shiftId={active.shiftId}
          positionName={active.title ?? active.positionName}
          checkInAt={active.checkInAt!.toISOString()}
          checkInLabel={formatTime(active.checkInAt, tz)}
          rate={active.rate}
          currency={settings.currency}
          coordinatorName={
            active.coordinatorFirstName
              ? `${active.coordinatorFirstName} ${active.coordinatorLastName}`
              : null
          }
          conversationHref={active.coordinatorId ? `/portal/messages` : null}
          serverNow={now.getTime()}
        />
      ) : next ? (
        <div>
          <p className="eyebrow mb-2.5 text-muted">Najbližšia smena</p>
          <DarkCard className="p-6">
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-[28px] leading-none font-extrabold tracking-[-0.035em] sm:text-[32px]">
                {(next.title ?? next.positionName).toUpperCase()}
              </p>
              <p className="eyebrow shrink-0 text-accent">
                {next.assignmentStatus === "confirmed" ? "Potvrdená" : "Potvrď ju"}
              </p>
            </div>
            <div className="my-5 flex flex-col gap-1.5 text-[15px] text-white/72">
              <p className="capitalize">
                {formatDateWithWeekday(next.startsAt, tz)} ·{" "}
                {formatTimeRange(next.startsAt, next.endsAt, tz)}
              </p>
              <p>{next.location ?? event.location ?? "Miesto upresníme"}</p>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="nums text-[22px] font-bold tracking-[-0.02em]">
                {formatMoney(next.rate, settings.currency)}{" "}
                <span className="text-sm font-medium text-white/55">/ hod</span>
              </p>
              <ButtonLink href={`/portal/shifts/${next.shiftId}`} variant="accent">
                Zobraziť smenu
              </ButtonLink>
            </div>
          </DarkCard>
        </div>
      ) : (
        <Card>
          <EmptyState
            icon={<IconCalendar width={26} height={26} />}
            title="Zatiaľ žiadne smeny"
            description="Tvoje najbližšie smeny sa zobrazia tu. Koordinátor ti ich pridelí a dostaneš notifikáciu."
            action={
              <ButtonLink href="/portal/profile" variant="outline">
                Skontrolovať dostupnosť
              </ButtonLink>
            }
          />
        </Card>
      )}

      {awaiting.length > 0 ? (
        <div>
          <p className="eyebrow mb-2.5 text-muted">Potvrď smenu</p>
          <div className="flex flex-col gap-3">
            {awaiting.map((row) => (
              <Card key={row.assignmentId} className="p-5">
                <p className="text-[15px] font-bold">{row.positionName}</p>
                <p className="nums mt-1 text-[13px] text-muted capitalize">
                  {formatDateWithWeekday(row.startsAt, tz)} ·{" "}
                  {formatTimeRange(row.startsAt, row.endsAt, tz)}
                  {row.location ? ` · ${row.location}` : ""}
                </p>
                <p className="mt-2 text-[13px] text-muted">
                  Koordinátor potrebuje vedieť, či prídeš.
                </p>
                <div className="mt-4">
                  <ConfirmShiftButtons assignmentId={row.assignmentId} shiftId={row.shiftId} />
                </div>
              </Card>
            ))}
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-3 gap-2.5">
        <StatTile value={shifts.upcoming.length} label="smeny" />
        <StatTile value={formatDuration(totalMinutes)} label="odpracované" />
        <StatTile value={formatMoney(totalEarned, settings.currency)} label="zarobené" />
      </div>

      <div>
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 className="text-lg font-bold tracking-[-0.02em]">Tvoj týždeň</h2>
          <Link href="/portal/shifts" className="text-[13px] font-semibold text-muted hover:text-ink">
            Všetky smeny →
          </Link>
        </div>

        {weekAhead.length === 0 ? (
          <Card className="p-5">
            <p className="text-[15px] text-muted">
              Tento týždeň už nemáš žiadnu smenu. Voľné smeny nájdeš v sekcii Smeny.
            </p>
          </Card>
        ) : (
          <div className="flex flex-col gap-2.5">
            {weekAhead.slice(0, 4).map((shift) => (
              <ShiftCard
                key={shift.assignmentId}
                href={`/portal/shifts/${shift.shiftId}`}
                title={shift.title ?? shift.positionName}
                when={`${formatDateShort(shift.startsAt, tz)} · ${formatTimeRange(shift.startsAt, shift.endsAt, tz)}`}
                place={shift.location ?? event.location ?? "—"}
                rate={formatMoney(shift.rate, settings.currency)}
                hours={formatDuration(
                  Math.round((shift.endsAt.getTime() - shift.startsAt.getTime()) / 60_000),
                )}
                status={shift.assignmentStatus}
              />
            ))}
          </div>
        )}
      </div>

      <Link href="/portal/profile" className="block">
        <Card className="flex items-center gap-4 p-5 transition-colors hover:bg-hover">
          <div className="min-w-0 flex-1">
            <p className="eyebrow text-muted">Crew Score</p>
            <p className="nums mt-1.5 text-[28px] leading-none font-extrabold tracking-[-0.04em]">
              {score} <span className="text-sm font-medium text-faint">/ 100</span>
            </p>
          </div>
          <Pill kind={score >= 85 ? "ok" : score >= 60 ? "neutral" : "warn"}>
            {score >= 85 ? "Spoľahlivý" : score >= 60 ? "V poriadku" : "Pozor na dochádzku"}
          </Pill>
        </Card>
      </Link>
    </div>
  );
}
