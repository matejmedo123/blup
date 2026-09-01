"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { failure, success, toActionResult, type ActionResult } from "@/lib/action-result";
import { assertPermission, assertSameOrigin, clientIp } from "@/lib/auth/guards";
import { writeAudit } from "@/lib/audit";
import { generatePayrollRecords } from "@/lib/domain/payroll";
import { fieldErrors, uuidSchema } from "@/lib/validation/common";

/** Vygeneruje mzdové podklady zo schválenej dochádzky (Rule 6). */
export async function generatePayroll(): Promise<ActionResult> {
  try {
    await assertSameOrigin();
    const session = await assertPermission("can_view_payroll");
    if (!session.eventId) return failure("Nie je zvolený žiadny event.");

    const result = await generatePayrollRecords(session.eventId, session.user.id);

    await writeAudit({
      eventId: session.eventId,
      actorId: session.user.id,
      action: "payroll.generated",
      entity: "event",
      entityId: session.eventId,
      after: result,
      ip: await clientIp(),
    });

    revalidatePath("/admin/payroll");

    if (result.created + result.updated === 0) {
      return failure(
        "Nie je z čoho generovať — najprv schváľ dochádzku v sekcii Dochádzka.",
      );
    }
    return success(
      `Hotovo: ${result.created} nových a ${result.updated} aktualizovaných riadkov.`,
    );
  } catch (error) {
    return toActionResult(error, "Mzdové podklady sa nepodarilo vygenerovať.");
  }
}

const adjustSchema = z.object({
  attendanceId: uuidSchema,
  bonus: z.coerce.number().min(-1000).max(1000),
  adjustments: z.coerce.number().min(-1000).max(1000),
  note: z.string().trim().max(300).optional(),
  reason: z.string().trim().min(3, "Uveď dôvod — ukladá sa do audit logu.").max(400),
});

/** Bonus a korekcia sumy idú cez rovnakú cestu ako oprava dochádzky. */
export async function adjustPayrollLine(payload: unknown): Promise<ActionResult> {
  try {
    await assertSameOrigin();
    const session = await assertPermission("can_view_payroll");
    if (!session.eventId) return failure("Nie je zvolený žiadny event.");

    const parsed = adjustSchema.safeParse(payload);
    if (!parsed.success) return failure("Skontroluj údaje.", fieldErrors(parsed.error));

    const { correctAttendance } = await import("./admin-attendance");
    const result = await correctAttendance({
      attendanceId: parsed.data.attendanceId,
      bonus: parsed.data.bonus,
      adjustments: parsed.data.adjustments,
      adjustmentNote: parsed.data.note,
      reason: parsed.data.reason,
    });

    revalidatePath("/admin/payroll");
    return result;
  } catch (error) {
    return toActionResult(error, "Korekciu sa nepodarilo uložiť.");
  }
}
