import type { Metadata } from "next";
import { and, desc, eq } from "drizzle-orm";

import {
  AvailabilityForm,
  ExportDataButton,
  ProfileForm,
} from "@/components/portal/ProfileForms";
import { CrewScoreRing } from "@/components/admin/CrewScoreRing";
import { LogoutButton } from "@/components/layout/LogoutButton";
import { Avatar } from "@/components/ui/Avatar";
import { Pill } from "@/components/ui/Badge";
import { ButtonLink } from "@/components/ui/Button";
import { Card, DarkCard } from "@/components/ui/Card";
import { getDb } from "@/db/client";
import { availabilities, experiences } from "@/db/schema";
import { requireStaff } from "@/lib/auth/guards";
import { eventDays, eventSettings, getEventById } from "@/lib/domain/events";
import { calculateEarnings } from "@/lib/domain/payroll";
import { portalShifts } from "@/lib/domain/portal";
import { getCrewScore, scoreHistory } from "@/lib/domain/score";
import {
  formatDateShort,
  formatDuration,
  formatMoney,
} from "@/lib/format";
import { WORK_TYPE_LABELS } from "@/lib/labels";

export const metadata: Metadata = { title: "Profil" };

export default async function PortalProfilePage() {
  const session = await requireStaff();
  if (!session.eventId) return null;

  const event = await getEventById(session.eventId);
  if (!event) return null;

  const tz = event.timezone;
  const settings = eventSettings(event);
  const db = await getDb();

  const [shifts, score, scoreRows, experienceRows, availabilityRows] = await Promise.all([
    portalShifts(session.user.id, session.eventId),
    getCrewScore(session.user.id, session.eventId),
    scoreHistory(session.user.id, session.eventId),
    db
      .select()
      .from(experiences)
      .where(eq(experiences.userId, session.user.id))
      .orderBy(desc(experiences.dateFrom)),
    db
      .select()
      .from(availabilities)
      .where(
        and(
          eq(availabilities.userId, session.user.id),
          eq(availabilities.eventId, session.eventId),
        ),
      ),
  ]);

  const totalMinutes = shifts.all.reduce((sum, row) => sum + (row.workedMinutes ?? 0), 0);
  const total = shifts.all.reduce((sum, row) => {
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

  const noShows = shifts.all.filter((row) => row.attendanceStatus === "missing").length;
  const onTime = shifts.all.filter(
    (row) => row.attendanceStatus === "checked_out" || row.attendanceStatus === "checked_in",
  ).length;

  const chips = [
    score >= 80 ? "Spoľahlivý" : null,
    noShows === 0 && onTime > 0 ? "Chodí načas" : null,
    score >= 90 ? "Skvelá spätná väzba" : null,
  ].filter(Boolean) as string[];

  const availabilityMap = Object.fromEntries(
    availabilityRows.map((row) => [row.day, { timeFrom: row.timeFrom, timeTo: row.timeTo }]),
  );

  return (
    <div className="animate-(--animate-crew-up) flex flex-col gap-6">
      <div className="flex items-center gap-4">
        <Avatar
          firstName={session.user.firstName}
          lastName={session.user.lastName}
          src={session.user.avatarUrl}
          size="xl"
          tone="dark"
        />
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-extrabold tracking-[-0.03em]">
            {session.user.fullName}
          </h1>
          <p className="mt-0.5 truncate text-sm text-muted">
            {[session.user.city, event.name].filter(Boolean).join(" · ")}
          </p>
        </div>
      </div>

      <Card className="flex flex-wrap items-center gap-6 p-6">
        <CrewScoreRing score={score} />
        <div className="min-w-0 flex-1">
          <p className="eyebrow text-muted">Crew Score</p>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {chips.length > 0 ? (
              chips.map((chip, index) => (
                <span
                  key={chip}
                  className={
                    "rounded-8 px-2.5 py-1.5 text-xs font-semibold " +
                    (index === chips.length - 1 && score >= 90 ? "bg-accent" : "bg-subtle")
                  }
                >
                  {chip}
                </span>
              ))
            ) : (
              <p className="text-[13px] text-muted">
                Skóre rastie za dochvíľnosť a potvrdzovanie smien.
              </p>
            )}
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-3 gap-2.5">
        <Card className="p-4">
          <p className="nums text-[22px] leading-none font-bold tracking-[-0.02em]">
            {shifts.completed.length}
          </p>
          <p className="mt-1.5 text-xs text-muted">odpracované</p>
        </Card>
        <Card className="p-4">
          <p className="nums text-[22px] leading-none font-bold tracking-[-0.02em]">
            {formatDuration(totalMinutes)}
          </p>
          <p className="mt-1.5 text-xs text-muted">hodín</p>
        </Card>
        <Card className="p-4">
          <p className="nums text-[22px] leading-none font-bold tracking-[-0.02em]">{noShows}</p>
          <p className="mt-1.5 text-xs text-muted">no-show</p>
        </Card>
      </div>

      <DarkCard className="p-6">
        <p className="text-[13px] text-white/60">Zárobok · {event.name}</p>
        <p className="nums mt-1.5 text-[36px] leading-none font-extrabold tracking-[-0.045em]">
          {formatMoney(total, settings.currency)}
        </p>
        <ButtonLink href="/portal/earnings" variant="accent" size="sm" className="mt-4">
          Rozpis zárobku
        </ButtonLink>
      </DarkCard>

      <section>
        <h2 className="mb-3 text-lg font-bold tracking-[-0.02em]">Osobné údaje</h2>
        <Card className="p-5">
          <ProfileForm
            phone={session.user.phone ?? ""}
            city={session.user.city ?? ""}
            avatarUrl={session.user.avatarUrl ?? ""}
          />
        </Card>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-bold tracking-[-0.02em]">Dostupnosť</h2>
        <Card className="p-5">
          <AvailabilityForm
            eventDays={eventDays(event)}
            timezone={tz}
            initial={availabilityMap}
            initialMaxHours={availabilityRows[0]?.maxHours?.toString() ?? ""}
          />
        </Card>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-bold tracking-[-0.02em]">
          Skúsenosti ({experienceRows.length})
        </h2>
        <Card className="px-5 py-1">
          {experienceRows.length === 0 ? (
            <p className="py-4 text-[15px] text-muted">Zatiaľ žiadne skúsenosti.</p>
          ) : (
            experienceRows.map((experience) => (
              <div key={experience.id} className="border-b border-divider py-4 last:border-b-0">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-[15px] font-semibold">{experience.positionLabel}</p>
                  <p className="nums text-[13px] text-faint">
                    {formatDateShort(`${experience.dateFrom}T12:00:00Z`)} —{" "}
                    {experience.dateTo
                      ? formatDateShort(`${experience.dateTo}T12:00:00Z`)
                      : "teraz"}
                  </p>
                </div>
                <p className="mt-1 text-[13px] text-muted">
                  {experience.company} ·{" "}
                  {WORK_TYPE_LABELS[experience.workType as keyof typeof WORK_TYPE_LABELS] ??
                    experience.workType}
                </p>
              </div>
            ))
          )}
        </Card>
      </section>

      {scoreRows.length > 0 ? (
        <section>
          <h2 className="mb-3 text-lg font-bold tracking-[-0.02em]">História skóre</h2>
          <Card className="px-5 py-1">
            {scoreRows.slice(0, 10).map((row) => (
              <div
                key={row.id}
                className="flex items-center justify-between gap-3 border-b border-divider py-3.5 last:border-b-0"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{row.reason ?? row.ruleKey}</p>
                  <p className="text-[13px] text-faint">{formatDateShort(row.createdAt, tz)}</p>
                </div>
                <Pill kind={row.delta >= 0 ? "ok" : "bad"}>
                  {row.delta > 0 ? `+${row.delta}` : row.delta}
                </Pill>
              </div>
            ))}
          </Card>
        </section>
      ) : null}

      <section>
        <h2 className="mb-3 text-lg font-bold tracking-[-0.02em]">Tvoje údaje</h2>
        <Card className="flex flex-wrap items-center gap-3 p-5">
          <p className="min-w-0 flex-1 text-[13px] leading-[1.5] text-muted">
            Máš právo na kópiu všetkých údajov, ktoré o tebe evidujeme. Stiahne sa ako JSON súbor.
          </p>
          <ExportDataButton />
        </Card>
      </section>

      <LogoutButton fullWidth />
    </div>
  );
}
