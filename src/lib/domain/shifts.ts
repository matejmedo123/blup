import "server-only";

import { and, asc, count, eq, gte, inArray, isNull, lt, lte, ne, or, sql, type SQL } from "drizzle-orm";

import type { Database } from "@/db/client";
import { getDb } from "@/db/client";
import type { AssignmentStatus, ShiftStatus } from "@/db/enums";
import {
  attendance,
  eventMembers,
  positions,
  shiftAssignments,
  shifts,
  users,
} from "@/db/schema";

export type ShiftWithMeta = {
  id: string;
  title: string | null;
  startsAt: Date;
  endsAt: Date;
  location: string | null;
  capacity: number;
  status: ShiftStatus;
  hourlyRate: string | null;
  checkInMethod: "manual" | "qr" | "geofence" | "qr_geofence";
  instructions: string | null;
  dressCode: string | null;
  showColleagues: boolean;
  lat: string | null;
  lng: string | null;
  geofenceRadiusM: number;
  positionId: string;
  positionName: string;
  positionColor: string;
  positionRate: string;
  coordinatorId: string | null;
  coordinatorFirstName: string | null;
  coordinatorLastName: string | null;
  filled: number;
};

/** Počet obsadených miest = pridelenia, ktoré neboli zrušené ani odmietnuté. */
export const ACTIVE_ASSIGNMENT_STATUSES: AssignmentStatus[] = [
  "invited",
  "pending_confirmation",
  "confirmed",
  "completed",
];

/**
 * Korelácia je napísaná ako `"shifts"."id"` zámerne: drizzle vykresľuje stĺpce
 * v SELECT zozname nekvalifikovane, takže `${shifts.id}` by sa vnútri poddotazu
 * naviazalo na `sa.id` a počet by vyšiel vždy 0. Platí pre dotazy nad `shifts`
 * bez aliasu.
 */
const filledExpr = sql<number>`(
  select count(*)::int from ${shiftAssignments} sa
  where sa.shift_id = "shifts"."id"
    and sa.status in ('invited', 'pending_confirmation', 'confirmed', 'completed')
)`;

export function shiftSelection() {
  return {
    id: shifts.id,
    title: shifts.title,
    startsAt: shifts.startsAt,
    endsAt: shifts.endsAt,
    location: shifts.location,
    capacity: shifts.capacity,
    status: shifts.status,
    hourlyRate: shifts.hourlyRate,
    checkInMethod: shifts.checkInMethod,
    instructions: shifts.instructions,
    dressCode: shifts.dressCode,
    showColleagues: shifts.showColleagues,
    lat: shifts.lat,
    lng: shifts.lng,
    geofenceRadiusM: shifts.geofenceRadiusM,
    positionId: positions.id,
    positionName: positions.name,
    positionColor: positions.color,
    positionRate: positions.hourlyRate,
    coordinatorId: shifts.coordinatorId,
    coordinatorFirstName: users.firstName,
    coordinatorLastName: users.lastName,
    filled: filledExpr,
  };
}

export type ShiftFilters = {
  q?: string;
  status?: ShiftStatus;
  positionId?: string;
  coordinatorId?: string;
  from?: Date;
  to?: Date;
  page?: number;
  pageSize?: number;
};

export async function listShifts(
  eventId: string,
  filters: ShiftFilters = {},
): Promise<{ rows: ShiftWithMeta[]; total: number; page: number; pageCount: number; pageSize: number }> {
  const db = await getDb();
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = filters.pageSize ?? 50;

  const conditions: SQL[] = [eq(shifts.eventId, eventId), isNull(shifts.deletedAt)];
  if (filters.status) conditions.push(eq(shifts.status, filters.status));
  if (filters.positionId) conditions.push(eq(shifts.positionId, filters.positionId));
  if (filters.coordinatorId) conditions.push(eq(shifts.coordinatorId, filters.coordinatorId));
  if (filters.from) conditions.push(gte(shifts.startsAt, filters.from));
  if (filters.to) conditions.push(lte(shifts.startsAt, filters.to));
  if (filters.q) {
    const like = `%${filters.q}%`;
    const search = or(
      sql`${positions.name} ilike ${like}`,
      sql`${shifts.location} ilike ${like}`,
      sql`${shifts.title} ilike ${like}`,
    );
    if (search) conditions.push(search);
  }
  const where = and(...conditions);

  const [rows, [{ value: total }]] = await Promise.all([
    db
      .select(shiftSelection())
      .from(shifts)
      .innerJoin(positions, eq(positions.id, shifts.positionId))
      .leftJoin(users, eq(users.id, shifts.coordinatorId))
      .where(where)
      .orderBy(asc(shifts.startsAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db
      .select({ value: count() })
      .from(shifts)
      .innerJoin(positions, eq(positions.id, shifts.positionId))
      .where(where),
  ]);

  return {
    rows,
    total: Number(total),
    page,
    pageCount: Math.max(1, Math.ceil(Number(total) / pageSize)),
    pageSize,
  };
}

export async function getShift(shiftId: string, eventId: string): Promise<ShiftWithMeta | null> {
  const db = await getDb();
  const [row] = await db
    .select(shiftSelection())
    .from(shifts)
    .innerJoin(positions, eq(positions.id, shifts.positionId))
    .leftJoin(users, eq(users.id, shifts.coordinatorId))
    .where(and(eq(shifts.id, shiftId), eq(shifts.eventId, eventId), isNull(shifts.deletedAt)))
    .limit(1);
  return row ?? null;
}

export type AssignmentRow = {
  assignmentId: string;
  userId: string;
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
  phone: string | null;
  status: AssignmentStatus;
  needsReplacement: boolean;
  confirmedAt: Date | null;
  attendanceStatus: string | null;
  checkInAt: Date | null;
  checkOutAt: Date | null;
  workedMinutes: number | null;
};

export async function listShiftAssignments(shiftId: string): Promise<AssignmentRow[]> {
  const db = await getDb();
  return db
    .select({
      assignmentId: shiftAssignments.id,
      userId: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
      avatarUrl: users.avatarUrl,
      phone: users.phone,
      status: shiftAssignments.status,
      needsReplacement: shiftAssignments.needsReplacement,
      confirmedAt: shiftAssignments.confirmedAt,
      attendanceStatus: attendance.status,
      checkInAt: attendance.checkInAt,
      checkOutAt: attendance.checkOutAt,
      workedMinutes: attendance.workedMinutes,
    })
    .from(shiftAssignments)
    .innerJoin(users, eq(users.id, shiftAssignments.userId))
    .leftJoin(attendance, eq(attendance.assignmentId, shiftAssignments.id))
    .where(eq(shiftAssignments.shiftId, shiftId))
    .orderBy(asc(users.lastName));
}

/**
 * Nájde smeny daného človeka, ktoré sa časovo prekrývajú s intervalom.
 * Rule 7: automatické ani manuálne prideľovanie nesmie vytvoriť prekryv.
 */
export async function findOverlappingAssignments(args: {
  userId: string;
  startsAt: Date;
  endsAt: Date;
  excludeShiftId?: string;
  tx?: Database;
}): Promise<{ shiftId: string; positionName: string; startsAt: Date; endsAt: Date }[]> {
  const db = args.tx ?? (await getDb());
  const conditions: SQL[] = [
    eq(shiftAssignments.userId, args.userId),
    inArray(shiftAssignments.status, ACTIVE_ASSIGNMENT_STATUSES),
    isNull(shifts.deletedAt),
    ne(shifts.status, "cancelled"),
    // Klasický test prekryvu intervalov: start < otherEnd && end > otherStart
    lt(shifts.startsAt, args.endsAt),
    sql`${shifts.endsAt} > ${args.startsAt}`,
  ];
  if (args.excludeShiftId) conditions.push(ne(shifts.id, args.excludeShiftId));

  return db
    .select({
      shiftId: shifts.id,
      positionName: positions.name,
      startsAt: shifts.startsAt,
      endsAt: shifts.endsAt,
    })
    .from(shiftAssignments)
    .innerJoin(shifts, eq(shifts.id, shiftAssignments.shiftId))
    .innerJoin(positions, eq(positions.id, shifts.positionId))
    .where(and(...conditions));
}

export function shiftDurationHours(shift: { startsAt: Date; endsAt: Date }): number {
  return (shift.endsAt.getTime() - shift.startsAt.getTime()) / 3_600_000;
}

/** Efektívna hodinovka smeny — vlastná sadzba prebíja sadzbu pozície. */
export function effectiveRate(shift: { hourlyRate: string | null; positionRate: string }): number {
  const raw = shift.hourlyRate ?? shift.positionRate;
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}

/** Prepočíta stav smeny podľa obsadenosti a času (draft ostáva draftom). */
export async function refreshShiftStatus(shiftId: string, tx?: Database): Promise<void> {
  const db = tx ?? (await getDb());
  const [row] = await db
    .select({
      id: shifts.id,
      status: shifts.status,
      capacity: shifts.capacity,
      startsAt: shifts.startsAt,
      endsAt: shifts.endsAt,
      filled: filledExpr,
    })
    .from(shifts)
    .where(eq(shifts.id, shiftId))
    .limit(1);

  if (!row) return;
  if (row.status === "draft" || row.status === "cancelled") return;

  const now = Date.now();
  let next: ShiftStatus;
  if (row.endsAt.getTime() < now) next = "completed";
  else if (row.startsAt.getTime() <= now) next = "in_progress";
  else next = Number(row.filled) >= row.capacity ? "full" : "published";

  if (next !== row.status) {
    await db.update(shifts).set({ status: next, updatedAt: new Date() }).where(eq(shifts.id, shiftId));
  }
}

/** Smeny, ktoré dnes prebiehajú alebo sa dnes začínajú — pre admin dashboard. */
export async function todaysShifts(eventId: string, now = new Date()): Promise<ShiftWithMeta[]> {
  const db = await getDb();
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);

  return db
    .select(shiftSelection())
    .from(shifts)
    .innerJoin(positions, eq(positions.id, shifts.positionId))
    .leftJoin(users, eq(users.id, shifts.coordinatorId))
    .where(
      and(
        eq(shifts.eventId, eventId),
        isNull(shifts.deletedAt),
        ne(shifts.status, "cancelled"),
        lt(shifts.startsAt, dayEnd),
        sql`${shifts.endsAt} > ${dayStart}`,
      ),
    )
    .orderBy(asc(shifts.startsAt));
}

export async function upcomingShifts(eventId: string, limit = 6): Promise<ShiftWithMeta[]> {
  const db = await getDb();
  return db
    .select(shiftSelection())
    .from(shifts)
    .innerJoin(positions, eq(positions.id, shifts.positionId))
    .leftJoin(users, eq(users.id, shifts.coordinatorId))
    .where(
      and(
        eq(shifts.eventId, eventId),
        isNull(shifts.deletedAt),
        ne(shifts.status, "cancelled"),
        gte(shifts.startsAt, new Date()),
      ),
    )
    .orderBy(asc(shifts.startsAt))
    .limit(limit);
}

export async function shiftsNeedingReplacement(eventId: string) {
  const db = await getDb();
  return db
    .select({
      assignmentId: shiftAssignments.id,
      shiftId: shifts.id,
      positionName: positions.name,
      startsAt: shifts.startsAt,
      firstName: users.firstName,
      lastName: users.lastName,
      declineReason: shiftAssignments.declineReason,
    })
    .from(shiftAssignments)
    .innerJoin(shifts, eq(shifts.id, shiftAssignments.shiftId))
    .innerJoin(positions, eq(positions.id, shifts.positionId))
    .innerJoin(users, eq(users.id, shiftAssignments.userId))
    .where(
      and(
        eq(shiftAssignments.eventId, eventId),
        eq(shiftAssignments.needsReplacement, true),
        gte(shifts.startsAt, new Date()),
      ),
    )
    .orderBy(asc(shifts.startsAt))
    .limit(10);
}

/** Pridelenia, ktoré začínajú do 48 h a stále nie sú potvrdené (§25 Alerts). */
export async function unconfirmedAssignments(eventId: string, withinHours = 48) {
  const db = await getDb();
  const now = new Date();
  const until = new Date(now.getTime() + withinHours * 3_600_000);

  return db
    .select({
      assignmentId: shiftAssignments.id,
      shiftId: shifts.id,
      positionName: positions.name,
      startsAt: shifts.startsAt,
      firstName: users.firstName,
      lastName: users.lastName,
    })
    .from(shiftAssignments)
    .innerJoin(shifts, eq(shifts.id, shiftAssignments.shiftId))
    .innerJoin(positions, eq(positions.id, shifts.positionId))
    .innerJoin(users, eq(users.id, shiftAssignments.userId))
    .where(
      and(
        eq(shiftAssignments.eventId, eventId),
        inArray(shiftAssignments.status, ["invited", "pending_confirmation"]),
        gte(shifts.startsAt, now),
        lte(shifts.startsAt, until),
        isNull(shifts.deletedAt),
      ),
    )
    .orderBy(asc(shifts.startsAt))
    .limit(20);
}

export async function occupancy(eventId: string): Promise<{ filled: number; capacity: number }> {
  const db = await getDb();
  const [row] = await db
    .select({
      capacity: sql<number>`coalesce(sum(${shifts.capacity}), 0)::int`,
      filled: sql<number>`coalesce(sum((
        select count(*) from ${shiftAssignments} sa
        where sa.shift_id = "shifts"."id"
          and sa.status in ('invited', 'pending_confirmation', 'confirmed', 'completed')
      )), 0)::int`,
    })
    .from(shifts)
    .where(
      and(
        eq(shifts.eventId, eventId),
        isNull(shifts.deletedAt),
        inArray(shifts.status, ["published", "full", "in_progress", "completed"]),
      ),
    );
  return { filled: Number(row?.filled ?? 0), capacity: Number(row?.capacity ?? 0) };
}

export async function countShiftsByStatus(eventId: string) {
  const db = await getDb();
  const rows = await db
    .select({ status: shifts.status, value: count() })
    .from(shifts)
    .where(and(eq(shifts.eventId, eventId), isNull(shifts.deletedAt)))
    .groupBy(shifts.status);
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.value)])) as Partial<
    Record<ShiftStatus, number>
  >;
}

export async function listPositions(eventId: string, onlyActive = false) {
  const db = await getDb();
  const conditions: SQL[] = [eq(positions.eventId, eventId), isNull(positions.deletedAt)];
  if (onlyActive) conditions.push(eq(positions.active, true));
  return db
    .select()
    .from(positions)
    .where(and(...conditions))
    .orderBy(asc(positions.name));
}

/** Ľudia, ktorí môžu byť koordinátormi smeny — admini a koordinátori eventu. */
export async function listCoordinators(eventId: string) {
  const db = await getDb();
  return db
    .select({
      id: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
    })
    .from(users)
    .innerJoin(eventMembers, eq(eventMembers.userId, users.id))
    .where(
      and(
        eq(eventMembers.eventId, eventId),
        eq(eventMembers.active, true),
        inArray(eventMembers.role, ["admin", "coordinator"]),
        isNull(users.deletedAt),
      ),
    )
    .orderBy(asc(users.lastName));
}

export { filledExpr };
