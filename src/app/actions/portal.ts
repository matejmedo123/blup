"use server";

import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getDb } from "@/db/client";
import {
  attendance,
  availabilities,
  experiences,
  notifications,
  positions,
  shiftAssignments,
  shifts,
  users,
} from "@/db/schema";
import { failure, success, toActionResult, type ActionResult } from "@/lib/action-result";
import { assertSameOrigin, assertSession, clientIp } from "@/lib/auth/guards";
import { writeAudit } from "@/lib/audit";
import { getEventById } from "@/lib/domain/events";
import { notify, markNotificationsRead } from "@/lib/domain/notifications";
import { applyScoreRule } from "@/lib/domain/score";
import { formatDateShort, formatTimeRange } from "@/lib/format";
import { fieldErrors, phoneSchema, uuidSchema } from "@/lib/validation/common";

const confirmSchema = z.object({
  assignmentId: uuidSchema,
  attending: z.boolean(),
  reason: z.string().trim().max(300).optional(),
});

/**
 * Potvrdenie alebo odmietnutie smeny pracovníkom (Rule 2, §18).
 * Odmietnutie označí smenu ako `needs_replacement` a upozorní koordinátora.
 */
export async function respondToShift(payload: unknown): Promise<ActionResult> {
  try {
    await assertSameOrigin();
    const session = await assertSession();
    if (!session.eventId) return failure("Nie je zvolený žiadny event.");
    const eventId = session.eventId;

    const parsed = confirmSchema.safeParse(payload);
    if (!parsed.success) return failure("Neplatná odpoveď.", fieldErrors(parsed.error));

    const db = await getDb();
    const [row] = await db
      .select({
        assignmentId: shiftAssignments.id,
        status: shiftAssignments.status,
        shiftId: shifts.id,
        startsAt: shifts.startsAt,
        endsAt: shifts.endsAt,
        positionName: positions.name,
        coordinatorId: shifts.coordinatorId,
      })
      .from(shiftAssignments)
      .innerJoin(shifts, eq(shifts.id, shiftAssignments.shiftId))
      .innerJoin(positions, eq(positions.id, shifts.positionId))
      .where(
        and(
          eq(shiftAssignments.id, parsed.data.assignmentId),
          // Rule 4: pracovník smie odpovedať len za seba.
          eq(shiftAssignments.userId, session.user.id),
          isNull(shifts.deletedAt),
        ),
      )
      .limit(1);

    if (!row) return failure("Táto smena ti nepatrí.");
    if (row.status === "cancelled") return failure("Táto smena už bola zrušená.");
    if (row.status === "completed") return failure("Táto smena je už odpracovaná.");

    const event = await getEventById(eventId);
    const tz = event?.timezone ?? "Europe/Bratislava";
    const when = `${formatDateShort(row.startsAt, tz)} · ${formatTimeRange(row.startsAt, row.endsAt, tz)}`;
    const now = new Date();

    if (parsed.data.attending) {
      await db
        .update(shiftAssignments)
        .set({
          status: "confirmed",
          confirmedAt: now,
          declinedAt: null,
          declineReason: null,
          needsReplacement: false,
          updatedAt: now,
        })
        .where(eq(shiftAssignments.id, row.assignmentId));

      await applyScoreRule({
        userId: session.user.id,
        eventId,
        ruleKey: "shift_confirmed",
        reason: `Potvrdená smena · ${row.positionName}`,
        entityType: "shift",
        entityId: row.shiftId,
      });
    } else {
      // Zrušenie menej než 24 h pred smenou je „na poslednú chvíľu“.
      const hoursToStart = (row.startsAt.getTime() - now.getTime()) / 3_600_000;

      await db
        .update(shiftAssignments)
        .set({
          status: "declined",
          declinedAt: now,
          declineReason: parsed.data.reason ?? null,
          needsReplacement: true,
          updatedAt: now,
        })
        .where(eq(shiftAssignments.id, row.assignmentId));

      if (hoursToStart < 24) {
        await applyScoreRule({
          userId: session.user.id,
          eventId,
          ruleKey: "late_cancel",
          reason: `Zrušenie na poslednú chvíľu · ${row.positionName}`,
          entityType: "shift",
          entityId: row.shiftId,
        });
      }

      // Alert pre koordinátora a adminov eventu.
      const recipients = await db
        .select({ id: users.id })
        .from(users)
        .innerJoin(
          shiftAssignments,
          eq(shiftAssignments.userId, users.id),
        )
        .where(eq(users.id, row.coordinatorId ?? session.user.id))
        .limit(1);

      const notifyIds = new Set<string>();
      if (row.coordinatorId) notifyIds.add(row.coordinatorId);
      for (const person of recipients) notifyIds.add(person.id);
      notifyIds.delete(session.user.id);

      for (const userId of notifyIds) {
        await notify({
          userId,
          eventId,
          type: "shift_updated",
          title: `${session.user.fullName} nemôže prísť`,
          body: `${row.positionName} · ${when}${parsed.data.reason ? ` · ${parsed.data.reason}` : ""}`,
          actionUrl: `/admin/shifts/${row.shiftId}`,
          entityType: "shift",
          entityId: row.shiftId,
          requiresAction: true,
        });
      }
    }

    // Notifikácia, ktorá si vyžiadala akciu, je vybavená.
    await db
      .update(notifications)
      .set({ actionTakenAt: now, readAt: now })
      .where(
        and(
          eq(notifications.userId, session.user.id),
          eq(notifications.entityId, row.shiftId),
          eq(notifications.requiresAction, true),
          isNull(notifications.actionTakenAt),
        ),
      );

    await writeAudit({
      eventId,
      actorId: session.user.id,
      action: "assignment.status_changed",
      entity: "shift_assignment",
      entityId: row.assignmentId,
      before: { status: row.status },
      after: { status: parsed.data.attending ? "confirmed" : "declined" },
      ip: await clientIp(),
    });

    revalidatePath("/portal");
    revalidatePath("/portal/shifts");
    revalidatePath(`/portal/shifts/${row.shiftId}`);
    revalidatePath("/portal/notifications");
    revalidatePath("/admin/assignments");

    return success(
      parsed.data.attending
        ? "Smena je potvrdená. Vidíme sa!"
        : "Dali sme vedieť koordinátorovi. Hľadáme náhradu.",
    );
  } catch (error) {
    return toActionResult(error, "Odpoveď sa nepodarilo uložiť.");
  }
}

const profileSchema = z.object({
  phone: phoneSchema,
  city: z.string().trim().min(2, "Zadaj mesto.").max(80),
  avatarUrl: z.string().trim().url("Zadaj platnú adresu obrázka.").optional().or(z.literal("")),
});

export async function updateOwnProfile(payload: unknown): Promise<ActionResult> {
  try {
    await assertSameOrigin();
    const session = await assertSession();

    const parsed = profileSchema.safeParse(payload);
    if (!parsed.success) return failure("Skontroluj vyplnené údaje.", fieldErrors(parsed.error));

    const db = await getDb();
    await db
      .update(users)
      .set({
        phone: parsed.data.phone,
        city: parsed.data.city,
        avatarUrl: parsed.data.avatarUrl || null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, session.user.id));

    revalidatePath("/portal/profile");
    return success("Profil je uložený.");
  } catch (error) {
    return toActionResult(error, "Profil sa nepodarilo uložiť.");
  }
}

const availabilitySchema = z.object({
  days: z
    .array(
      z.object({
        day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        timeFrom: z.string().regex(/^\d{2}:\d{2}$/),
        timeTo: z.string().regex(/^\d{2}:\d{2}$/),
      }),
    )
    .max(60),
  maxHours: z.coerce.number().int().min(4).max(200).optional(),
});

export async function updateOwnAvailability(payload: unknown): Promise<ActionResult> {
  try {
    await assertSameOrigin();
    const session = await assertSession();
    if (!session.eventId) return failure("Nie je zvolený žiadny event.");
    const eventId = session.eventId;

    const parsed = availabilitySchema.safeParse(payload);
    if (!parsed.success) return failure("Skontroluj dostupnosť.", fieldErrors(parsed.error));

    const db = await getDb();
    await db.transaction(async (tx) => {
      await tx
        .delete(availabilities)
        .where(
          and(eq(availabilities.userId, session.user.id), eq(availabilities.eventId, eventId)),
        );
      if (parsed.data.days.length > 0) {
        await tx.insert(availabilities).values(
          parsed.data.days.map((day) => ({
            userId: session.user.id,
            eventId,
            day: day.day,
            timeFrom: day.timeFrom,
            timeTo: day.timeTo,
            maxHours: parsed.data.maxHours ?? null,
          })),
        );
      }
    });

    revalidatePath("/portal/profile");
    return success("Dostupnosť je uložená.");
  } catch (error) {
    return toActionResult(error, "Dostupnosť sa nepodarilo uložiť.");
  }
}

export async function markAllNotificationsRead(): Promise<ActionResult> {
  try {
    await assertSameOrigin();
    const session = await assertSession();
    await markNotificationsRead(session.user.id);
    revalidatePath("/portal/notifications");
    revalidatePath("/portal");
    return success("Označené ako prečítané.");
  } catch (error) {
    return toActionResult(error, "Nepodarilo sa označiť notifikácie.");
  }
}

/** GDPR: export vlastných údajov ako JSON (§37). */
export async function exportOwnData(): Promise<ActionResult<{ json: string }>> {
  try {
    await assertSameOrigin();
    const session = await assertSession();
    const db = await getDb();

    const [profile] = await db
      .select({
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
        phone: users.phone,
        city: users.city,
        birthYear: users.birthYear,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.id, session.user.id))
      .limit(1);

    const [experienceRows, availabilityRows, assignmentRows, attendanceRows] = await Promise.all([
      db.select().from(experiences).where(eq(experiences.userId, session.user.id)),
      db.select().from(availabilities).where(eq(availabilities.userId, session.user.id)),
      db
        .select({
          shiftId: shiftAssignments.shiftId,
          status: shiftAssignments.status,
          confirmedAt: shiftAssignments.confirmedAt,
        })
        .from(shiftAssignments)
        .where(eq(shiftAssignments.userId, session.user.id)),
      db
        .select({
          checkInAt: attendance.checkInAt,
          checkOutAt: attendance.checkOutAt,
          workedMinutes: attendance.workedMinutes,
          status: attendance.status,
        })
        .from(attendance)
        .where(eq(attendance.userId, session.user.id)),
    ]);

    const json = JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        profile,
        experiences: experienceRows,
        availability: availabilityRows,
        assignments: assignmentRows,
        attendance: attendanceRows,
      },
      null,
      2,
    );

    return success("Export je pripravený.", { json });
  } catch (error) {
    return toActionResult(error, "Export sa nepodaril.");
  }
}
