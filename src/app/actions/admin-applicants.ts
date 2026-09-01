"use server";

import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getDb } from "@/db/client";
import { APPLICATION_STATUSES } from "@/db/enums";
import { applications, staffNotes, users, vendorApplications, volunteerApplications } from "@/db/schema";
import { failure, success, toActionResult, type ActionResult } from "@/lib/action-result";
import { assertFullAdmin, assertSameOrigin, clientIp } from "@/lib/auth/guards";
import { writeAudit } from "@/lib/audit";
import {
  approveApplication,
  notifyApplicationDecision,
  rejectApplication,
} from "@/lib/domain/applications";
import { getEventById } from "@/lib/domain/events";
import { fieldErrors, uuidSchema } from "@/lib/validation/common";

const decisionSchema = z.object({
  applicationIds: z.array(uuidSchema).min(1, "Vyber aspoň jednu prihlášku."),
  reason: z.string().trim().max(500).optional(),
});

export async function approveApplications(payload: unknown): Promise<ActionResult<{ count: number }>> {
  try {
    await assertSameOrigin();
    const session = await assertFullAdmin();
    if (!session.eventId) return failure("Nie je zvolený žiadny event.");

    const parsed = decisionSchema.safeParse(payload);
    if (!parsed.success) return failure("Neplatný výber.", fieldErrors(parsed.error));

    const event = await getEventById(session.eventId);
    if (!event) return failure("Event sa nenašiel.");

    const ip = await clientIp();
    const approved: { userId: string; email: string; firstName: string }[] = [];

    for (const applicationId of parsed.data.applicationIds) {
      const result = await approveApplication({
        applicationId,
        eventId: session.eventId,
        actorId: session.user.id,
        ip,
      });
      if (result) approved.push(result);
    }

    for (const person of approved) {
      await notifyApplicationDecision({
        ...person,
        eventId: session.eventId,
        eventName: event.name,
        approved: true,
      });
    }

    revalidatePath("/admin/applicants");
    revalidatePath("/admin/staff");
    revalidatePath("/admin");

    if (approved.length === 0) return success("Nič sa nezmenilo — prihlášky už boli schválené.");
    return success(
      approved.length === 1
        ? "Prihláška je schválená a účet aktivovaný."
        : `Schválili sme ${approved.length} prihlášok.`,
      { count: approved.length },
    );
  } catch (error) {
    return toActionResult(error, "Prihlášku sa nepodarilo schváliť.");
  }
}

export async function rejectApplications(payload: unknown): Promise<ActionResult<{ count: number }>> {
  try {
    await assertSameOrigin();
    const session = await assertFullAdmin();
    if (!session.eventId) return failure("Nie je zvolený žiadny event.");

    const parsed = decisionSchema.safeParse(payload);
    if (!parsed.success) return failure("Neplatný výber.", fieldErrors(parsed.error));

    const event = await getEventById(session.eventId);
    if (!event) return failure("Event sa nenašiel.");

    const ip = await clientIp();
    const rejected: { userId: string; email: string; firstName: string }[] = [];

    for (const applicationId of parsed.data.applicationIds) {
      const result = await rejectApplication({
        applicationId,
        eventId: session.eventId,
        actorId: session.user.id,
        reason: parsed.data.reason,
        ip,
      });
      if (result) rejected.push(result);
    }

    for (const person of rejected) {
      await notifyApplicationDecision({
        ...person,
        eventId: session.eventId,
        eventName: event.name,
        approved: false,
        reason: parsed.data.reason,
      });
    }

    revalidatePath("/admin/applicants");
    revalidatePath("/admin");

    return success(
      rejected.length === 1 ? "Prihláška je zamietnutá." : `Zamietli sme ${rejected.length} prihlášok.`,
      { count: rejected.length },
    );
  } catch (error) {
    return toActionResult(error, "Prihlášku sa nepodarilo zamietnuť.");
  }
}

const statusSchema = z.object({
  applicationIds: z.array(uuidSchema).min(1),
  status: z.enum(APPLICATION_STATUSES),
});

/** Zmena stavu bez rozhodnutia (reviewing / waitlist / archived). */
export async function setApplicationStatus(payload: unknown): Promise<ActionResult> {
  try {
    await assertSameOrigin();
    const session = await assertFullAdmin();
    if (!session.eventId) return failure("Nie je zvolený žiadny event.");

    const parsed = statusSchema.safeParse(payload);
    if (!parsed.success) return failure("Neplatný stav.", fieldErrors(parsed.error));

    if (parsed.data.status === "approved") {
      const result = await approveApplications({ applicationIds: parsed.data.applicationIds });
      return result.ok ? success(result.message) : result;
    }
    if (parsed.data.status === "rejected") {
      const result = await rejectApplications({ applicationIds: parsed.data.applicationIds });
      return result.ok ? success(result.message) : result;
    }

    const db = await getDb();
    const ip = await clientIp();

    const before = await db
      .select({ id: applications.id, status: applications.status })
      .from(applications)
      .where(
        and(
          inArray(applications.id, parsed.data.applicationIds),
          eq(applications.eventId, session.eventId),
        ),
      );

    await db
      .update(applications)
      .set({
        status: parsed.data.status,
        reviewedBy: session.user.id,
        reviewedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          inArray(applications.id, parsed.data.applicationIds),
          eq(applications.eventId, session.eventId),
        ),
      );

    for (const row of before) {
      await writeAudit({
        eventId: session.eventId,
        actorId: session.user.id,
        action: "application.status_changed",
        entity: "application",
        entityId: row.id,
        before: { status: row.status },
        after: { status: parsed.data.status },
        ip,
      });
    }

    revalidatePath("/admin/applicants");
    return success("Stav je zmenený.");
  } catch (error) {
    return toActionResult(error, "Stav sa nepodarilo zmeniť.");
  }
}

const noteSchema = z.object({
  applicationId: uuidSchema,
  note: z.string().trim().max(2000),
});

export async function saveApplicationNote(payload: unknown): Promise<ActionResult> {
  try {
    await assertSameOrigin();
    const session = await assertFullAdmin();
    if (!session.eventId) return failure("Nie je zvolený žiadny event.");

    const parsed = noteSchema.safeParse(payload);
    if (!parsed.success) return failure("Poznámku sa nepodarilo uložiť.", fieldErrors(parsed.error));

    const db = await getDb();
    const [before] = await db
      .select({ note: applications.internalNote })
      .from(applications)
      .where(
        and(eq(applications.id, parsed.data.applicationId), eq(applications.eventId, session.eventId)),
      )
      .limit(1);

    if (!before) return failure("Prihláška sa nenašla.");

    await db
      .update(applications)
      .set({ internalNote: parsed.data.note || null, updatedAt: new Date() })
      .where(eq(applications.id, parsed.data.applicationId));

    await writeAudit({
      eventId: session.eventId,
      actorId: session.user.id,
      action: "application.note_updated",
      entity: "application",
      entityId: parsed.data.applicationId,
      before: { note: before.note },
      after: { note: parsed.data.note || null },
      ip: await clientIp(),
    });

    revalidatePath(`/admin/applicants/${parsed.data.applicationId}`);
    return success("Poznámka je uložená.");
  } catch (error) {
    return toActionResult(error, "Poznámku sa nepodarilo uložiť.");
  }
}

/* ------------------------------------------------ dobrovoľníci a stánkari */

const simpleStatusSchema = z.object({
  ids: z.array(uuidSchema).min(1),
  status: z.enum(APPLICATION_STATUSES),
});

export async function setVolunteerStatus(payload: unknown): Promise<ActionResult> {
  return setSimpleStatus(payload, "volunteer");
}

export async function setVendorStatus(payload: unknown): Promise<ActionResult> {
  return setSimpleStatus(payload, "vendor");
}

async function setSimpleStatus(
  payload: unknown,
  kind: "volunteer" | "vendor",
): Promise<ActionResult> {
  try {
    await assertSameOrigin();
    const session = await assertFullAdmin();
    if (!session.eventId) return failure("Nie je zvolený žiadny event.");

    const parsed = simpleStatusSchema.safeParse(payload);
    if (!parsed.success) return failure("Neplatný stav.", fieldErrors(parsed.error));

    const db = await getDb();
    const table = kind === "volunteer" ? volunteerApplications : vendorApplications;

    const before = await db
      .select({ id: table.id, status: table.status })
      .from(table)
      .where(and(inArray(table.id, parsed.data.ids), eq(table.eventId, session.eventId)));

    if (before.length === 0) return failure("Prihlášky sa nenašli.");

    await db
      .update(table)
      .set({
        status: parsed.data.status,
        reviewedBy: session.user.id,
        reviewedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(inArray(table.id, parsed.data.ids), eq(table.eventId, session.eventId)));

    const ip = await clientIp();
    for (const row of before) {
      await writeAudit({
        eventId: session.eventId,
        actorId: session.user.id,
        action: kind === "volunteer" ? "volunteer.status_changed" : "vendor.status_changed",
        entity: kind === "volunteer" ? "volunteer_application" : "vendor_application",
        entityId: row.id,
        before: { status: row.status },
        after: { status: parsed.data.status },
        ip,
      });
    }

    revalidatePath(kind === "volunteer" ? "/admin/volunteers" : "/admin/vendors");
    return success("Stav je zmenený.");
  } catch (error) {
    return toActionResult(error, "Stav sa nepodarilo zmeniť.");
  }
}

/* ------------------------------------------------------- interné poznámky */

const staffNoteSchema = z.object({
  staffId: uuidSchema,
  body: z.string().trim().min(1, "Poznámka nemôže byť prázdna.").max(2000),
});

export async function addStaffNote(payload: unknown): Promise<ActionResult> {
  try {
    await assertSameOrigin();
    const session = await assertFullAdmin();
    if (!session.eventId) return failure("Nie je zvolený žiadny event.");

    const parsed = staffNoteSchema.safeParse(payload);
    if (!parsed.success) return failure("Poznámku sa nepodarilo uložiť.", fieldErrors(parsed.error));

    const db = await getDb();
    const [staff] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, parsed.data.staffId))
      .limit(1);
    if (!staff) return failure("Pracovník sa nenašiel.");

    await db.insert(staffNotes).values({
      eventId: session.eventId,
      staffId: parsed.data.staffId,
      authorId: session.user.id,
      body: parsed.data.body,
    });

    revalidatePath(`/admin/staff/${parsed.data.staffId}`);
    return success("Poznámka je pridaná.");
  } catch (error) {
    return toActionResult(error, "Poznámku sa nepodarilo uložiť.");
  }
}
