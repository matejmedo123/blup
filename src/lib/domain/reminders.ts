import "server-only";

import { and, eq, gte, inArray, isNull, lte, ne, sql } from "drizzle-orm";

import { getDb } from "@/db/client";
import {
  attendance,
  eventMembers,
  events,
  notifications,
  positions,
  shiftAssignments,
  shifts,
  users,
} from "@/db/schema";
import { emailTemplates } from "@/lib/email/templates";
import { formatDateShort, formatTimeRange } from "@/lib/format";

import { markMissingAttendance } from "./check-in";
import { eventSettings } from "./events";
import { notify } from "./notifications";
import { pruneExpiredSessions } from "@/lib/auth/session";

export type ReminderReport = {
  confirmations: number;
  reminders: number;
  checkInReminders: number;
  checkOutReminders: number;
  markedMissing: number;
  prunedSessions: number;
};

/** Notifikáciu daného typu pošleme na jednu smenu iba raz. */
async function alreadySent(
  userId: string,
  shiftId: string,
  type: "shift_reminder" | "shift_confirmation_required" | "check_in_reminder" | "check_out_reminder",
): Promise<boolean> {
  const db = await getDb();
  const [row] = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        eq(notifications.entityId, shiftId),
        eq(notifications.type, type),
      ),
    )
    .limit(1);
  return !!row;
}

/**
 * Jedno spustenie „hodinových“ úloh (§18, §19).
 * Idempotentné — opakované spustenie nepošle notifikáciu dvakrát.
 */
export async function runReminders(now = new Date()): Promise<ReminderReport> {
  const db = await getDb();
  const report: ReminderReport = {
    confirmations: 0,
    reminders: 0,
    checkInReminders: 0,
    checkOutReminders: 0,
    markedMissing: 0,
    prunedSessions: 0,
  };

  const activeEvents = await db
    .select()
    .from(events)
    .where(and(eq(events.status, "active"), isNull(events.deletedAt)));

  for (const event of activeEvents) {
    const settings = eventSettings(event);
    const tz = event.timezone;
    const windowStart = now;
    const windowEnd = new Date(now.getTime() + settings.reminder_hours_before * 3_600_000);

    const upcoming = await db
      .select({
        assignmentId: shiftAssignments.id,
        assignmentStatus: shiftAssignments.status,
        shiftId: shifts.id,
        startsAt: shifts.startsAt,
        endsAt: shifts.endsAt,
        location: shifts.location,
        positionName: positions.name,
        userId: users.id,
        email: users.email,
        firstName: users.firstName,
        coordinatorId: shifts.coordinatorId,
      })
      .from(shiftAssignments)
      .innerJoin(shifts, eq(shifts.id, shiftAssignments.shiftId))
      .innerJoin(positions, eq(positions.id, shifts.positionId))
      .innerJoin(users, eq(users.id, shiftAssignments.userId))
      .where(
        and(
          eq(shiftAssignments.eventId, event.id),
          inArray(shiftAssignments.status, ["invited", "pending_confirmation", "confirmed"]),
          isNull(shifts.deletedAt),
          ne(shifts.status, "cancelled"),
          gte(shifts.startsAt, windowStart),
          lte(shifts.startsAt, windowEnd),
        ),
      );

    for (const row of upcoming) {
      const when = `${formatDateShort(row.startsAt, tz)} · ${formatTimeRange(row.startsAt, row.endsAt, tz)}`;
      const needsConfirmation = row.assignmentStatus !== "confirmed";
      const type = needsConfirmation ? "shift_confirmation_required" : "shift_reminder";

      if (await alreadySent(row.userId, row.shiftId, type)) continue;

      const coordinator = row.coordinatorId
        ? (
            await db
              .select({ firstName: users.firstName, lastName: users.lastName })
              .from(users)
              .where(eq(users.id, row.coordinatorId))
              .limit(1)
          )[0]
        : null;

      await notify(
        {
          userId: row.userId,
          eventId: event.id,
          type,
          title: needsConfirmation ? "Potvrď zajtrajšiu smenu" : "Zajtra máš smenu",
          body: `${row.positionName} · ${when}${row.location ? ` · ${row.location}` : ""}`,
          actionUrl: `/portal/shifts/${row.shiftId}`,
          entityType: "shift",
          entityId: row.shiftId,
          requiresAction: needsConfirmation,
        },
        {
          email: needsConfirmation
            ? emailTemplates.shiftConfirmationRequired({
                to: row.email,
                firstName: row.firstName,
                positionName: row.positionName,
                when,
                shiftId: row.shiftId,
              })
            : emailTemplates.shiftReminder({
                to: row.email,
                firstName: row.firstName,
                positionName: row.positionName,
                when,
                location: row.location ?? event.location ?? "—",
                coordinator: coordinator
                  ? `${coordinator.firstName} ${coordinator.lastName}`
                  : "—",
                shiftId: row.shiftId,
              }),
        },
      );

      if (needsConfirmation) report.confirmations += 1;
      else report.reminders += 1;
    }

    // Check-in pripomienka: smena už začala a človek sa ešte nechekol.
    const startedWithoutCheckIn = await db
      .select({
        userId: shiftAssignments.userId,
        shiftId: shifts.id,
        positionName: positions.name,
        startsAt: shifts.startsAt,
      })
      .from(shiftAssignments)
      .innerJoin(shifts, eq(shifts.id, shiftAssignments.shiftId))
      .innerJoin(positions, eq(positions.id, shifts.positionId))
      .leftJoin(attendance, eq(attendance.assignmentId, shiftAssignments.id))
      .where(
        and(
          eq(shiftAssignments.eventId, event.id),
          inArray(shiftAssignments.status, ["confirmed", "pending_confirmation", "invited"]),
          isNull(shifts.deletedAt),
          ne(shifts.status, "cancelled"),
          isNull(attendance.checkInAt),
          sql`${shifts.startsAt} <= ${new Date(now.getTime() - 10 * 60_000)}`,
          sql`${shifts.endsAt} > ${now}`,
        ),
      );

    for (const row of startedWithoutCheckIn) {
      if (await alreadySent(row.userId, row.shiftId, "check_in_reminder")) continue;
      await notify({
        userId: row.userId,
        eventId: event.id,
        type: "check_in_reminder",
        title: "Nezabudni na check-in",
        body: `${row.positionName} · smena už beží. Bez check-inu sa ti nerátajú hodiny.`,
        actionUrl: `/portal/shifts/${row.shiftId}`,
        entityType: "shift",
        entityId: row.shiftId,
      });
      report.checkInReminders += 1;
    }

    // Check-out pripomienka: smena skončila a človek je stále „na smene“.
    const endedWithoutCheckOut = await db
      .select({
        userId: attendance.userId,
        shiftId: shifts.id,
        positionName: positions.name,
      })
      .from(attendance)
      .innerJoin(shifts, eq(shifts.id, attendance.shiftId))
      .innerJoin(positions, eq(positions.id, shifts.positionId))
      .where(
        and(
          eq(attendance.eventId, event.id),
          inArray(attendance.status, ["checked_in", "late"]),
          isNull(attendance.checkOutAt),
          sql`${shifts.endsAt} < ${new Date(now.getTime() - 15 * 60_000)}`,
        ),
      );

    for (const row of endedWithoutCheckOut) {
      if (await alreadySent(row.userId, row.shiftId, "check_out_reminder")) continue;
      await notify({
        userId: row.userId,
        eventId: event.id,
        type: "check_out_reminder",
        title: "Nezabudni na check-out",
        body: `${row.positionName} · smena skončila. Ukonči ju, nech sedia hodiny.`,
        actionUrl: `/portal/shifts/${row.shiftId}`,
        entityType: "shift",
        entityId: row.shiftId,
      });
      report.checkOutReminders += 1;
    }

    report.markedMissing += await markMissingAttendance(event.id);
  }

  report.prunedSessions = await pruneExpiredSessions();
  return report;
}

/** Kto na evente dostane alert o probléme — admini a koordinátori. */
export async function eventLeadUserIds(eventId: string): Promise<string[]> {
  const db = await getDb();
  const rows = await db
    .select({ userId: eventMembers.userId })
    .from(eventMembers)
    .where(
      and(
        eq(eventMembers.eventId, eventId),
        eq(eventMembers.active, true),
        inArray(eventMembers.role, ["admin", "coordinator"]),
      ),
    );
  return rows.map((row) => row.userId);
}
