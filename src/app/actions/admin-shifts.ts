"use server";

import { and, eq, inArray, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getDb } from "@/db/client";
import { positions, shiftAssignments, shifts, users } from "@/db/schema";
import { DomainError, failure, success, toActionResult, type ActionResult } from "@/lib/action-result";
import { assertPermission, assertSameOrigin, clientIp } from "@/lib/auth/guards";
import { generateToken } from "@/lib/auth/tokens";
import { diffRecords, writeAudit } from "@/lib/audit";
import { getEventById } from "@/lib/domain/events";
import { notify } from "@/lib/domain/notifications";
import { buildAssignmentProposals } from "@/lib/domain/auto-assign";
import { findOverlappingAssignments, refreshShiftStatus } from "@/lib/domain/shifts";
import { emailTemplates } from "@/lib/email/templates";
import { formatDateShort, formatMoney, formatTimeRange, fromEventLocal } from "@/lib/format";
import { channels, realtime } from "@/lib/realtime";
import { fieldErrors, uuidSchema } from "@/lib/validation/common";
import { assignmentSchema, autoAssignSchema, shiftSchema } from "@/lib/validation/scheduling";

export async function saveShift(payload: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    await assertSameOrigin();
    const session = await assertPermission("can_manage_shifts");
    if (!session.eventId) return failure("Nie je zvolený žiadny event.");
    const eventId = session.eventId;

    const parsed = shiftSchema.safeParse(payload);
    if (!parsed.success) return failure("Skontroluj vyplnené údaje.", fieldErrors(parsed.error));
    const input = parsed.data;

    const event = await getEventById(eventId);
    if (!event) return failure("Event sa nenašiel.");
    const tz = event.timezone;

    const db = await getDb();
    const [position] = await db
      .select({ id: positions.id, name: positions.name })
      .from(positions)
      .where(and(eq(positions.id, input.positionId), eq(positions.eventId, eventId)))
      .limit(1);
    if (!position) return failure("Pozícia neexistuje v tomto evente.", { positionId: ["Neplatná pozícia."] });

    const startsAt = fromEventLocal(input.startsAt, tz);
    const endsAt = fromEventLocal(input.endsAt, tz);

    const values = {
      positionId: input.positionId,
      title: input.title || null,
      startsAt,
      endsAt,
      location: input.location || null,
      lat: input.lat != null ? String(input.lat) : null,
      lng: input.lng != null ? String(input.lng) : null,
      capacity: input.capacity,
      hourlyRate: input.hourlyRate != null ? input.hourlyRate.toFixed(2) : null,
      status: input.status,
      checkInMethod: input.checkInMethod,
      geofenceRadiusM: input.geofenceRadiusM,
      coordinatorId: input.coordinatorId || null,
      instructions: input.instructions ?? null,
      dressCode: input.dressCode ?? null,
      showColleagues: input.showColleagues,
      updatedAt: new Date(),
    };

    const ip = await clientIp();

    if (input.id) {
      const [before] = await db
        .select()
        .from(shifts)
        .where(and(eq(shifts.id, input.id), eq(shifts.eventId, eventId), isNull(shifts.deletedAt)))
        .limit(1);
      if (!before) return failure("Smena sa nenašla.");

      if (input.capacity < 1) return failure("Kapacita musí byť aspoň 1.");

      await db.update(shifts).set(values).where(eq(shifts.id, input.id));
      await refreshShiftStatus(input.id);

      const diff = diffRecords(
        {
          startsAt: before.startsAt,
          endsAt: before.endsAt,
          location: before.location,
          capacity: before.capacity,
          hourlyRate: before.hourlyRate,
          status: before.status,
          coordinatorId: before.coordinatorId,
        },
        {
          startsAt: values.startsAt,
          endsAt: values.endsAt,
          location: values.location,
          capacity: values.capacity,
          hourlyRate: values.hourlyRate,
          status: values.status,
          coordinatorId: values.coordinatorId,
        },
      );

      if (diff) {
        await writeAudit({
          eventId: eventId,
          actorId: session.user.id,
          action: "shift.updated",
          entity: "shift",
          entityId: input.id,
          before: diff.before,
          after: diff.after,
          ip,
        });

        // Zmena času, miesta alebo sadzby sa musí dostať k pridelenej crew.
        const timeChanged =
          before.startsAt.getTime() !== startsAt.getTime() ||
          before.endsAt.getTime() !== endsAt.getTime();
        const placeChanged = before.location !== values.location;
        const rateChanged = before.hourlyRate !== values.hourlyRate;

        if (timeChanged || placeChanged || rateChanged) {
          const change = [
            timeChanged ? `Nový čas: ${formatTimeRange(startsAt, endsAt, tz)}` : null,
            placeChanged ? `Nové miesto: ${values.location ?? "—"}` : null,
            rateChanged ? `Nová sadzba: ${formatMoney(values.hourlyRate ?? 0)} / hod` : null,
          ]
            .filter(Boolean)
            .join("<br>");

          await notifyAssignees({
            shiftId: input.id,
            eventId: eventId,
            positionName: position.name,
            when: `${formatDateShort(startsAt, tz)} · ${formatTimeRange(startsAt, endsAt, tz)}`,
            change,
          });
        }
      }

      realtime.publish([channels.event(eventId)], {
        type: "shift",
        eventId: eventId,
        shiftId: input.id,
        action: "updated",
      });

      revalidatePath("/admin/shifts");
      revalidatePath(`/admin/shifts/${input.id}`);
      revalidatePath("/admin/calendar");
      return success("Smena je uložená.", { id: input.id });
    }

    const [created] = await db
      .insert(shifts)
      .values({ ...values, eventId: eventId, qrSecret: generateToken(16) })
      .returning({ id: shifts.id });

    await writeAudit({
      eventId: eventId,
      actorId: session.user.id,
      action: "shift.created",
      entity: "shift",
      entityId: created.id,
      after: {
        position: position.name,
        startsAt: startsAt.toISOString(),
        capacity: values.capacity,
      },
      ip,
    });

    realtime.publish([channels.event(eventId)], {
      type: "shift",
      eventId: eventId,
      shiftId: created.id,
      action: "created",
    });

    revalidatePath("/admin/shifts");
    revalidatePath("/admin/calendar");
    return success("Smena je vytvorená.", { id: created.id });
  } catch (error) {
    return toActionResult(error, "Smenu sa nepodarilo uložiť.");
  }
}

async function notifyAssignees(args: {
  shiftId: string;
  eventId: string;
  positionName: string;
  when: string;
  change: string;
}) {
  const db = await getDb();
  const rows = await db
    .select({
      userId: users.id,
      email: users.email,
      firstName: users.firstName,
    })
    .from(shiftAssignments)
    .innerJoin(users, eq(users.id, shiftAssignments.userId))
    .where(
      and(
        eq(shiftAssignments.shiftId, args.shiftId),
        inArray(shiftAssignments.status, ["invited", "pending_confirmation", "confirmed"]),
      ),
    );

  for (const row of rows) {
    await notify(
      {
        userId: row.userId,
        eventId: args.eventId,
        type: "shift_updated",
        title: "Zmena na tvojej smene",
        body: `${args.positionName} · ${args.when}`,
        actionUrl: `/portal/shifts/${args.shiftId}`,
        entityType: "shift",
        entityId: args.shiftId,
      },
      {
        email: emailTemplates.shiftUpdated({
          to: row.email,
          firstName: row.firstName,
          positionName: args.positionName,
          when: args.when,
          shiftId: args.shiftId,
          change: args.change,
        }),
      },
    );
  }
}

export async function cancelShift(payload: unknown): Promise<ActionResult> {
  try {
    await assertSameOrigin();
    const session = await assertPermission("can_manage_shifts");
    if (!session.eventId) return failure("Nie je zvolený žiadny event.");
    const eventId = session.eventId;

    const parsed = z.object({ shiftId: uuidSchema, reason: z.string().trim().max(400).optional() }).safeParse(payload);
    if (!parsed.success) return failure("Neplatná smena.");

    const event = await getEventById(eventId);
    const db = await getDb();
    const [shift] = await db
      .select({
        id: shifts.id,
        status: shifts.status,
        startsAt: shifts.startsAt,
        endsAt: shifts.endsAt,
        positionName: positions.name,
      })
      .from(shifts)
      .innerJoin(positions, eq(positions.id, shifts.positionId))
      .where(and(eq(shifts.id, parsed.data.shiftId), eq(shifts.eventId, eventId)))
      .limit(1);
    if (!shift) return failure("Smena sa nenašla.");

    const assignees = await db
      .select({ userId: users.id, email: users.email, firstName: users.firstName })
      .from(shiftAssignments)
      .innerJoin(users, eq(users.id, shiftAssignments.userId))
      .where(
        and(
          eq(shiftAssignments.shiftId, shift.id),
          inArray(shiftAssignments.status, ["invited", "pending_confirmation", "confirmed"]),
        ),
      );

    await db.transaction(async (tx) => {
      await tx
        .update(shifts)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(eq(shifts.id, shift.id));
      await tx
        .update(shiftAssignments)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(eq(shiftAssignments.shiftId, shift.id));
      await writeAudit(
        {
          eventId: eventId,
          actorId: session.user.id,
          action: "shift.cancelled",
          entity: "shift",
          entityId: shift.id,
          before: { status: shift.status },
          after: { status: "cancelled", reason: parsed.data.reason ?? null },
          ip: await clientIp(),
        },
        tx,
      );
    });

    const tz = event?.timezone ?? "Europe/Bratislava";
    const when = `${formatDateShort(shift.startsAt, tz)} · ${formatTimeRange(shift.startsAt, shift.endsAt, tz)}`;
    for (const person of assignees) {
      await notify(
        {
          userId: person.userId,
          eventId: eventId,
          type: "shift_cancelled",
          title: "Smena bola zrušená",
          body: `${shift.positionName} · ${when}`,
          actionUrl: "/portal/shifts",
          entityType: "shift",
          entityId: shift.id,
        },
        {
          email: emailTemplates.shiftCancelled({
            to: person.email,
            firstName: person.firstName,
            positionName: shift.positionName,
            when,
          }),
        },
      );
    }

    revalidatePath("/admin/shifts");
    revalidatePath("/admin/calendar");
    return success(
      assignees.length > 0
        ? `Smena je zrušená. Upozornili sme ${assignees.length} ${assignees.length === 1 ? "človeka" : "ľudí"}.`
        : "Smena je zrušená.",
    );
  } catch (error) {
    return toActionResult(error, "Smenu sa nepodarilo zrušiť.");
  }
}

/* --------------------------------------------------------- prideľovanie */

export async function assignStaff(payload: unknown): Promise<ActionResult<{ assigned: number }>> {
  try {
    await assertSameOrigin();
    const session = await assertPermission("can_manage_shifts");
    if (!session.eventId) return failure("Nie je zvolený žiadny event.");
    const eventId = session.eventId;

    const parsed = assignmentSchema.safeParse(payload);
    if (!parsed.success) return failure("Neplatný výber.", fieldErrors(parsed.error));

    const event = await getEventById(eventId);
    if (!event) return failure("Event sa nenašiel.");

    const db = await getDb();
    const [shift] = await db
      .select({
        id: shifts.id,
        startsAt: shifts.startsAt,
        endsAt: shifts.endsAt,
        capacity: shifts.capacity,
        location: shifts.location,
        status: shifts.status,
        hourlyRate: shifts.hourlyRate,
        positionName: positions.name,
        positionRate: positions.hourlyRate,
      })
      .from(shifts)
      .innerJoin(positions, eq(positions.id, shifts.positionId))
      .where(
        and(
          eq(shifts.id, parsed.data.shiftId),
          eq(shifts.eventId, eventId),
          isNull(shifts.deletedAt),
        ),
      )
      .limit(1);
    if (!shift) return failure("Smena sa nenašla.");
    if (shift.status === "cancelled") return failure("Zrušenú smenu nemožno obsadzovať.");

    const existing = await db
      .select({ userId: shiftAssignments.userId, status: shiftAssignments.status })
      .from(shiftAssignments)
      .where(eq(shiftAssignments.shiftId, shift.id));

    const activeCount = existing.filter(
      (row) => row.status !== "cancelled" && row.status !== "declined",
    ).length;

    const alreadyAssigned = new Set(
      existing.filter((row) => row.status !== "cancelled" && row.status !== "declined").map((r) => r.userId),
    );

    const toAssign = parsed.data.userIds.filter((id) => !alreadyAssigned.has(id));
    if (toAssign.length === 0) return failure("Vybraní ľudia už na tejto smene sú.");

    // Rule: kapacitu smeny nemožno prekročiť.
    if (activeCount + toAssign.length > shift.capacity) {
      return failure(
        `Na smenu sa zmestí ešte ${shift.capacity - activeCount} ${shift.capacity - activeCount === 1 ? "človek" : "ľudí"}. Zväčši kapacitu alebo vyber menej ľudí.`,
      );
    }

    // Rule 7: nikdy nepriraď na prekrývajúce sa smeny.
    const conflicts: string[] = [];
    for (const userId of toAssign) {
      const overlaps = await findOverlappingAssignments({
        userId,
        startsAt: shift.startsAt,
        endsAt: shift.endsAt,
        excludeShiftId: shift.id,
      });
      if (overlaps.length > 0) {
        const [person] = await db
          .select({ firstName: users.firstName, lastName: users.lastName })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1);
        conflicts.push(
          `${person?.firstName ?? ""} ${person?.lastName ?? ""}`.trim() +
            ` má v tom čase ${overlaps[0].positionName}`,
        );
      }
    }
    if (conflicts.length > 0) {
      return failure(`Časový konflikt: ${conflicts.join("; ")}.`);
    }

    const tz = event.timezone;
    const when = `${formatDateShort(shift.startsAt, tz)} · ${formatTimeRange(shift.startsAt, shift.endsAt, tz)}`;
    const rate = formatMoney(Number(shift.hourlyRate ?? shift.positionRate));

    await db.transaction(async (tx) => {
      for (const userId of toAssign) {
        // Predchádzajúce zrušené/odmietnuté pridelenie oživíme, nevytvárame duplicitu.
        const previous = existing.find((row) => row.userId === userId);
        if (previous) {
          await tx
            .update(shiftAssignments)
            .set({
              status: "pending_confirmation",
              assignedBy: session.user.id,
              declinedAt: null,
              declineReason: null,
              needsReplacement: false,
              note: parsed.data.note ?? null,
              updatedAt: new Date(),
            })
            .where(
              and(eq(shiftAssignments.shiftId, shift.id), eq(shiftAssignments.userId, userId)),
            );
        } else {
          await tx.insert(shiftAssignments).values({
            shiftId: shift.id,
            userId,
            eventId: eventId,
            // Rule 2: pridelenie ≠ potvrdenie.
            status: "pending_confirmation",
            assignedBy: session.user.id,
            note: parsed.data.note ?? null,
          });
        }
      }

      await writeAudit(
        {
          eventId: eventId,
          actorId: session.user.id,
          action: "assignment.created",
          entity: "shift",
          entityId: shift.id,
          after: { userIds: toAssign, position: shift.positionName },
          ip: await clientIp(),
        },
        tx,
      );
    });

    await refreshShiftStatus(shift.id);

    for (const userId of toAssign) {
      const [person] = await db
        .select({ email: users.email, firstName: users.firstName })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!person) continue;

      await notify(
        {
          userId,
          eventId: eventId,
          type: "shift_assigned",
          title: "Máš novú smenu",
          body: `${shift.positionName} · ${when}`,
          actionUrl: `/portal/shifts/${shift.id}`,
          entityType: "shift",
          entityId: shift.id,
          requiresAction: true,
        },
        {
          email: emailTemplates.shiftAssigned({
            to: person.email,
            firstName: person.firstName,
            positionName: shift.positionName,
            when,
            location: shift.location ?? "—",
            rate: `${rate} / hod`,
            shiftId: shift.id,
          }),
        },
      );
    }

    revalidatePath(`/admin/shifts/${shift.id}`);
    revalidatePath("/admin/assignments");
    revalidatePath("/admin/shifts");

    return success(
      toAssign.length === 1
        ? "Smena je pridelená. Pracovník ju musí ešte potvrdiť."
        : `Pridelili sme ${toAssign.length} ľudí. Každý musí smenu potvrdiť.`,
      { assigned: toAssign.length },
    );
  } catch (error) {
    return toActionResult(error, "Smenu sa nepodarilo prideliť.");
  }
}

export async function removeAssignment(payload: unknown): Promise<ActionResult> {
  try {
    await assertSameOrigin();
    const session = await assertPermission("can_manage_shifts");
    if (!session.eventId) return failure("Nie je zvolený žiadny event.");
    const eventId = session.eventId;

    const parsed = z.object({ assignmentId: uuidSchema }).safeParse(payload);
    if (!parsed.success) return failure("Neplatné pridelenie.");

    const db = await getDb();
    const [assignment] = await db
      .select({
        id: shiftAssignments.id,
        shiftId: shiftAssignments.shiftId,
        userId: shiftAssignments.userId,
        status: shiftAssignments.status,
      })
      .from(shiftAssignments)
      .where(
        and(
          eq(shiftAssignments.id, parsed.data.assignmentId),
          eq(shiftAssignments.eventId, eventId),
        ),
      )
      .limit(1);
    if (!assignment) return failure("Pridelenie sa nenašlo.");

    await db
      .update(shiftAssignments)
      .set({ status: "cancelled", needsReplacement: false, updatedAt: new Date() })
      .where(eq(shiftAssignments.id, assignment.id));

    await refreshShiftStatus(assignment.shiftId);

    await writeAudit({
      eventId: eventId,
      actorId: session.user.id,
      action: "assignment.removed",
      entity: "shift",
      entityId: assignment.shiftId,
      before: { userId: assignment.userId, status: assignment.status },
      ip: await clientIp(),
    });

    await notify({
      userId: assignment.userId,
      eventId: eventId,
      type: "shift_cancelled",
      title: "Smena ti bola odobraná",
      body: "Koordinátor ťa odobral zo smeny. Pozri si aktuálny rozpis.",
      actionUrl: "/portal/shifts",
      entityType: "shift",
      entityId: assignment.shiftId,
    });

    revalidatePath(`/admin/shifts/${assignment.shiftId}`);
    revalidatePath("/admin/assignments");
    return success("Pridelenie je zrušené.");
  } catch (error) {
    return toActionResult(error, "Pridelenie sa nepodarilo zrušiť.");
  }
}

export { DomainError };

/* -------------------------------------------- automatické prideľovanie */

/**
 * Vygeneruje návrh obsadenia. Bez `confirm: true` sa nič nezapisuje —
 * admin musí návrh najprv vidieť a schváliť (§17).
 */
export async function proposeAutoAssignment(payload: unknown): Promise<
  ActionResult<{
    proposals: {
      shiftId: string;
      positionName: string;
      startsAt: string;
      endsAt: string;
      capacity: number;
      alreadyFilled: number;
      needed: number;
      shortfall: number;
      picked: {
        userId: string;
        name: string;
        score: number;
        assignedHours: number;
        prefersPosition: boolean;
        available: boolean;
      }[];
    }[];
  }>
> {
  try {
    await assertSameOrigin();
    const session = await assertPermission("can_manage_shifts");
    if (!session.eventId) return failure("Nie je zvolený žiadny event.");
    const eventId = session.eventId;

    const parsed = autoAssignSchema.safeParse(payload);
    if (!parsed.success) return failure("Vyber aspoň jednu smenu.", fieldErrors(parsed.error));

    const proposals = await buildAssignmentProposals(eventId, parsed.data.shiftIds);
    const totalPicked = proposals.reduce((sum, p) => sum + p.picked.length, 0);

    if (totalPicked === 0) {
      return failure(
        "Nenašli sme nikoho vhodného. Skontroluj dostupnosť crew a či nemajú kolízie s inými smenami.",
      );
    }

    return success(
      `Návrh je pripravený: ${totalPicked} ${totalPicked === 1 ? "pridelenie" : "pridelení"}.`,
      {
        proposals: proposals.map((proposal) => ({
          shiftId: proposal.shiftId,
          positionName: proposal.positionName,
          startsAt: proposal.startsAt.toISOString(),
          endsAt: proposal.endsAt.toISOString(),
          capacity: proposal.capacity,
          alreadyFilled: proposal.alreadyFilled,
          needed: proposal.needed,
          shortfall: proposal.shortfall,
          picked: proposal.picked.map((candidate) => ({
            userId: candidate.userId,
            name: `${candidate.firstName} ${candidate.lastName}`,
            score: candidate.score,
            assignedHours: candidate.assignedHours,
            prefersPosition: candidate.prefersPosition,
            available: candidate.available,
          })),
        })),
      },
    );
  } catch (error) {
    return toActionResult(error, "Návrh sa nepodarilo vytvoriť.");
  }
}

const confirmSchema = z.object({
  assignments: z
    .array(z.object({ shiftId: uuidSchema, userIds: z.array(uuidSchema) }))
    .min(1, "Návrh je prázdny."),
});

/** Potvrdenie návrhu adminom — až tu vznikajú skutočné pridelenia. */
export async function confirmAutoAssignment(payload: unknown): Promise<ActionResult<{ assigned: number }>> {
  try {
    await assertSameOrigin();
    const session = await assertPermission("can_manage_shifts");
    if (!session.eventId) return failure("Nie je zvolený žiadny event.");
    const eventId = session.eventId;

    const parsed = confirmSchema.safeParse(payload);
    if (!parsed.success) return failure("Návrh sa nepodarilo potvrdiť.", fieldErrors(parsed.error));

    let assigned = 0;
    const problems: string[] = [];

    for (const group of parsed.data.assignments) {
      if (group.userIds.length === 0) continue;
      // Prechádza rovnakou cestou ako manuálne pridelenie — vrátane kontroly kolízií.
      const result = await assignStaff({ shiftId: group.shiftId, userIds: group.userIds });
      if (result.ok) assigned += result.data?.assigned ?? 0;
      else problems.push(result.message);
    }

    await writeAudit({
      eventId,
      actorId: session.user.id,
      action: "assignment.auto_assigned",
      entity: "event",
      entityId: eventId,
      after: { assigned, shifts: parsed.data.assignments.length },
      ip: await clientIp(),
    });

    revalidatePath("/admin/assignments");
    revalidatePath("/admin/shifts");

    if (assigned === 0) {
      return failure(problems[0] ?? "Nepodarilo sa prideliť nikoho.");
    }
    return success(
      problems.length > 0
        ? `Pridelili sme ${assigned} ľudí. ${problems.length} ${problems.length === 1 ? "smena sa nepodarila" : "smien sa nepodarilo"}: ${problems[0]}`
        : `Pridelili sme ${assigned} ${assigned === 1 ? "človeka" : "ľudí"}. Každý musí smenu potvrdiť.`,
      { assigned },
    );
  } catch (error) {
    return toActionResult(error, "Návrh sa nepodarilo potvrdiť.");
  }
}
