import "server-only";

import { and, asc, count, desc, eq, ilike, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";

import { getDb } from "@/db/client";
import type { EventRole, UserStatus } from "@/db/enums";
import {
  attendance,
  crewScores,
  eventMembers,
  positions,
  ratings,
  shiftAssignments,
  shifts,
  users,
  type EventPermissions,
} from "@/db/schema";

export type StaffRow = {
  userId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  city: string | null;
  avatarUrl: string | null;
  status: UserStatus;
  role: EventRole;
  permissions: EventPermissions;
  score: number;
  shiftCount: number;
  minutes: number;
  noShows: number;
};

export type StaffFilters = {
  q?: string;
  role?: EventRole;
  status?: UserStatus;
  positionId?: string;
  minScore?: number;
  sort?: "name" | "score" | "hours" | "shifts";
  page?: number;
  pageSize?: number;
};

const PAGE_SIZE = 25;

export async function listStaff(
  eventId: string,
  filters: StaffFilters = {},
): Promise<{ rows: StaffRow[]; total: number; page: number; pageCount: number; pageSize: number }> {
  const db = await getDb();
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = filters.pageSize ?? PAGE_SIZE;

  const conditions: SQL[] = [
    eq(eventMembers.eventId, eventId),
    eq(eventMembers.active, true),
    isNull(users.deletedAt),
  ];
  if (filters.role) conditions.push(eq(eventMembers.role, filters.role));
  if (filters.status) conditions.push(eq(users.status, filters.status));
  if (filters.q) {
    const like = `%${filters.q}%`;
    const search = or(
      ilike(users.firstName, like),
      ilike(users.lastName, like),
      ilike(users.email, like),
      ilike(users.phone, like),
      ilike(users.city, like),
      sql`lower(${users.firstName} || ' ' || ${users.lastName}) like lower(${like})`,
    );
    if (search) conditions.push(search);
  }
  if (filters.positionId) {
    conditions.push(
      sql`exists (
        select 1 from ${shiftAssignments} sa
        join ${shifts} s on s.id = sa.shift_id
        where sa.user_id = "users"."id" and s.position_id = ${filters.positionId}
      )`,
    );
  }
  if (filters.minScore != null) {
    conditions.push(sql`coalesce(${crewScores.score}, 70) >= ${filters.minScore}`);
  }
  const where = and(...conditions);

  // Korelácia musí byť kvalifikovaná — pozri poznámku pri `filledExpr` v `shifts.ts`.
  const shiftCountExpr = sql<number>`(
    select count(*)::int from ${shiftAssignments} sa
    where sa.user_id = "users"."id" and sa.event_id = ${eventId}
      and sa.status in ('confirmed','completed')
  )`;
  const minutesExpr = sql<number>`(
    select coalesce(sum(a.worked_minutes), 0)::int from ${attendance} a
    where a.user_id = "users"."id" and a.event_id = ${eventId}
  )`;
  const noShowExpr = sql<number>`(
    select count(*)::int from ${attendance} a
    where a.user_id = "users"."id" and a.event_id = ${eventId} and a.status = 'missing'
  )`;

  const orderBy = (() => {
    switch (filters.sort) {
      case "score":
        return [desc(sql`coalesce(${crewScores.score}, 70)`)];
      case "hours":
        return [desc(minutesExpr)];
      case "shifts":
        return [desc(shiftCountExpr)];
      default:
        return [asc(users.lastName), asc(users.firstName)];
    }
  })();

  const [rows, [{ value: total }]] = await Promise.all([
    db
      .select({
        userId: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
        phone: users.phone,
        city: users.city,
        avatarUrl: users.avatarUrl,
        status: users.status,
        role: eventMembers.role,
        permissions: eventMembers.permissions,
        score: sql<number>`coalesce(${crewScores.score}, 70)::int`,
        shiftCount: shiftCountExpr,
        minutes: minutesExpr,
        noShows: noShowExpr,
      })
      .from(eventMembers)
      .innerJoin(users, eq(users.id, eventMembers.userId))
      .leftJoin(
        crewScores,
        and(eq(crewScores.userId, users.id), eq(crewScores.eventId, eventId)),
      )
      .where(where)
      .orderBy(...orderBy)
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db
      .select({ value: count() })
      .from(eventMembers)
      .innerJoin(users, eq(users.id, eventMembers.userId))
      .leftJoin(
        crewScores,
        and(eq(crewScores.userId, users.id), eq(crewScores.eventId, eventId)),
      )
      .where(where),
  ]);

  return {
    rows: rows.map((row) => ({ ...row, permissions: row.permissions ?? {} })),
    total: Number(total),
    page,
    pageCount: Math.max(1, Math.ceil(Number(total) / pageSize)),
    pageSize,
  };
}

export async function getStaffMember(userId: string, eventId: string) {
  const db = await getDb();
  const [row] = await db
    .select({
      user: users,
      role: eventMembers.role,
      permissions: eventMembers.permissions,
      memberActive: eventMembers.active,
      score: crewScores.score,
    })
    .from(users)
    .leftJoin(
      eventMembers,
      and(eq(eventMembers.userId, users.id), eq(eventMembers.eventId, eventId)),
    )
    .leftJoin(crewScores, and(eq(crewScores.userId, users.id), eq(crewScores.eventId, eventId)))
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1);

  if (!row) return null;
  return {
    user: row.user,
    role: (row.role ?? "staff") as EventRole,
    permissions: (row.permissions ?? {}) as EventPermissions,
    memberActive: row.memberActive ?? false,
    score: row.score ?? 70,
  };
}

export async function staffShifts(userId: string, eventId: string) {
  const db = await getDb();
  return db
    .select({
      assignmentId: shiftAssignments.id,
      shiftId: shifts.id,
      positionName: positions.name,
      startsAt: shifts.startsAt,
      endsAt: shifts.endsAt,
      location: shifts.location,
      status: shiftAssignments.status,
      needsReplacement: shiftAssignments.needsReplacement,
      attendanceStatus: attendance.status,
      workedMinutes: attendance.workedMinutes,
      hourlyRate: shifts.hourlyRate,
      positionRate: positions.hourlyRate,
    })
    .from(shiftAssignments)
    .innerJoin(shifts, eq(shifts.id, shiftAssignments.shiftId))
    .innerJoin(positions, eq(positions.id, shifts.positionId))
    .leftJoin(attendance, eq(attendance.assignmentId, shiftAssignments.id))
    .where(and(eq(shiftAssignments.userId, userId), eq(shiftAssignments.eventId, eventId)))
    .orderBy(desc(shifts.startsAt));
}

export async function staffRatings(userId: string, eventId: string) {
  const db = await getDb();
  const rater = { firstName: users.firstName, lastName: users.lastName };
  return db
    .select({
      id: ratings.id,
      reliability: ratings.reliability,
      punctuality: ratings.punctuality,
      workEthic: ratings.workEthic,
      communication: ratings.communication,
      quality: ratings.quality,
      overall: ratings.overall,
      note: ratings.note,
      createdAt: ratings.createdAt,
      raterFirstName: rater.firstName,
      raterLastName: rater.lastName,
      positionName: positions.name,
      startsAt: shifts.startsAt,
    })
    .from(ratings)
    .innerJoin(users, eq(users.id, ratings.raterId))
    .leftJoin(shifts, eq(shifts.id, ratings.shiftId))
    .leftJoin(positions, eq(positions.id, shifts.positionId))
    .where(and(eq(ratings.staffId, userId), eq(ratings.eventId, eventId)))
    .orderBy(desc(ratings.createdAt));
}

export async function averageRating(userId: string, eventId: string): Promise<number | null> {
  const db = await getDb();
  const [row] = await db
    .select({ value: sql<string>`avg(${ratings.overall})` })
    .from(ratings)
    .where(and(eq(ratings.staffId, userId), eq(ratings.eventId, eventId)));
  const value = Number(row?.value);
  return Number.isFinite(value) && row?.value != null ? Math.round(value * 100) / 100 : null;
}

export async function countStaffByRole(eventId: string) {
  const db = await getDb();
  const rows = await db
    .select({ role: eventMembers.role, value: count() })
    .from(eventMembers)
    .innerJoin(users, eq(users.id, eventMembers.userId))
    .where(
      and(
        eq(eventMembers.eventId, eventId),
        eq(eventMembers.active, true),
        isNull(users.deletedAt),
      ),
    )
    .groupBy(eventMembers.role);
  return Object.fromEntries(rows.map((r) => [r.role, Number(r.value)])) as Partial<
    Record<EventRole, number>
  >;
}

/** Kandidáti na pridelenie — crew eventu, ktorá na danú smenu ešte nie je. */
export async function assignableStaff(eventId: string, excludeUserIds: string[] = []) {
  const db = await getDb();
  const conditions: SQL[] = [
    eq(eventMembers.eventId, eventId),
    eq(eventMembers.active, true),
    eq(users.status, "active"),
    isNull(users.deletedAt),
  ];
  if (excludeUserIds.length > 0) conditions.push(notInArray(users.id, excludeUserIds));

  return db
    .select({
      userId: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
      avatarUrl: users.avatarUrl,
      city: users.city,
      score: sql<number>`coalesce(${crewScores.score}, 70)::int`,
    })
    .from(eventMembers)
    .innerJoin(users, eq(users.id, eventMembers.userId))
    .leftJoin(crewScores, and(eq(crewScores.userId, users.id), eq(crewScores.eventId, eventId)))
    .where(and(...conditions))
    .orderBy(asc(users.lastName));
}
