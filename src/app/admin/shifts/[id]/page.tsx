import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AssignPanel } from "@/components/admin/AssignPanel";
import { PageHeader } from "@/components/admin/PageHeader";
import { ShiftActions } from "@/components/admin/ShiftActions";
import { ShiftChatButton } from "@/components/portal/OpenConversationButton";
import { SHIFT_STATUS_META, StatusPill } from "@/components/ui/Badge";
import { ButtonLink } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { IconChevronLeft } from "@/components/ui/Icons";
import { getAdminContext } from "@/lib/admin-context";
import { buildAssignmentProposals } from "@/lib/domain/auto-assign";
import { eventSettings } from "@/lib/domain/events";
import { getShift, listShiftAssignments } from "@/lib/domain/shifts";
import {
  formatDateLong,
  formatDuration,
  formatMoney,
  formatTimeRange,
} from "@/lib/format";
import { CHECK_IN_METHOD_LABELS } from "@/lib/labels";
import { can } from "@/lib/permissions";

export const metadata: Metadata = { title: "Detail smeny" };

export default async function ShiftDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const context = await getAdminContext();
  if (!context) return null;

  const { id } = await params;
  const shift = await getShift(id, context.eventId);
  if (!shift) notFound();

  const tz = context.event.timezone;
  const currency = eventSettings(context.event).currency;
  const canManage = can(context.actor, "can_manage_shifts");

  const [assignments, proposals] = await Promise.all([
    listShiftAssignments(id),
    canManage ? buildAssignmentProposals(context.eventId, [id]) : Promise.resolve([]),
  ]);

  const suggestions = proposals[0]
    ? [...proposals[0].picked, ...proposals[0].alternates]
    : [];

  const durationMinutes = Math.round(
    (shift.endsAt.getTime() - shift.startsAt.getTime()) / 60_000,
  );
  const rate = Number(shift.hourlyRate ?? shift.positionRate);
  const usesQr = shift.checkInMethod === "qr" || shift.checkInMethod === "qr_geofence";

  return (
    <>
      <Link
        href="/admin/shifts"
        className="mb-5 inline-flex items-center gap-1.5 text-[13px] font-semibold text-muted hover:text-ink"
      >
        <IconChevronLeft width={16} height={16} />
        Späť na smeny
      </Link>

      <PageHeader
        title={shift.title ?? shift.positionName}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <StatusPill status={shift.status} meta={SHIFT_STATUS_META} />
            <span className="capitalize">
              {formatDateLong(shift.startsAt, tz)} ·{" "}
              {formatTimeRange(shift.startsAt, shift.endsAt, tz)}
              {shift.location ? ` · ${shift.location}` : ""}
            </span>
          </span>
        }
        action={
          canManage ? (
            <>
              <ButtonLink href={`/admin/shifts/${id}/upravit`} variant="outline" size="sm">
                Upraviť
              </ButtonLink>
              <ShiftChatButton shiftId={id} target="admin" variant="outline" size="sm" />
              <ShiftActions shiftId={id} status={shift.status} usesQr={usesQr} />
            </>
          ) : null
        }
      />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)] lg:items-start">
        <Card className="p-5 sm:p-6">
          <AssignPanel
            shiftId={id}
            capacity={shift.capacity}
            canManage={canManage}
            timezone={tz}
            assigned={assignments.map((row) => ({
              assignmentId: row.assignmentId,
              userId: row.userId,
              firstName: row.firstName,
              lastName: row.lastName,
              avatarUrl: row.avatarUrl,
              phone: row.phone,
              status: row.status,
              needsReplacement: row.needsReplacement,
              workedMinutes: row.workedMinutes,
              checkInAt: row.checkInAt?.toISOString() ?? null,
            }))}
            suggestions={suggestions.map((candidate) => ({
              userId: candidate.userId,
              firstName: candidate.firstName,
              lastName: candidate.lastName,
              avatarUrl: candidate.avatarUrl,
              score: candidate.score,
              assignedHours: candidate.assignedHours,
              prefersPosition: candidate.prefersPosition,
              available: candidate.available,
              blockers: candidate.blockers,
            }))}
          />
        </Card>

        <div className="flex flex-col gap-5">
          <Card className="p-5 sm:p-6">
            <h2 className="section-label mb-4">Detaily</h2>
            <dl className="flex flex-col divide-y divide-divider">
              <Row label="Pozícia" value={shift.positionName} />
              <Row label="Trvanie" value={formatDuration(durationMinutes)} />
              <Row label="Sadzba" value={`${formatMoney(rate, currency)} / hod`} strong />
              <Row
                label="Odhad nákladu"
                value={formatMoney((durationMinutes / 60) * rate * shift.capacity, currency)}
              />
              <Row label="Check-in" value={CHECK_IN_METHOD_LABELS[shift.checkInMethod as keyof typeof CHECK_IN_METHOD_LABELS]} />
              <Row
                label="Koordinátor"
                value={
                  shift.coordinatorFirstName
                    ? `${shift.coordinatorFirstName} ${shift.coordinatorLastName}`
                    : "—"
                }
              />
            </dl>
          </Card>

          {usesQr ? (
            <Card className="p-5 sm:p-6">
              <h2 className="section-label mb-4">QR pre check-in</h2>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/qr/shift/${id}`}
                alt="QR kód pre check-in na túto smenu"
                width={220}
                height={220}
                className="mx-auto block rounded-12 border border-line bg-surface p-3"
              />
              <p className="mt-4 text-[13px] leading-[1.5] text-muted">
                Vytlač a nechaj na mieste. Crew ho naskenuje bežnou appkou fotoaparátu — otvorí sa
                im rovno check-in.
              </p>
              <ButtonLink
                href={`/api/qr/shift/${id}`}
                target="_blank"
                variant="outline"
                size="sm"
                className="mt-3.5"
              >
                Otvoriť na tlač
              </ButtonLink>
            </Card>
          ) : null}

          {shift.instructions || shift.dressCode ? (
            <Card className="p-5 sm:p-6">
              <h2 className="section-label mb-3.5">Pokyny</h2>
              {shift.instructions ? (
                <p className="text-[15px] leading-[1.6] text-body">{shift.instructions}</p>
              ) : null}
              {shift.dressCode ? (
                <p className="mt-3 text-[15px] leading-[1.6] text-body">
                  <span className="font-semibold">Dresscode:</span> {shift.dressCode}
                </p>
              ) : null}
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
      <dt className="text-[15px] text-muted">{label}</dt>
      <dd className={strong ? "nums text-[17px] font-bold" : "text-[15px] font-medium"}>{value}</dd>
    </div>
  );
}
