import type { Metadata } from "next";

import { ShiftCard } from "@/components/portal/ShiftCard";
import { ButtonLink } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/States";
import { IconCalendar } from "@/components/ui/Icons";
import { requireStaff } from "@/lib/auth/guards";
import { eventSettings, getEventById } from "@/lib/domain/events";
import { portalShifts } from "@/lib/domain/portal";
import {
  formatDateShort,
  formatDuration,
  formatMoney,
  formatTimeRange,
} from "@/lib/format";

export const metadata: Metadata = { title: "Moje smeny" };

export default async function PortalShiftsPage() {
  const session = await requireStaff();
  if (!session.eventId) return null;

  const event = await getEventById(session.eventId);
  if (!event) return null;

  const tz = event.timezone;
  const currency = eventSettings(event).currency;
  const shifts = await portalShifts(session.user.id, session.eventId);

  const sections = [
    { key: "active", title: "Prebieha", rows: shifts.active },
    { key: "upcoming", title: "Nadchádzajúce", rows: shifts.upcoming },
    { key: "completed", title: "Odpracované", rows: [...shifts.completed].reverse() },
  ];

  const hasAny = shifts.all.length > 0;

  return (
    <div className="animate-(--animate-crew-up) flex flex-col gap-7">
      <h1 className="text-[28px] leading-tight font-extrabold tracking-[-0.035em] sm:text-[30px]">
        Moje smeny
      </h1>

      {!hasAny ? (
        <Card>
          <EmptyState
            icon={<IconCalendar width={26} height={26} />}
            title="Zatiaľ žiadne smeny"
            description="Tvoje najbližšie smeny sa zobrazia tu. Skontroluj si dostupnosť v profile, nech ti vieme prideliť tie správne."
            action={<ButtonLink href="/portal/profile">Upraviť dostupnosť</ButtonLink>}
          />
        </Card>
      ) : (
        sections
          .filter((section) => section.rows.length > 0)
          .map((section) => (
            <section key={section.key}>
              <div className="mb-3 flex items-baseline justify-between gap-3">
                <h2 className="text-lg font-bold tracking-[-0.02em]">{section.title}</h2>
                <span className="text-[13px] text-muted">{section.rows.length}</span>
              </div>
              <div className="flex flex-col gap-2.5">
                {section.rows.map((shift) => (
                  <ShiftCard
                    key={shift.assignmentId}
                    href={`/portal/shifts/${shift.shiftId}`}
                    title={shift.title ?? shift.positionName}
                    when={`${formatDateShort(shift.startsAt, tz)} · ${formatTimeRange(shift.startsAt, shift.endsAt, tz)}`}
                    place={shift.location ?? event.location ?? "—"}
                    rate={formatMoney(shift.rate, currency)}
                    hours={
                      shift.workedMinutes
                        ? formatDuration(shift.workedMinutes)
                        : formatDuration(
                            Math.round(
                              (shift.endsAt.getTime() - shift.startsAt.getTime()) / 60_000,
                            ),
                          )
                    }
                    status={shift.assignmentStatus}
                  />
                ))}
              </div>
            </section>
          ))
      )}
    </div>
  );
}
