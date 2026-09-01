import "server-only";

import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { getDb } from "@/db/client";
import {
  attendance,
  events,
  payrollRecords,
  positions,
  shifts,
  users,
} from "@/db/schema";
import { eventSettings } from "./events";
import type { EventSettings } from "@/db/schema";

export type Rounding = NonNullable<EventSettings["rounding"]>;

/** Zaokrúhlenie odpracovaných minút podľa nastavenia eventu (§14). */
export function roundMinutes(minutes: number, rounding: Rounding): number {
  if (minutes <= 0) return 0;
  switch (rounding) {
    case "5min":
      return Math.round(minutes / 5) * 5;
    case "15min":
      return Math.round(minutes / 15) * 15;
    default:
      return Math.round(minutes);
  }
}

export function minutesToHours(minutes: number): number {
  return Math.round((minutes / 60) * 100) / 100;
}

export type EarningsInput = {
  workedMinutes: number;
  hourlyRate: number;
  bonus?: number;
  adjustments?: number;
  breakMinutes?: number;
};

export type Earnings = {
  minutes: number;
  hours: number;
  regularHours: number;
  overtimeHours: number;
  gross: number;
  bonus: number;
  adjustments: number;
  total: number;
};

/**
 * Jediné miesto, kde sa počíta zárobok. Používa ho portál (odhad)
 * aj payroll (schválená suma) — čísla sa tak nikdy nerozídu kvôli inému vzorcu.
 */
export function calculateEarnings(
  input: EarningsInput,
  settings: Required<EventSettings>,
): Earnings {
  const net = Math.max(0, input.workedMinutes - (input.breakMinutes ?? 0));
  const minutes = roundMinutes(net, settings.rounding);
  const hours = minutesToHours(minutes);

  const overtimeThreshold = settings.overtime_after_hours;
  const regularHours = Math.min(hours, overtimeThreshold);
  const overtimeHours = Math.max(0, hours - overtimeThreshold);

  const gross =
    round2(regularHours * input.hourlyRate) +
    round2(overtimeHours * input.hourlyRate * settings.overtime_multiplier);

  const bonus = round2(input.bonus ?? 0);
  const adjustments = round2(input.adjustments ?? 0);

  return {
    minutes,
    hours,
    regularHours,
    overtimeHours,
    gross: round2(gross),
    bonus,
    adjustments,
    total: round2(gross + bonus + adjustments),
  };
}

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export type PayrollLine = {
  attendanceId: string;
  userId: string;
  firstName: string;
  lastName: string;
  email: string;
  positionId: string | null;
  positionName: string;
  workDate: Date;
  hourlyRate: number;
  approved: boolean;
  earnings: Earnings;
};

/** Mzdové riadky z dochádzky. `onlyApproved` je predvolené — Rule 6. */
export async function payrollLines(
  eventId: string,
  options: { onlyApproved?: boolean; userId?: string } = {},
): Promise<PayrollLine[]> {
  const db = await getDb();
  const [event] = await db.select().from(events).where(eq(events.id, eventId)).limit(1);
  if (!event) return [];
  const settings = eventSettings(event);

  const conditions = [eq(attendance.eventId, eventId)];
  if (options.onlyApproved !== false) conditions.push(eq(attendance.approved, true));
  if (options.userId) conditions.push(eq(attendance.userId, options.userId));

  const rows = await db
    .select({
      attendanceId: attendance.id,
      userId: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
      email: users.email,
      positionId: positions.id,
      positionName: positions.name,
      startsAt: shifts.startsAt,
      workedMinutes: attendance.workedMinutes,
      breakMinutes: attendance.breakMinutes,
      approved: attendance.approved,
      bonus: attendance.bonus,
      adjustments: attendance.adjustments,
      shiftRate: shifts.hourlyRate,
      positionRate: positions.hourlyRate,
    })
    .from(attendance)
    .innerJoin(shifts, eq(shifts.id, attendance.shiftId))
    .innerJoin(positions, eq(positions.id, shifts.positionId))
    .innerJoin(users, eq(users.id, attendance.userId))
    .where(and(...conditions))
    .orderBy(asc(users.lastName), asc(shifts.startsAt));

  return rows.map((row) => {
    const hourlyRate = Number(row.shiftRate ?? row.positionRate) || 0;
    return {
      attendanceId: row.attendanceId,
      userId: row.userId,
      firstName: row.firstName,
      lastName: row.lastName,
      email: row.email,
      positionId: row.positionId,
      positionName: row.positionName,
      workDate: row.startsAt,
      hourlyRate,
      approved: row.approved,
      earnings: calculateEarnings(
        {
          workedMinutes: row.workedMinutes ?? 0,
          breakMinutes: row.breakMinutes ?? 0,
          hourlyRate,
          bonus: Number(row.bonus ?? 0),
          adjustments: Number(row.adjustments ?? 0),
        },
        settings,
      ),
    };
  });
}

export type PayrollSummary = {
  userId: string;
  firstName: string;
  lastName: string;
  email: string;
  positionName: string;
  hours: number;
  hourlyRate: number;
  gross: number;
  bonus: number;
  adjustments: number;
  total: number;
  lineCount: number;
  allApproved: boolean;
};

/** Zoskupí riadky na jedného človeka — to je pohľad, ktorý admin schvaľuje. */
export function summarisePayroll(lines: PayrollLine[]): PayrollSummary[] {
  const map = new Map<string, PayrollSummary>();

  for (const line of lines) {
    const current = map.get(line.userId) ?? {
      userId: line.userId,
      firstName: line.firstName,
      lastName: line.lastName,
      email: line.email,
      positionName: line.positionName,
      hours: 0,
      hourlyRate: line.hourlyRate,
      gross: 0,
      bonus: 0,
      adjustments: 0,
      total: 0,
      lineCount: 0,
      allApproved: true,
    };

    current.hours = round2(current.hours + line.earnings.hours);
    current.gross = round2(current.gross + line.earnings.gross);
    current.bonus = round2(current.bonus + line.earnings.bonus);
    current.adjustments = round2(current.adjustments + line.earnings.adjustments);
    current.total = round2(current.total + line.earnings.total);
    current.lineCount += 1;
    current.allApproved = current.allApproved && line.approved;
    map.set(line.userId, current);
  }

  return [...map.values()].sort((a, b) => a.lastName.localeCompare(b.lastName, "sk"));
}

/** Odhad mzdových nákladov na dashboard — počíta aj neschválenú dochádzku. */
export async function estimatedPayrollCost(eventId: string): Promise<number> {
  const lines = await payrollLines(eventId, { onlyApproved: false });
  return round2(lines.reduce((sum, line) => sum + line.earnings.total, 0));
}

/** Vytvorí/aktualizuje `payroll_records` zo schválenej dochádzky. */
export async function generatePayrollRecords(
  eventId: string,
  actorId: string,
): Promise<{ created: number; updated: number }> {
  const db = await getDb();
  const lines = await payrollLines(eventId, { onlyApproved: true });
  if (lines.length === 0) return { created: 0, updated: 0 };

  const existing = await db
    .select({ id: payrollRecords.id, attendanceId: payrollRecords.attendanceId })
    .from(payrollRecords)
    .where(
      and(
        eq(payrollRecords.eventId, eventId),
        inArray(
          payrollRecords.attendanceId,
          lines.map((line) => line.attendanceId),
        ),
      ),
    );
  const existingByAttendance = new Map(existing.map((row) => [row.attendanceId, row.id]));

  let created = 0;
  let updated = 0;

  for (const line of lines) {
    const values = {
      eventId,
      userId: line.userId,
      attendanceId: line.attendanceId,
      positionId: line.positionId,
      workDate: line.workDate.toISOString().slice(0, 10),
      hours: String(line.earnings.hours),
      hourlyRate: String(line.hourlyRate),
      gross: String(line.earnings.gross),
      bonus: String(line.earnings.bonus),
      adjustments: String(line.earnings.adjustments),
      total: String(line.earnings.total),
      status: "approved" as const,
      approvedBy: actorId,
      approvedAt: new Date(),
      updatedAt: new Date(),
    };

    const existingId = existingByAttendance.get(line.attendanceId);
    if (existingId) {
      await db.update(payrollRecords).set(values).where(eq(payrollRecords.id, existingId));
      updated += 1;
    } else {
      await db.insert(payrollRecords).values(values);
      created += 1;
    }
  }

  return { created, updated };
}

/** CSV podľa §26. Oddeľovač je bodkočiarka — slovenský Excel to očakáva. */
export function payrollCsv(
  lines: PayrollLine[],
  meta: { eventName: string; currency: string },
): string {
  const header = [
    "employee_id",
    "name",
    "email",
    "event",
    "position",
    "date",
    "hours",
    "hourly_rate",
    "gross_amount",
    "bonus",
    "adjustments",
    "total",
    "currency",
    "approved",
  ];

  const rows = lines.map((line) => [
    line.userId,
    `${line.firstName} ${line.lastName}`,
    line.email,
    meta.eventName,
    line.positionName,
    line.workDate.toISOString().slice(0, 10),
    line.earnings.hours.toFixed(2),
    line.hourlyRate.toFixed(2),
    line.earnings.gross.toFixed(2),
    line.earnings.bonus.toFixed(2),
    line.earnings.adjustments.toFixed(2),
    line.earnings.total.toFixed(2),
    meta.currency,
    line.approved ? "yes" : "no",
  ]);

  return [header, ...rows].map((row) => row.map(csvCell).join(";")).join("\r\n");
}

/** Zabráni CSV injection — bunka začínajúca =, +, -, @ sa prefixuje apostrofom. */
function csvCell(value: string): string {
  const text = String(value ?? "");
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[";\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

export async function payrollTotals(eventId: string) {
  const db = await getDb();
  const [row] = await db
    .select({
      approved: sql<string>`coalesce(sum(case when ${payrollRecords.status} in ('approved','exported','paid') then ${payrollRecords.total} else 0 end), 0)`,
      pending: sql<string>`coalesce(sum(case when ${payrollRecords.status} = 'draft' then ${payrollRecords.total} else 0 end), 0)`,
      people: sql<number>`count(distinct ${payrollRecords.userId})::int`,
      hours: sql<string>`coalesce(sum(${payrollRecords.hours}), 0)`,
    })
    .from(payrollRecords)
    .where(eq(payrollRecords.eventId, eventId));

  return {
    approved: Number(row?.approved ?? 0),
    pending: Number(row?.pending ?? 0),
    people: Number(row?.people ?? 0),
    hours: Number(row?.hours ?? 0),
  };
}
