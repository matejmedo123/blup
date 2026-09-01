import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { getDb } from "@/db/client";
import { shiftAssignments, shifts } from "@/db/schema";
import { buildAssignmentProposals } from "@/lib/domain/auto-assign";
import {
  effectiveRate,
  findOverlappingAssignments,
  listShiftAssignments,
  refreshShiftStatus,
  shiftDurationHours,
} from "@/lib/domain/shifts";
import { shiftSchema } from "@/lib/validation/scheduling";
import { makeAssignment, makeShift, makeUser, makeWorld, makeMember } from "./factories";

describe("validácia smeny", () => {
  const base = {
    positionId: "3f6d1c9e-4b7a-4c1d-8e2f-9a0b1c2d3e4f",
    startsAt: "2026-09-12T18:00",
    endsAt: "2026-09-13T00:00",
    capacity: 4,
  };

  it("prijme platnú smenu", () => {
    expect(shiftSchema.safeParse(base).success).toBe(true);
  });

  it("odmietne koniec pred začiatkom", () => {
    const result = shiftSchema.safeParse({ ...base, endsAt: "2026-09-12T17:00" });
    expect(result.success).toBe(false);
  });

  it("odmietne nulovú kapacitu", () => {
    expect(shiftSchema.safeParse({ ...base, capacity: 0 }).success).toBe(false);
  });

  it("pri geofence vyžaduje súradnice", () => {
    const result = shiftSchema.safeParse({ ...base, checkInMethod: "geofence" });
    expect(result.success).toBe(false);
  });

  it("geofence so súradnicami prejde", () => {
    const result = shiftSchema.safeParse({
      ...base,
      checkInMethod: "geofence",
      lat: 48.148,
      lng: 17.107,
    });
    expect(result.success).toBe(true);
  });
});

describe("konflikty smien", () => {
  it("nájde prekrývajúcu sa smenu", async () => {
    const { event, staff, position } = await makeWorld();

    const start = new Date(Date.now() + 24 * 3_600_000);
    const first = await makeShift(event.id, position.id, {
      startsAt: start,
      endsAt: new Date(start.getTime() + 6 * 3_600_000),
    });
    await makeAssignment(first.id, staff.id, event.id);

    // Prekryv o dve hodiny.
    const overlapping = await findOverlappingAssignments({
      userId: staff.id,
      startsAt: new Date(start.getTime() + 4 * 3_600_000),
      endsAt: new Date(start.getTime() + 10 * 3_600_000),
    });
    expect(overlapping).toHaveLength(1);
    expect(overlapping[0].shiftId).toBe(first.id);
  });

  it("nadväzujúca smena nie je konflikt", async () => {
    const { event, staff, position } = await makeWorld();
    const start = new Date(Date.now() + 24 * 3_600_000);
    const first = await makeShift(event.id, position.id, {
      startsAt: start,
      endsAt: new Date(start.getTime() + 6 * 3_600_000),
    });
    await makeAssignment(first.id, staff.id, event.id);

    const overlapping = await findOverlappingAssignments({
      userId: staff.id,
      startsAt: new Date(start.getTime() + 6 * 3_600_000),
      endsAt: new Date(start.getTime() + 12 * 3_600_000),
    });
    expect(overlapping).toHaveLength(0);
  });

  it("zrušené pridelenie sa nepočíta ako konflikt", async () => {
    const { event, staff, position } = await makeWorld();
    const start = new Date(Date.now() + 24 * 3_600_000);
    const first = await makeShift(event.id, position.id, {
      startsAt: start,
      endsAt: new Date(start.getTime() + 6 * 3_600_000),
    });
    await makeAssignment(first.id, staff.id, event.id, { status: "cancelled" });

    const overlapping = await findOverlappingAssignments({
      userId: staff.id,
      startsAt: start,
      endsAt: new Date(start.getTime() + 6 * 3_600_000),
    });
    expect(overlapping).toHaveLength(0);
  });
});

describe("databázové obmedzenia smeny", () => {
  it("nedovolí koniec pred začiatkom", async () => {
    const { event, position } = await makeWorld();
    const start = new Date(Date.now() + 3_600_000);
    await expect(
      makeShift(event.id, position.id, { startsAt: start, endsAt: new Date(start.getTime() - 60_000) }),
    ).rejects.toThrow();
  });

  it("nedovolí duplicitné pridelenie tej istej osoby", async () => {
    const { event, staff, position } = await makeWorld();
    const shift = await makeShift(event.id, position.id);
    await makeAssignment(shift.id, staff.id, event.id);
    await expect(makeAssignment(shift.id, staff.id, event.id)).rejects.toThrow();
  });
});

describe("stav a sadzba smeny", () => {
  it("smena sa označí ako obsadená pri naplnení kapacity", async () => {
    const db = await getDb();
    const { event, position } = await makeWorld();
    const shift = await makeShift(event.id, position.id, { capacity: 2, status: "published" });

    for (let i = 0; i < 2; i += 1) {
      const person = await makeUser();
      await makeMember(person.id, event.id);
      await makeAssignment(shift.id, person.id, event.id);
    }

    await refreshShiftStatus(shift.id);
    const [row] = await db.select().from(shifts).where(eq(shifts.id, shift.id)).limit(1);
    expect(row.status).toBe("full");
  });

  it("vlastná sadzba smeny prebíja sadzbu pozície", () => {
    expect(effectiveRate({ hourlyRate: "12.00", positionRate: "8.50" })).toBe(12);
    expect(effectiveRate({ hourlyRate: null, positionRate: "8.50" })).toBe(8.5);
  });

  it("dĺžka smeny sa počíta v hodinách", () => {
    const start = new Date("2026-09-12T18:00:00Z");
    expect(shiftDurationHours({ startsAt: start, endsAt: new Date("2026-09-13T00:00:00Z") })).toBe(6);
  });
});

describe("automatické prideľovanie", () => {
  it("nikdy nenavrhne človeka na prekrývajúcu sa smenu (Rule 7)", async () => {
    const { event, staff, position } = await makeWorld();
    const start = new Date(Date.now() + 24 * 3_600_000);

    const busy = await makeShift(event.id, position.id, {
      startsAt: start,
      endsAt: new Date(start.getTime() + 6 * 3_600_000),
    });
    await makeAssignment(busy.id, staff.id, event.id);

    const clashing = await makeShift(event.id, position.id, {
      startsAt: new Date(start.getTime() + 2 * 3_600_000),
      endsAt: new Date(start.getTime() + 8 * 3_600_000),
      capacity: 3,
    });

    const [proposal] = await buildAssignmentProposals(event.id, [clashing.id]);
    expect(proposal.picked.map((c) => c.userId)).not.toContain(staff.id);
  });

  it("navrhne voľného človeka a nepresiahne potrebný počet", async () => {
    const { event, position } = await makeWorld();
    for (let i = 0; i < 3; i += 1) {
      const person = await makeUser();
      await makeMember(person.id, event.id);
    }
    const shift = await makeShift(event.id, position.id, { capacity: 2 });

    const [proposal] = await buildAssignmentProposals(event.id, [shift.id]);
    expect(proposal.needed).toBe(2);
    expect(proposal.picked.length).toBeLessThanOrEqual(2);
    expect(proposal.picked.every((c) => c.blockers.length === 0)).toBe(true);
  });

  it("návrh nič nezapisuje do databázy", async () => {
    const db = await getDb();
    const { event, position } = await makeWorld();
    const person = await makeUser();
    await makeMember(person.id, event.id);
    const shift = await makeShift(event.id, position.id, { capacity: 2 });

    await buildAssignmentProposals(event.id, [shift.id]);

    const rows = await db
      .select()
      .from(shiftAssignments)
      .where(eq(shiftAssignments.shiftId, shift.id));
    expect(rows).toHaveLength(0);
  });

  it("už obsadenú smenu nedopĺňa", async () => {
    const { event, position } = await makeWorld();
    const shift = await makeShift(event.id, position.id, { capacity: 1 });
    const person = await makeUser();
    await makeMember(person.id, event.id);
    await makeAssignment(shift.id, person.id, event.id);

    const [proposal] = await buildAssignmentProposals(event.id, [shift.id]);
    expect(proposal.needed).toBe(0);
    expect(proposal.picked).toHaveLength(0);
  });
});

describe("zoznam pridelení", () => {
  it("vráti pridelených ľudí aj s dochádzkou", async () => {
    const { event, staff, position } = await makeWorld();
    const shift = await makeShift(event.id, position.id);
    await makeAssignment(shift.id, staff.id, event.id);

    const rows = await listShiftAssignments(shift.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(staff.id);
    expect(rows[0].attendanceStatus).toBeNull();
  });
});
