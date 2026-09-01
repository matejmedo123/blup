"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getDb } from "@/db/client";
import { attendance, attendanceCorrections, positions, shifts } from "@/db/schema";
import { failure, success, toActionResult, type ActionResult } from "@/lib/action-result";
import { assertPermission, assertSameOrigin, clientIp } from "@/lib/auth/guards";
import { writeAudit } from "@/lib/audit";
import { getEventById } from "@/lib/domain/events";
import { fromEventLocal } from "@/lib/format";
import { channels, realtime } from "@/lib/realtime";
import { fieldErrors, uuidSchema } from "@/lib/validation/common";

const correctionSchema = z
  .object({
    attendanceId: uuidSchema,
    checkInAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
      .optional()
      .or(z.literal("")),
    checkOutAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
      .optional()
      .or(z.literal("")),
    breakMinutes: z.coerce.number().int().min(0).max(600).optional(),
    bonus: z.coerce.number().min(-1000).max(1000).optional(),
    adjustments: z.coerce.number().min(-1000).max(1000).optional(),
    adjustmentNote: z.string().trim().max(300).optional(),
    // Rule 3: bez dôvodu sa dochádzka meniť nedá.
    reason: z.string().trim().min(3, "Uveď dôvod opravy — ukladá sa do audit logu.").max(400),
  })
  .refine(
    (v) => !v.checkOutAt || !v.checkInAt || v.checkOutAt >= v.checkInAt,
    { message: "Check-out nemôže byť skôr ako check-in.", path: ["checkOutAt"] },
  );

/**
 * Oprava dochádzky. Zápis, `attendance_corrections` a audit log
 * prebehnú v jednej transakcii — bez auditu sa dochádzka nezmení (Rule 3).
 */
export async function correctAttendance(payload: unknown): Promise<ActionResult> {
  try {
    await assertSameOrigin();
    const session = await assertPermission("can_edit_attendance");
    if (!session.eventId) return failure("Nie je zvolený žiadny event.");
    const eventId = session.eventId;

    const parsed = correctionSchema.safeParse(payload);
    if (!parsed.success) return failure("Opravu sa nepodarilo uložiť.", fieldErrors(parsed.error));
    const input = parsed.data;

    const event = await getEventById(eventId);
    if (!event) return failure("Event sa nenašiel.");
    const tz = event.timezone;

    const db = await getDb();
    const [before] = await db
      .select()
      .from(attendance)
      .where(and(eq(attendance.id, input.attendanceId), eq(attendance.eventId, eventId)))
      .limit(1);
    if (!before) return failure("Dochádzkový záznam sa nenašiel.");

    const checkInAt = input.checkInAt ? fromEventLocal(input.checkInAt, tz) : before.checkInAt;
    const checkOutAt = input.checkOutAt ? fromEventLocal(input.checkOutAt, tz) : before.checkOutAt;

    if (checkOutAt && !checkInAt) {
      return failure("Nedá sa zapísať check-out bez check-inu.", {
        checkInAt: ["Najprv doplň čas check-inu."],
      });
    }
    if (checkInAt && checkOutAt && checkOutAt < checkInAt) {
      return failure("Check-out nemôže byť skôr ako check-in.", {
        checkOutAt: ["Koniec musí byť po začiatku."],
      });
    }

    const breakMinutes = input.breakMinutes ?? before.breakMinutes;
    const workedMinutes =
      checkInAt && checkOutAt
        ? Math.max(0, Math.round((checkOutAt.getTime() - checkInAt.getTime()) / 60_000) - breakMinutes)
        : before.workedMinutes;

    const nextStatus = checkOutAt ? "manually_corrected" : checkInAt ? "checked_in" : "not_started";

    const changes: { field: string; before: string | null; after: string | null }[] = [];
    const track = (field: string, prev: unknown, next: unknown) => {
      const a = prev instanceof Date ? prev.toISOString() : prev == null ? null : String(prev);
      const b = next instanceof Date ? next.toISOString() : next == null ? null : String(next);
      if (a !== b) changes.push({ field, before: a, after: b });
    };

    track("check_in_at", before.checkInAt, checkInAt);
    track("check_out_at", before.checkOutAt, checkOutAt);
    track("break_minutes", before.breakMinutes, breakMinutes);
    track("worked_minutes", before.workedMinutes, workedMinutes);
    if (input.bonus != null) track("bonus", before.bonus, input.bonus.toFixed(2));
    if (input.adjustments != null) track("adjustments", before.adjustments, input.adjustments.toFixed(2));

    if (changes.length === 0) return success("Nič sa nezmenilo.");

    await db.transaction(async (tx) => {
      await tx
        .update(attendance)
        .set({
          checkInAt,
          checkOutAt,
          breakMinutes,
          workedMinutes,
          status: nextStatus,
          bonus: input.bonus != null ? input.bonus.toFixed(2) : before.bonus,
          adjustments: input.adjustments != null ? input.adjustments.toFixed(2) : before.adjustments,
          adjustmentNote: input.adjustmentNote ?? before.adjustmentNote,
          // Oprava zhadzuje schválenie — payroll musí prejsť novou kontrolou (Rule 6).
          approved: false,
          approvedBy: null,
          approvedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(attendance.id, input.attendanceId));

      await tx.insert(attendanceCorrections).values(
        changes.map((change) => ({
          attendanceId: input.attendanceId,
          actorId: session.user.id,
          field: change.field,
          beforeValue: change.before,
          afterValue: change.after,
          reason: input.reason,
        })),
      );

      await writeAudit(
        {
          eventId,
          actorId: session.user.id,
          action: "attendance.corrected",
          entity: "attendance",
          entityId: input.attendanceId,
          before: Object.fromEntries(changes.map((c) => [c.field, c.before])),
          after: Object.fromEntries(changes.map((c) => [c.field, c.after])),
          ip: await clientIp(),
        },
        tx,
      );
    });

    realtime.publish([channels.event(eventId)], {
      type: "attendance",
      eventId,
      userId: before.userId,
      status: nextStatus,
    });

    revalidatePath("/admin/attendance");
    revalidatePath("/admin/attendance/corrections");
    revalidatePath(`/admin/staff/${before.userId}`);
    return success(`Dochádzka je opravená. Zaznamenali sme ${changes.length} zmien.`);
  } catch (error) {
    return toActionResult(error, "Opravu sa nepodarilo uložiť.");
  }
}

const approveSchema = z.object({
  attendanceIds: z.array(uuidSchema).min(1, "Vyber aspoň jeden záznam."),
  approved: z.boolean(),
});

/** Schválenie dochádzky — payroll berie iba schválené záznamy (Rule 6). */
export async function approveAttendance(payload: unknown): Promise<ActionResult> {
  try {
    await assertSameOrigin();
    const session = await assertPermission("can_edit_attendance");
    if (!session.eventId) return failure("Nie je zvolený žiadny event.");
    const eventId = session.eventId;

    const parsed = approveSchema.safeParse(payload);
    if (!parsed.success) return failure("Neplatný výber.", fieldErrors(parsed.error));

    const db = await getDb();
    const ip = await clientIp();
    let changed = 0;

    for (const id of parsed.data.attendanceIds) {
      const [row] = await db
        .select({ id: attendance.id, approved: attendance.approved, checkOutAt: attendance.checkOutAt })
        .from(attendance)
        .where(and(eq(attendance.id, id), eq(attendance.eventId, eventId)))
        .limit(1);
      if (!row) continue;
      if (parsed.data.approved && !row.checkOutAt) continue; // neukončenú smenu neschvaľujeme
      if (row.approved === parsed.data.approved) continue;

      await db
        .update(attendance)
        .set({
          approved: parsed.data.approved,
          approvedBy: parsed.data.approved ? session.user.id : null,
          approvedAt: parsed.data.approved ? new Date() : null,
          updatedAt: new Date(),
        })
        .where(eq(attendance.id, id));

      await writeAudit({
        eventId,
        actorId: session.user.id,
        action: "attendance.approved",
        entity: "attendance",
        entityId: id,
        before: { approved: row.approved },
        after: { approved: parsed.data.approved },
        ip,
      });
      changed += 1;
    }

    revalidatePath("/admin/attendance");
    revalidatePath("/admin/payroll");

    if (changed === 0) {
      return failure(
        parsed.data.approved
          ? "Nič sa neschválilo — neukončené smeny sa schváliť nedajú."
          : "Nič sa nezmenilo.",
      );
    }
    return success(
      parsed.data.approved
        ? `Schválili sme ${changed} ${changed === 1 ? "záznam" : changed < 5 ? "záznamy" : "záznamov"}.`
        : `Zrušili sme schválenie pri ${changed} záznamoch.`,
    );
  } catch (error) {
    return toActionResult(error, "Schválenie sa nepodarilo uložiť.");
  }
}

const manualSchema = z.object({
  shiftId: uuidSchema,
  userId: uuidSchema,
  action: z.enum(["check_in", "check_out"]),
});

/** Check-in/out za pracovníka priamo z admin tabuľky (§10, §11). */
export async function coordinatorCheckAction(payload: unknown): Promise<ActionResult> {
  try {
    await assertSameOrigin();
    const parsed = manualSchema.safeParse(payload);
    if (!parsed.success) return failure("Neplatná akcia.", fieldErrors(parsed.error));

    const session = await assertPermission(
      parsed.data.action === "check_in" ? "can_check_in_others" : "can_check_out_others",
    );
    if (!session.eventId) return failure("Nie je zvolený žiadny event.");

    const { performCheckIn, performCheckOut } = await import("@/lib/domain/check-in");
    const source = session.actor.eventRole === "coordinator" ? "coordinator" : "admin";
    const ip = await clientIp();

    if (parsed.data.action === "check_in") {
      const result = await performCheckIn({
        shiftId: parsed.data.shiftId,
        targetUserId: parsed.data.userId,
        actorId: session.user.id,
        eventId: session.eventId,
        source,
        ip,
      });
      revalidatePath("/admin/attendance");
      return success(result.late ? "Check-in zapísaný (s meškaním)." : "Check-in zapísaný.");
    }

    await performCheckOut({
      shiftId: parsed.data.shiftId,
      targetUserId: parsed.data.userId,
      actorId: session.user.id,
      eventId: session.eventId,
      source,
      ip,
    });
    revalidatePath("/admin/attendance");
    return success("Check-out zapísaný.");
  } catch (error) {
    return toActionResult(error, "Akciu sa nepodarilo vykonať.");
  }
}

/** Detail pre editačný dialóg korekcie. */
export async function loadAttendanceForCorrection(attendanceId: string) {
  const session = await assertPermission("can_edit_attendance");
  if (!session.eventId) return null;

  const db = await getDb();
  const [row] = await db
    .select({
      id: attendance.id,
      checkInAt: attendance.checkInAt,
      checkOutAt: attendance.checkOutAt,
      breakMinutes: attendance.breakMinutes,
      bonus: attendance.bonus,
      adjustments: attendance.adjustments,
      adjustmentNote: attendance.adjustmentNote,
      startsAt: shifts.startsAt,
      endsAt: shifts.endsAt,
      positionName: positions.name,
    })
    .from(attendance)
    .innerJoin(shifts, eq(shifts.id, attendance.shiftId))
    .innerJoin(positions, eq(positions.id, shifts.positionId))
    .where(and(eq(attendance.id, attendanceId), eq(attendance.eventId, session.eventId)))
    .limit(1);

  return row ?? null;
}
