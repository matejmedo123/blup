import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { CheckInButton } from "@/components/portal/CheckInButton";
import { ConfirmShiftButtons } from "@/components/portal/ConfirmShiftButtons";
import { Avatar } from "@/components/ui/Avatar";
import { ASSIGNMENT_STATUS_META, Pill, StatusPill } from "@/components/ui/Badge";
import { ButtonLink, RoundButton } from "@/components/ui/Button";
import { Card, PhotoSlot } from "@/components/ui/Card";
import { IconChevronLeft } from "@/components/ui/Icons";
import { requireStaff } from "@/lib/auth/guards";
import { eventSettings, getEventById } from "@/lib/domain/events";
import { portalShift, shiftColleagues } from "@/lib/domain/portal";
import {
  formatDateWithWeekday,
  formatDuration,
  formatMoney,
  formatTime,
  formatTimeRange,
} from "@/lib/format";

export const metadata: Metadata = { title: "Detail smeny" };

export default async function PortalShiftPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ t?: string }>;
}) {
  const session = await requireStaff();
  if (!session.eventId) notFound();

  const { id } = await params;
  const { t } = await searchParams;

  const [shift, event] = await Promise.all([
    portalShift(session.user.id, session.eventId, id),
    getEventById(session.eventId),
  ]);
  if (!shift || !event) notFound();

  const tz = event.timezone;
  const settings = eventSettings(event);
  const colleagues = shift.showColleagues ? await shiftColleagues(id, session.user.id) : [];

  const now = Date.now();
  const minutesToStart = (shift.startsAt.getTime() - now) / 60_000;
  const durationMinutes = Math.round(
    (shift.endsAt.getTime() - shift.startsAt.getTime()) / 60_000,
  );
  const estimate = (durationMinutes / 60) * shift.rate;

  const awaitingResponse =
    shift.assignmentStatus === "invited" || shift.assignmentStatus === "pending_confirmation";

  const checkInDisabledReason = shift.checkOutAt
    ? "Táto smena je odpracovaná. Ďakujeme!"
    : shift.checkInAt
      ? null
      : shift.assignmentStatus === "declined"
        ? "Túto smenu si odmietol. Ak chceš prísť, ozvi sa koordinátorovi."
        : minutesToStart > 60
          ? `Check-in sa otvorí hodinu pred začiatkom, teda o ${formatTime(new Date(shift.startsAt.getTime() - 3_600_000), tz)}.`
          : null;

  const mapHref =
    shift.lat && shift.lng
      ? `https://www.google.com/maps/search/?api=1&query=${shift.lat},${shift.lng}`
      : shift.location
        ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(shift.location)}`
        : null;

  return (
    <div className="animate-(--animate-crew-up) pb-28">
      <Link href="/portal/shifts" aria-label="Späť na smeny" className="inline-block">
        <RoundButton aria-label="Späť">
          <IconChevronLeft />
        </RoundButton>
      </Link>

      <div className="mt-5">
        <p className="eyebrow text-muted">
          {shift.assignmentStatus === "confirmed" ? "Potvrdená smena" : "Tvoja smena"}
        </p>
        <h1 className="mt-2 text-[32px] leading-tight font-extrabold tracking-[-0.04em] sm:text-[38px]">
          {shift.title ?? shift.positionName}
        </h1>
        <p className="mt-1.5 text-base text-muted capitalize">
          {formatDateWithWeekday(shift.startsAt, tz)} ·{" "}
          {formatTimeRange(shift.startsAt, shift.endsAt, tz)}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <StatusPill status={shift.assignmentStatus} meta={ASSIGNMENT_STATUS_META} />
          {shift.needsReplacement ? <Pill kind="bad">Hľadá sa náhrada</Pill> : null}
        </div>
      </div>

      {mapHref ? (
        <a href={mapHref} target="_blank" rel="noopener noreferrer" className="mt-5 block">
          <PhotoSlot
            caption={`mapa — ${shift.location ?? event.location ?? "miesto eventu"}`}
            className="h-[140px] rounded-16 transition-opacity hover:opacity-90 sm:h-[160px]"
          />
        </a>
      ) : null}

      <Card className="mt-5 px-5 py-1">
        <Row label="Miesto" value={shift.location ?? event.location ?? "—"} />
        <Row
          label="Tvoja sadzba"
          value={`${formatMoney(shift.rate, settings.currency)} / hod`}
          strong
        />
        <Row label="Dĺžka smeny" value={formatDuration(durationMinutes)} />
        <Row label="Odhad zárobku" value={formatMoney(estimate, settings.currency)} />
        {shift.coordinatorFirstName ? (
          <div className="flex items-center justify-between gap-3 border-t border-divider py-3.5">
            <span className="text-[15px] text-muted">Koordinátor</span>
            <Link href="/portal/messages" className="flex items-center gap-2.5">
              <Avatar
                firstName={shift.coordinatorFirstName}
                lastName={shift.coordinatorLastName ?? ""}
                size="sm"
                tone="dark"
              />
              <span className="text-[15px] font-semibold">{shift.coordinatorFirstName}</span>
            </Link>
          </div>
        ) : null}
      </Card>

      {awaitingResponse ? (
        <Card className="mt-5 p-5">
          <p className="text-[15px] font-semibold">Potvrď, že prídeš</p>
          <p className="mt-1 mb-4 text-[13px] text-muted">
            Koordinátor potrebuje vedieť, či s tebou môže rátať.
          </p>
          <ConfirmShiftButtons assignmentId={shift.assignmentId} shiftId={shift.shiftId} />
        </Card>
      ) : null}

      {shift.instructions || shift.dressCode ? (
        <section className="mt-7">
          <h2 className="mb-2.5 text-lg font-bold tracking-[-0.02em]">Inštrukcie</h2>
          {shift.instructions ? (
            <p className="text-[15px] leading-[1.6] text-body">{shift.instructions}</p>
          ) : null}
          {shift.dressCode ? (
            <p className="mt-3 text-[15px] leading-[1.6] text-body">
              <span className="font-semibold">Dresscode:</span> {shift.dressCode}
            </p>
          ) : null}
        </section>
      ) : null}

      {colleagues.length > 0 ? (
        <section className="mt-7">
          <h2 className="mb-3 text-lg font-bold tracking-[-0.02em]">
            Kto ešte robí ({colleagues.length})
          </h2>
          <div className="flex flex-wrap gap-2.5">
            {colleagues.map((person) => (
              <span
                key={person.userId}
                className="flex items-center gap-2 rounded-full border border-line bg-surface py-1.5 pr-3.5 pl-1.5"
              >
                <Avatar
                  firstName={person.firstName}
                  lastName={person.lastName}
                  src={person.avatarUrl}
                  size="xs"
                  className="size-7 text-[10px]"
                />
                <span className="text-[13px] font-medium">{person.firstName}</span>
              </span>
            ))}
          </div>
        </section>
      ) : null}

      {shift.checkInAt ? (
        <Card className="mt-7 p-5">
          <p className="eyebrow text-muted">Dochádzka</p>
          <p className="nums mt-2 text-[15px]">
            Check-in {formatTime(shift.checkInAt, tz)}
            {shift.checkOutAt ? ` · check-out ${formatTime(shift.checkOutAt, tz)}` : " · prebieha"}
          </p>
          {shift.workedMinutes ? (
            <p className="nums mt-1 text-[15px] font-semibold">
              Odpracované {formatDuration(shift.workedMinutes)}
            </p>
          ) : null}
        </Card>
      ) : null}

      {/* Sticky CTA nad spodnou navigáciou (§62) */}
      {!shift.checkOutAt && shift.assignmentStatus !== "declined" ? (
        <div className="safe-bottom fixed inset-x-0 bottom-[84px] z-20 bg-gradient-to-t from-bg from-70% to-transparent px-4 pt-4 pb-4 lg:static lg:mt-7 lg:bg-none lg:px-0 lg:pt-0">
          <div className="mx-auto max-w-[1100px] lg:max-w-none">
            {shift.checkInAt ? (
              <ButtonLink href="/portal" size="block" variant="dark">
                SI NA SMENE — ZOBRAZIŤ
              </ButtonLink>
            ) : (
              <CheckInButton
                shiftId={shift.shiftId}
                checkInMethod={shift.checkInMethod}
                qrToken={t ?? null}
                disabledReason={checkInDisabledReason}
              />
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-divider py-[18px] last:border-b-0">
      <span className="text-[15px] text-muted">{label}</span>
      <span className={strong ? "nums text-[17px] font-bold" : "text-[15px] font-semibold"}>
        {value}
      </span>
    </div>
  );
}
