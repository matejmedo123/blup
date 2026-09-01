import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { getDb } from "@/db/client";
import { attendance, shiftAssignments } from "@/db/schema";
import { signShiftQr } from "@/lib/auth/tokens";
import {
  distanceMeters,
  performCheckIn,
  performCheckOut,
} from "@/lib/domain/check-in";
import { derivedStatus, liveCounts } from "@/lib/domain/attendance";
import { getCrewScore } from "@/lib/domain/score";
import { makeAssignment, makeShift, makeWorld } from "./factories";

/** Smena, ktorá práve beží — check-in je otvorený. */
async function runningShift(overrides: Record<string, unknown> = {}) {
  const world = await makeWorld();
  const startsAt = new Date(Date.now() - 5 * 60_000);
  const shift = await makeShift(world.event.id, world.position.id, {
    startsAt,
    endsAt: new Date(startsAt.getTime() + 6 * 3_600_000),
    status: "in_progress",
    ...overrides,
  });
  const assignment = await makeAssignment(shift.id, world.staff.id, world.event.id);
  return { ...world, shift, assignment };
}

describe("vzdialenosť", () => {
  it("počíta vzdialenosť medzi bodmi", () => {
    const bratislava = { lat: 48.148598, lng: 17.107748 };
    expect(distanceMeters(bratislava, bratislava)).toBe(0);
    // ~1,1 km na sever
    const north = { lat: 48.158598, lng: 17.107748 };
    const distance = distanceMeters(bratislava, north);
    expect(distance).toBeGreaterThan(1000);
    expect(distance).toBeLessThan(1200);
  });
});

describe("check-in", () => {
  it("zapíše check-in a potvrdí pridelenie", async () => {
    const db = await getDb();
    const { event, staff, shift, assignment } = await runningShift();

    const result = await performCheckIn({
      shiftId: shift.id,
      targetUserId: staff.id,
      actorId: staff.id,
      eventId: event.id,
      source: "self",
    });

    expect(result.replayed).toBe(false);
    const [row] = await db.select().from(attendance).where(eq(attendance.id, result.attendanceId));
    expect(row.checkInAt).not.toBeNull();
    expect(row.status).toBe("checked_in");

    const [assignmentRow] = await db
      .select()
      .from(shiftAssignments)
      .where(eq(shiftAssignments.id, assignment.id));
    expect(assignmentRow.status).toBe("confirmed");
  });

  it("dvojitý check-in nie je možný", async () => {
    const { event, staff, shift } = await runningShift();
    await performCheckIn({
      shiftId: shift.id,
      targetUserId: staff.id,
      actorId: staff.id,
      eventId: event.id,
      source: "self",
    });

    await expect(
      performCheckIn({
        shiftId: shift.id,
        targetUserId: staff.id,
        actorId: staff.id,
        eventId: event.id,
        source: "self",
      }),
    ).rejects.toThrow(/už si checknutý/i);
  });

  it("rovnaký idempotency key vráti pôvodnú odpoveď namiesto druhého zápisu", async () => {
    const db = await getDb();
    const { event, staff, shift } = await runningShift();

    const first = await performCheckIn({
      shiftId: shift.id,
      targetUserId: staff.id,
      actorId: staff.id,
      eventId: event.id,
      source: "self",
      idempotencyKey: "retry-key-1",
    });
    const second = await performCheckIn({
      shiftId: shift.id,
      targetUserId: staff.id,
      actorId: staff.id,
      eventId: event.id,
      source: "self",
      idempotencyKey: "retry-key-1",
    });

    expect(second.replayed).toBe(true);
    expect(second.attendanceId).toBe(first.attendanceId);

    const rows = await db.select().from(attendance).where(eq(attendance.shiftId, shift.id));
    expect(rows).toHaveLength(1);
  });

  it("nepridelený človek sa nechekne", async () => {
    const { event, admin, position } = await makeWorld();
    const startsAt = new Date(Date.now() - 60_000);
    const shift = await makeShift(event.id, position.id, {
      startsAt,
      endsAt: new Date(startsAt.getTime() + 3_600_000),
    });

    await expect(
      performCheckIn({
        shiftId: shift.id,
        targetUserId: admin.id,
        actorId: admin.id,
        eventId: event.id,
        source: "self",
      }),
    ).rejects.toThrow(/nie si pridelený/i);
  });

  it("check-in sa neotvorí príliš skoro", async () => {
    const { event, staff, position } = await makeWorld();
    const startsAt = new Date(Date.now() + 5 * 3_600_000);
    const shift = await makeShift(event.id, position.id, {
      startsAt,
      endsAt: new Date(startsAt.getTime() + 6 * 3_600_000),
    });
    await makeAssignment(shift.id, staff.id, event.id);

    await expect(
      performCheckIn({
        shiftId: shift.id,
        targetUserId: staff.id,
        actorId: staff.id,
        eventId: event.id,
        source: "self",
      }),
    ).rejects.toThrow(/skoro/i);
  });

  it("meškanie sa označí a zníži skóre", async () => {
    const { event, staff, position } = await makeWorld();
    const startsAt = new Date(Date.now() - 40 * 60_000);
    const shift = await makeShift(event.id, position.id, {
      startsAt,
      endsAt: new Date(startsAt.getTime() + 6 * 3_600_000),
    });
    await makeAssignment(shift.id, staff.id, event.id);

    const before = await getCrewScore(staff.id, event.id);
    const result = await performCheckIn({
      shiftId: shift.id,
      targetUserId: staff.id,
      actorId: staff.id,
      eventId: event.id,
      source: "self",
    });

    expect(result.late).toBe(true);
    expect(result.lateMinutes).toBeGreaterThanOrEqual(39);
    expect(await getCrewScore(staff.id, event.id)).toBeLessThan(before);
  });

  it("QR smena vyžaduje platný token", async () => {
    const { event, staff, shift } = await runningShift({ checkInMethod: "qr" });

    await expect(
      performCheckIn({
        shiftId: shift.id,
        targetUserId: staff.id,
        actorId: staff.id,
        eventId: event.id,
        source: "qr",
        qrToken: "nespravny-token",
      }),
    ).rejects.toThrow(/QR/i);
  });

  it("QR smena prejde so správnym podpisom", async () => {
    const db = await getDb();
    const { event, staff, shift } = await runningShift({
      checkInMethod: "qr",
      qrSecret: "tajomstvo-smeny",
    });

    const result = await performCheckIn({
      shiftId: shift.id,
      targetUserId: staff.id,
      actorId: staff.id,
      eventId: event.id,
      source: "qr",
      qrToken: signShiftQr(shift.id, "tajomstvo-smeny"),
    });

    const [row] = await db.select().from(attendance).where(eq(attendance.id, result.attendanceId));
    expect(row.checkInSource).toBe("qr");
  });

  it("geofence odmietne check-in mimo okruhu", async () => {
    const { event, staff, shift } = await runningShift({
      checkInMethod: "geofence",
      lat: "48.148598",
      lng: "17.107748",
      geofenceRadiusM: 150,
    });

    await expect(
      performCheckIn({
        shiftId: shift.id,
        targetUserId: staff.id,
        actorId: staff.id,
        eventId: event.id,
        source: "geofence",
        lat: 48.2,
        lng: 17.2,
      }),
    ).rejects.toThrow(/m od miesta/i);
  });

  it("geofence pustí check-in v okruhu", async () => {
    const { event, staff, shift } = await runningShift({
      checkInMethod: "geofence",
      lat: "48.148598",
      lng: "17.107748",
      geofenceRadiusM: 300,
    });

    const result = await performCheckIn({
      shiftId: shift.id,
      targetUserId: staff.id,
      actorId: staff.id,
      eventId: event.id,
      source: "geofence",
      lat: 48.149,
      lng: 17.108,
    });
    expect(result.attendanceId).toBeTruthy();
  });

  it("koordinátor môže checknúť za iného bez QR a polohy", async () => {
    const { event, staff, coordinator, shift } = await runningShift({ checkInMethod: "qr" });

    const result = await performCheckIn({
      shiftId: shift.id,
      targetUserId: staff.id,
      actorId: coordinator.id,
      eventId: event.id,
      source: "coordinator",
    });
    expect(result.attendanceId).toBeTruthy();
  });
});

describe("check-out", () => {
  it("nedá sa checknúť out bez check-inu", async () => {
    const { event, staff, shift } = await runningShift();
    await expect(
      performCheckOut({
        shiftId: shift.id,
        targetUserId: staff.id,
        actorId: staff.id,
        eventId: event.id,
        source: "self",
      }),
    ).rejects.toThrow(/najprv/i);
  });

  it("check-out zapíše odpracovaný čas", async () => {
    const db = await getDb();
    const { event, staff, shift } = await runningShift();

    await performCheckIn({
      shiftId: shift.id,
      targetUserId: staff.id,
      actorId: staff.id,
      eventId: event.id,
      source: "self",
    });
    const result = await performCheckOut({
      shiftId: shift.id,
      targetUserId: staff.id,
      actorId: staff.id,
      eventId: event.id,
      source: "self",
    });

    expect(result.workedMinutes).toBeGreaterThanOrEqual(0);
    const [row] = await db.select().from(attendance).where(eq(attendance.id, result.attendanceId));
    expect(row.status).toBe("checked_out");
    expect(row.checkOutAt).not.toBeNull();
  });

  it("dvojitý check-out nie je možný", async () => {
    const { event, staff, shift } = await runningShift();
    await performCheckIn({
      shiftId: shift.id,
      targetUserId: staff.id,
      actorId: staff.id,
      eventId: event.id,
      source: "self",
    });
    await performCheckOut({
      shiftId: shift.id,
      targetUserId: staff.id,
      actorId: staff.id,
      eventId: event.id,
      source: "self",
    });

    await expect(
      performCheckOut({
        shiftId: shift.id,
        targetUserId: staff.id,
        actorId: staff.id,
        eventId: event.id,
        source: "self",
      }),
    ).rejects.toThrow(/už ukončil/i);
  });

  it("prestávka sa odráta z odpracovaného času", async () => {
    const db = await getDb();
    const { event, staff, shift } = await runningShift();

    const checkIn = await performCheckIn({
      shiftId: shift.id,
      targetUserId: staff.id,
      actorId: staff.id,
      eventId: event.id,
      source: "self",
    });

    // Posunieme check-in o hodinu dozadu, aby bolo z čoho odrátať.
    await db
      .update(attendance)
      .set({ checkInAt: new Date(Date.now() - 60 * 60_000) })
      .where(eq(attendance.id, checkIn.attendanceId));

    const result = await performCheckOut({
      shiftId: shift.id,
      targetUserId: staff.id,
      actorId: staff.id,
      eventId: event.id,
      source: "self",
      breakMinutes: 30,
    });
    expect(result.workedMinutes).toBeGreaterThanOrEqual(28);
    expect(result.workedMinutes).toBeLessThanOrEqual(32);
  });
});

describe("databázové obmedzenia dochádzky", () => {
  it("nedovolí check-out bez check-inu", async () => {
    const db = await getDb();
    const { event, staff, shift, assignment } = await runningShift();

    await expect(
      db.insert(attendance).values({
        assignmentId: assignment.id,
        shiftId: shift.id,
        userId: staff.id,
        eventId: event.id,
        status: "checked_out",
        checkOutAt: new Date(),
      }),
    ).rejects.toThrow();
  });

  it("nedovolí check-out pred check-inom", async () => {
    const db = await getDb();
    const { event, staff, shift, assignment } = await runningShift();
    const now = new Date();

    await expect(
      db.insert(attendance).values({
        assignmentId: assignment.id,
        shiftId: shift.id,
        userId: staff.id,
        eventId: event.id,
        status: "checked_out",
        checkInAt: now,
        checkOutAt: new Date(now.getTime() - 60_000),
      }),
    ).rejects.toThrow();
  });
});

describe("odvodený stav a živé počty", () => {
  it("bez check-inu po začiatku je človek označený ako chýbajúci", () => {
    const startsAt = new Date(Date.now() - 30 * 60_000);
    expect(derivedStatus(null, startsAt, null, new Date())).toBe("missing");
  });

  it("pred začiatkom je stav nezačaté", () => {
    const startsAt = new Date(Date.now() + 30 * 60_000);
    expect(derivedStatus(null, startsAt, null, new Date())).toBe("not_started");
  });

  it("uložený stav má prednosť pred odvodením", () => {
    const startsAt = new Date(Date.now() - 30 * 60_000);
    expect(derivedStatus("checked_out", startsAt, new Date(), new Date())).toBe("checked_out");
  });

  it("živé počty rozlíšia pracujúcich a chýbajúcich", async () => {
    const { event, staff, shift } = await runningShift();
    await performCheckIn({
      shiftId: shift.id,
      targetUserId: staff.id,
      actorId: staff.id,
      eventId: event.id,
      source: "self",
    });

    const counts = await liveCounts(event.id);
    expect(counts.working).toBeGreaterThanOrEqual(1);
  });
});
