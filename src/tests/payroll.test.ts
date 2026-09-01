import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { getDb } from "@/db/client";
import { attendance } from "@/db/schema";
import { DEFAULT_EVENT_SETTINGS, eventSettings } from "@/lib/domain/events";
import {
  calculateEarnings,
  minutesToHours,
  payrollCsv,
  payrollLines,
  roundMinutes,
  round2,
  summarisePayroll,
} from "@/lib/domain/payroll";
import { makeAssignment, makeEvent, makeShift, makeUser, makeMember, makePosition } from "./factories";

const settings = DEFAULT_EVENT_SETTINGS;

describe("zaokrúhľovanie času", () => {
  it("presné zaokrúhľovanie nechá minúty tak", () => {
    expect(roundMinutes(97, "exact")).toBe(97);
  });

  it("zaokrúhli na 5 minút", () => {
    expect(roundMinutes(97, "5min")).toBe(95);
    expect(roundMinutes(98, "5min")).toBe(100);
  });

  it("zaokrúhli na 15 minút", () => {
    expect(roundMinutes(97, "15min")).toBe(90);
    expect(roundMinutes(103, "15min")).toBe(105);
  });

  it("záporný čas je nula", () => {
    expect(roundMinutes(-10, "exact")).toBe(0);
  });

  it("prevod minút na hodiny má dve desatinné miesta", () => {
    expect(minutesToHours(90)).toBe(1.5);
    expect(minutesToHours(97)).toBe(1.62);
  });
});

describe("výpočet zárobku", () => {
  it("hodiny × sadzba", () => {
    const result = calculateEarnings({ workedMinutes: 360, hourlyRate: 8.5 }, settings);
    expect(result.hours).toBe(6);
    expect(result.gross).toBe(51);
    expect(result.total).toBe(51);
  });

  it("prestávka sa odráta", () => {
    const result = calculateEarnings(
      { workedMinutes: 360, breakMinutes: 30, hourlyRate: 8.5 },
      settings,
    );
    expect(result.hours).toBe(5.5);
    expect(result.gross).toBe(46.75);
  });

  it("bonus a korekcia sa pripočítajú k základu", () => {
    const result = calculateEarnings(
      { workedMinutes: 360, hourlyRate: 8.5, bonus: 10, adjustments: -5 },
      settings,
    );
    expect(result.gross).toBe(51);
    expect(result.total).toBe(56);
  });

  it("nadčas nad limit sa násobí", () => {
    const result = calculateEarnings(
      { workedMinutes: 12 * 60, hourlyRate: 10 },
      { ...settings, overtime_after_hours: 10, overtime_multiplier: 1.5 },
    );
    // 10 h bežných + 2 h nadčasu × 1,5
    expect(result.regularHours).toBe(10);
    expect(result.overtimeHours).toBe(2);
    expect(result.gross).toBe(130);
  });

  it("zaokrúhľovanie eventu ovplyvní výsledok", () => {
    const exact = calculateEarnings({ workedMinutes: 97, hourlyRate: 10 }, settings);
    const rounded = calculateEarnings(
      { workedMinutes: 97, hourlyRate: 10 },
      { ...settings, rounding: "15min" },
    );
    expect(exact.hours).toBe(1.62);
    expect(rounded.hours).toBe(1.5);
  });

  it("nulový čas dáva nulový zárobok", () => {
    const result = calculateEarnings({ workedMinutes: 0, hourlyRate: 8.5 }, settings);
    expect(result.total).toBe(0);
  });

  it("centy sa nestrácajú v zaokrúhľovaní", () => {
    const result = calculateEarnings({ workedMinutes: 465, hourlyRate: 8.5 }, settings);
    // 7,75 h × 8,50 = 65,875 → 65,88
    expect(result.hours).toBe(7.75);
    expect(result.gross).toBe(65.88);
  });
});

describe("mzdové riadky", () => {
  async function seedWorked(approved: boolean, minutes = 360, rate = "8.50") {
    const event = await makeEvent();
    const staff = await makeUser();
    await makeMember(staff.id, event.id);
    const position = await makePosition(event.id, { hourlyRate: rate });
    const startsAt = new Date(Date.now() - 8 * 3_600_000);
    const shift = await makeShift(event.id, position.id, {
      startsAt,
      endsAt: new Date(startsAt.getTime() + 6 * 3_600_000),
    });
    const assignment = await makeAssignment(shift.id, staff.id, event.id, { status: "completed" });

    const db = await getDb();
    await db.insert(attendance).values({
      assignmentId: assignment.id,
      shiftId: shift.id,
      userId: staff.id,
      eventId: event.id,
      status: "checked_out",
      checkInAt: startsAt,
      checkOutAt: new Date(startsAt.getTime() + minutes * 60_000),
      workedMinutes: minutes,
      approved,
    });

    return { event, staff, shift, position };
  }

  it("predvolene berie iba schválenú dochádzku (Rule 6)", async () => {
    const { event } = await seedWorked(false);
    expect(await payrollLines(event.id)).toHaveLength(0);
    expect(await payrollLines(event.id, { onlyApproved: false })).toHaveLength(1);
  });

  it("schválená dochádzka sa premietne do riadku", async () => {
    const { event, staff } = await seedWorked(true, 360, "8.50");
    const lines = await payrollLines(event.id);
    expect(lines).toHaveLength(1);
    expect(lines[0].userId).toBe(staff.id);
    expect(lines[0].hourlyRate).toBe(8.5);
    expect(lines[0].earnings.total).toBe(51);
  });

  it("sadzba smeny prebíja sadzbu pozície", async () => {
    const event = await makeEvent();
    const staff = await makeUser();
    await makeMember(staff.id, event.id);
    const position = await makePosition(event.id, { hourlyRate: "8.00" });
    const startsAt = new Date(Date.now() - 8 * 3_600_000);
    const shift = await makeShift(event.id, position.id, {
      startsAt,
      endsAt: new Date(startsAt.getTime() + 6 * 3_600_000),
      hourlyRate: "12.00",
    });
    const assignment = await makeAssignment(shift.id, staff.id, event.id, { status: "completed" });

    const db = await getDb();
    await db.insert(attendance).values({
      assignmentId: assignment.id,
      shiftId: shift.id,
      userId: staff.id,
      eventId: event.id,
      status: "checked_out",
      checkInAt: startsAt,
      checkOutAt: new Date(startsAt.getTime() + 6 * 3_600_000),
      workedMinutes: 360,
      approved: true,
    });

    const lines = await payrollLines(event.id);
    expect(lines[0].hourlyRate).toBe(12);
    expect(lines[0].earnings.total).toBe(72);
  });

  it("oprava odpracovaných minút zmení sumu", async () => {
    const { event } = await seedWorked(true, 360, "10.00");
    const db = await getDb();
    const [row] = await db.select().from(attendance).where(eq(attendance.eventId, event.id));
    await db.update(attendance).set({ workedMinutes: 180 }).where(eq(attendance.id, row.id));

    const lines = await payrollLines(event.id);
    expect(lines[0].earnings.hours).toBe(3);
    expect(lines[0].earnings.total).toBe(30);
  });

  it("súhrn zoskupí riadky na jedného človeka", () => {
    const base = {
      userId: "u1",
      firstName: "Martin",
      lastName: "Novák",
      email: "m@test.local",
      positionId: null,
      positionName: "Bar",
      approved: true,
      hourlyRate: 10,
    };
    const summaries = summarisePayroll([
      { ...base, attendanceId: "a1", workDate: new Date(), earnings: calculateEarnings({ workedMinutes: 360, hourlyRate: 10 }, settings) },
      { ...base, attendanceId: "a2", workDate: new Date(), earnings: calculateEarnings({ workedMinutes: 180, hourlyRate: 10 }, settings) },
    ]);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].hours).toBe(9);
    expect(summaries[0].total).toBe(90);
    expect(summaries[0].lineCount).toBe(2);
  });

  it("súhrn označí človeka s neschválenou dochádzkou", () => {
    const base = {
      userId: "u1",
      firstName: "Martin",
      lastName: "Novák",
      email: "m@test.local",
      positionId: null,
      positionName: "Bar",
      hourlyRate: 10,
      workDate: new Date(),
      earnings: calculateEarnings({ workedMinutes: 60, hourlyRate: 10 }, settings),
    };
    const summaries = summarisePayroll([
      { ...base, attendanceId: "a1", approved: true },
      { ...base, attendanceId: "a2", approved: false },
    ]);
    expect(summaries[0].allApproved).toBe(false);
  });
});

describe("CSV export", () => {
  const line = {
    attendanceId: "a1",
    userId: "u1",
    firstName: "Martin",
    lastName: "Novák",
    email: "martin@test.local",
    positionId: null,
    positionName: "Bar",
    workDate: new Date("2026-09-12T18:00:00Z"),
    hourlyRate: 8.5,
    approved: true,
    earnings: calculateEarnings({ workedMinutes: 360, hourlyRate: 8.5 }, settings),
  };

  it("obsahuje hlavičku aj dáta oddelené bodkočiarkou", () => {
    const csv = payrollCsv([line], { eventName: "Grape", currency: "EUR" });
    const [header, row] = csv.split("\r\n");
    expect(header.split(";")).toContain("gross_amount");
    expect(row).toContain("Martin Novák");
    expect(row).toContain("51.00");
    expect(row).toContain("2026-09-12");
  });

  it("obalí bunky s bodkočiarkou do úvodzoviek", () => {
    const csv = payrollCsv(
      [{ ...line, positionName: "Bar; hlavná scéna" }],
      { eventName: "Grape", currency: "EUR" },
    );
    expect(csv).toContain('"Bar; hlavná scéna"');
  });

  it("zneškodní pokus o CSV injection", () => {
    const csv = payrollCsv(
      [{ ...line, firstName: "=cmd|", lastName: "calc" }],
      { eventName: "Grape", currency: "EUR" },
    );
    expect(csv).toContain("'=cmd|");
  });
});

describe("nastavenia eventu", () => {
  it("doplní chýbajúce hodnoty predvolenými", () => {
    const merged = eventSettings({ settings: { currency: "CZK" } });
    expect(merged.currency).toBe("CZK");
    expect(merged.rounding).toBe(DEFAULT_EVENT_SETTINGS.rounding);
  });
});

describe("zaokrúhlenie na centy", () => {
  it("nezanáša plávajúcu chybu", () => {
    expect(round2(0.1 + 0.2)).toBe(0.3);
    expect(round2(65.875)).toBe(65.88);
  });
});
