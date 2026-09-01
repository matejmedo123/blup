import "server-only";

import { and, asc, count, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";

import { getDb } from "@/db/client";
import type { AttendanceStatus } from "@/db/enums";
import {
  attendance,
  positions,
  shiftAssignments,
  shifts,
  users,
} from "@/db/schema";

export type LiveAttendanceRow = {
  attendanceId: string | null;
  assignmentId: string;
  userId: string;
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
  positionName: string;
  shiftId: string;
  startsAt: Date;
  endsAt: Date;
  status: AttendanceStatus;
  checkInAt: Date | null;
  checkOutAt: Date | null;
  workedMinutes: number | null;
  approved: boolean;
};

/**
 * Živý pohľad na dochádzku. Ak dochádzkový záznam ešte neexistuje,
 * odvodíme stav z času smeny: po začiatku bez check-inu = `missing`.
 */
export async function liveAttendance(
  eventId: string,
  options: { from?: Date; to?: Date; now?: Date } = {},
): Promise<LiveAttendanceRow[]> {
  const db = await getDb();
  const now = options.now ?? new Date();
  const from = options.from ?? startOfDay(now);
  const to = options.to ?? new Date(startOfDay(now).getTime() + 86_400_000);

  const rows = await db
    .select({
      attendanceId: attendance.id,
      assignmentId: shiftAssignments.id,
      userId: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
      avatarUrl: users.avatarUrl,
      positionName: positions.name,
      shiftId: shifts.id,
      startsAt: shifts.startsAt,
      endsAt: shifts.endsAt,
      status: attendance.status,
      checkInAt: attendance.checkInAt,
      checkOutAt: attendance.checkOutAt,
      workedMinutes: attendance.workedMinutes,
      approved: attendance.approved,
    })
    .from(shiftAssignments)
    .innerJoin(shifts, eq(shifts.id, shiftAssignments.shiftId))
    .innerJoin(positions, eq(positions.id, shifts.positionId))
    .innerJoin(users, eq(users.id, shiftAssignments.userId))
    .leftJoin(attendance, eq(attendance.assignmentId, shiftAssignments.id))
    .where(
      and(
        eq(shiftAssignments.eventId, eventId),
        inArray(shiftAssignments.status, ["confirmed", "pending_confirmation", "invited", "completed"]),
        isNull(shifts.deletedAt),
        gte(shifts.startsAt, from),
        lte(shifts.startsAt, to),
      ),
    )
    .orderBy(asc(shifts.startsAt), asc(users.lastName));

  return rows.map((row) => ({
    ...row,
    approved: row.approved ?? false,
    status: derivedStatus(row.status, row.startsAt, row.checkInAt, now),
  }));
}

/** Bez záznamu odvodíme stav z času — po 15 min od štartu je človek `missing`. */
export function derivedStatus(
  stored: AttendanceStatus | null,
  startsAt: Date,
  checkInAt: Date | null,
  now: Date,
): AttendanceStatus {
  if (stored && stored !== "not_started") return stored;
  if (checkInAt) return "checked_in";
  if (now.getTime() > startsAt.getTime() + 15 * 60_000) return "missing";
  return "not_started";
}

export type LiveCounts = { working: number; expected: number; missing: number; done: number };

export async function liveCounts(eventId: string, now = new Date()): Promise<LiveCounts> {
  const rows = await liveAttendance(eventId, { now });
  const counts: LiveCounts = { working: 0, expected: 0, missing: 0, done: 0 };
  for (const row of rows) {
    if (row.status === "checked_in" || row.status === "late") counts.working += 1;
    else if (row.status === "checked_out" || row.status === "manually_corrected") counts.done += 1;
    else if (row.status === "missing") counts.missing += 1;
    else counts.expected += 1;
  }
  return counts;
}

/** Ľudia, ktorí práve pracujú — „Live crew“ na dashboarde. */
export async function currentlyWorking(eventId: string, limit = 8) {
  const db = await getDb();
  return db
    .select({
      userId: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
      avatarUrl: users.avatarUrl,
      positionName: positions.name,
      location: shifts.location,
      checkInAt: attendance.checkInAt,
      status: attendance.status,
      shiftId: shifts.id,
    })
    .from(attendance)
    .innerJoin(shifts, eq(shifts.id, attendance.shiftId))
    .innerJoin(positions, eq(positions.id, shifts.positionId))
    .innerJoin(users, eq(users.id, attendance.userId))
    .where(
      and(
        eq(attendance.eventId, eventId),
        inArray(attendance.status, ["checked_in", "late"]),
        isNull(attendance.checkOutAt),
      ),
    )
    .orderBy(asc(attendance.checkInAt))
    .limit(limit);
}

export async function countMissingCheckIns(eventId: string, now = new Date()): Promise<number> {
  const counts = await liveCounts(eventId, now);
  return counts.missing;
}

export async function attendanceForUser(userId: string, eventId: string) {
  const db = await getDb();
  return db
    .select({
      attendanceId: attendance.id,
      shiftId: shifts.id,
      positionName: positions.name,
      startsAt: shifts.startsAt,
      endsAt: shifts.endsAt,
      status: attendance.status,
      checkInAt: attendance.checkInAt,
      checkOutAt: attendance.checkOutAt,
      workedMinutes: attendance.workedMinutes,
      approved: attendance.approved,
      hourlyRate: shifts.hourlyRate,
      positionRate: positions.hourlyRate,
      bonus: attendance.bonus,
      adjustments: attendance.adjustments,
    })
    .from(attendance)
    .innerJoin(shifts, eq(shifts.id, attendance.shiftId))
    .innerJoin(positions, eq(positions.id, shifts.positionId))
    .where(and(eq(attendance.userId, userId), eq(attendance.eventId, eventId)))
    .orderBy(asc(shifts.startsAt));
}

export async function countAttendanceByStatus(eventId: string) {
  const db = await getDb();
  const rows = await db
    .select({ status: attendance.status, value: count() })
    .from(attendance)
    .where(eq(attendance.eventId, eventId))
    .groupBy(attendance.status);
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.value)])) as Partial<
    Record<AttendanceStatus, number>
  >;
}

/** Súčet odpracovaných minút — voliteľne len zo schválených záznamov (Rule 6). */
export async function totalWorkedMinutes(
  userId: string,
  eventId: string,
  onlyApproved = false,
): Promise<number> {
  const db = await getDb();
  const conditions = [eq(attendance.userId, userId), eq(attendance.eventId, eventId)];
  if (onlyApproved) conditions.push(eq(attendance.approved, true));
  const [row] = await db
    .select({ value: sql<number>`coalesce(sum(${attendance.workedMinutes}), 0)::int` })
    .from(attendance)
    .where(and(...conditions));
  return Number(row?.value ?? 0);
}

function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

export { startOfDay };
