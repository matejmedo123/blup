import { eq } from "drizzle-orm";

import { getDb } from "@/db/client";
import type { EventRole } from "@/db/enums";
import {
  crewScores,
  eventMembers,
  events,
  positions,
  shiftAssignments,
  shifts,
  users,
  type EventPermissions,
} from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { generateToken } from "@/lib/auth/tokens";

let counter = 0;
const unique = () => `${Date.now().toString(36)}-${(counter += 1)}`;

export async function makeEvent(overrides: Partial<typeof events.$inferInsert> = {}) {
  const db = await getDb();
  const slug = `event-${unique()}`;
  const [row] = await db
    .insert(events)
    .values({
      name: `Test event ${slug}`,
      slug,
      startDate: "2026-09-11",
      endDate: "2026-09-14",
      timezone: "Europe/Bratislava",
      status: "active",
      settings: { currency: "EUR", rounding: "exact" },
      ...overrides,
    })
    .returning();
  return row;
}

export async function makeUser(
  overrides: Partial<typeof users.$inferInsert> = {},
  password = "test-password-1",
) {
  const db = await getDb();
  const [row] = await db
    .insert(users)
    .values({
      email: `user-${unique()}@test.local`,
      passwordHash: await hashPassword(password),
      firstName: "Test",
      lastName: "User",
      globalRole: "staff",
      status: "active",
      emailVerifiedAt: new Date(),
      ...overrides,
    })
    .returning();
  return row;
}

export async function makeMember(
  userId: string,
  eventId: string,
  role: EventRole = "staff",
  permissions: EventPermissions = {},
) {
  const db = await getDb();
  const [row] = await db
    .insert(eventMembers)
    .values({ userId, eventId, role, permissions })
    .returning();
  await db.insert(crewScores).values({ userId, eventId, score: 70 }).onConflictDoNothing();
  return row;
}

export async function makePosition(
  eventId: string,
  overrides: Partial<typeof positions.$inferInsert> = {},
) {
  const db = await getDb();
  const slug = `pos-${unique()}`;
  const [row] = await db
    .insert(positions)
    .values({
      eventId,
      name: `Position ${slug}`,
      slug,
      hourlyRate: "10.00",
      capacity: 5,
      ...overrides,
    })
    .returning();
  return row;
}

export async function makeShift(
  eventId: string,
  positionId: string,
  overrides: Partial<typeof shifts.$inferInsert> = {},
) {
  const db = await getDb();
  const startsAt = overrides.startsAt ?? new Date(Date.now() + 2 * 3_600_000);
  const endsAt = overrides.endsAt ?? new Date(new Date(startsAt).getTime() + 6 * 3_600_000);
  const [row] = await db
    .insert(shifts)
    .values({
      capacity: 3,
      status: "published",
      checkInMethod: "manual",
      ...overrides,
      eventId,
      positionId,
      startsAt,
      endsAt,
      qrSecret: overrides.qrSecret ?? generateToken(16),
    })
    .returning();
  return row;
}

export async function makeAssignment(
  shiftId: string,
  userId: string,
  eventId: string,
  overrides: Partial<typeof shiftAssignments.$inferInsert> = {},
) {
  const db = await getDb();
  const [row] = await db
    .insert(shiftAssignments)
    .values({ shiftId, userId, eventId, status: "confirmed", ...overrides })
    .returning();
  return row;
}

/** Kompletná zostava event + admin + coordinator + staff + pozícia. */
export async function makeWorld() {
  const event = await makeEvent();
  const admin = await makeUser({ globalRole: "admin" });
  const coordinator = await makeUser();
  const staff = await makeUser();

  await makeMember(admin.id, event.id, "admin");
  await makeMember(coordinator.id, event.id, "coordinator", {
    can_check_in_others: true,
    can_check_out_others: true,
    can_edit_attendance: true,
  });
  await makeMember(staff.id, event.id, "staff");

  const position = await makePosition(event.id);
  return { event, admin, coordinator, staff, position };
}

export async function eventById(id: string) {
  const db = await getDb();
  const [row] = await db.select().from(events).where(eq(events.id, id)).limit(1);
  return row;
}
