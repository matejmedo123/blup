"use server";

import { and, eq, inArray, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getDb } from "@/db/client";
import {
  conversationMembers,
  conversations,
  eventMembers,
  positions,
  shiftAssignments,
  shifts,
  users,
} from "@/db/schema";
import { failure, success, toActionResult, type ActionResult } from "@/lib/action-result";
import { assertPermission, assertSameOrigin, assertSession, clientIp } from "@/lib/auth/guards";
import { writeAudit } from "@/lib/audit";
import { ensureDirectConversation } from "@/lib/domain/applications";
import {
  createBroadcast,
  ensureShiftConversation,
  markConversationRead,
  requireConversationMember,
  sendMessage,
} from "@/lib/domain/messaging";
import { fieldErrors, uuidSchema } from "@/lib/validation/common";

const sendSchema = z.object({
  conversationId: uuidSchema,
  body: z.string().trim().min(1, "Správa nemôže byť prázdna.").max(4000, "Správa je príliš dlhá."),
});

export async function postMessage(payload: unknown): Promise<ActionResult<{ messageId: string }>> {
  try {
    await assertSameOrigin();
    const session = await assertSession();

    const parsed = sendSchema.safeParse(payload);
    if (!parsed.success) return failure("Správu sa nepodarilo odoslať.", fieldErrors(parsed.error));

    // Rule 8: členstvo rozhoduje o prístupe, nie rola.
    const membership = await requireConversationMember(
      parsed.data.conversationId,
      session.user.id,
    );
    if (!membership.canWrite) {
      return failure("Do tejto konverzácie nemôžeš písať — je len na oznamy.");
    }

    const messageId = await sendMessage({
      conversationId: parsed.data.conversationId,
      senderId: session.user.id,
      body: parsed.data.body,
      eventId: membership.eventId,
      senderName: session.user.fullName,
    });

    await markConversationRead(parsed.data.conversationId, session.user.id);

    revalidatePath(`/portal/messages/${parsed.data.conversationId}`);
    revalidatePath(`/admin/messages/${parsed.data.conversationId}`);
    return success(undefined, { messageId });
  } catch (error) {
    return toActionResult(error, "Správu sa nepodarilo odoslať.");
  }
}

export async function markRead(conversationId: string): Promise<ActionResult> {
  try {
    await assertSameOrigin();
    const session = await assertSession();
    await requireConversationMember(conversationId, session.user.id);
    await markConversationRead(conversationId, session.user.id);
    revalidatePath("/portal/messages");
    return success();
  } catch (error) {
    return toActionResult(error, "Nepodarilo sa označiť konverzáciu.");
  }
}

/** Otvorí (alebo vytvorí) priamu konverzáciu s druhým človekom. */
export async function openDirectConversation(
  targetUserId: string,
): Promise<ActionResult<{ conversationId: string }>> {
  try {
    await assertSameOrigin();
    const session = await assertSession();
    if (!session.eventId) return failure("Nie je zvolený žiadny event.");
    if (targetUserId === session.user.id) return failure("Sám sebe písať nemôžeš.");

    const db = await getDb();
    // Písať sa dá len ľuďom z rovnakého eventu.
    const [membership] = await db
      .select({ id: eventMembers.id })
      .from(eventMembers)
      .where(
        and(
          eq(eventMembers.userId, targetUserId),
          eq(eventMembers.eventId, session.eventId),
          eq(eventMembers.active, true),
        ),
      )
      .limit(1);
    if (!membership) return failure("Tento človek nie je na tvojom evente.");

    const conversationId = await ensureDirectConversation({
      eventId: session.eventId,
      userA: session.user.id,
      userB: targetUserId,
    });

    return success(undefined, { conversationId });
  } catch (error) {
    return toActionResult(error, "Konverzáciu sa nepodarilo otvoriť.");
  }
}

/** Chat k smene — dostupný členom smeny a jej koordinátorovi. */
export async function openShiftConversation(
  shiftId: string,
): Promise<ActionResult<{ conversationId: string }>> {
  try {
    await assertSameOrigin();
    const session = await assertSession();
    if (!session.eventId) return failure("Nie je zvolený žiadny event.");

    const db = await getDb();
    const [access] = await db
      .select({ id: shiftAssignments.id })
      .from(shiftAssignments)
      .where(
        and(eq(shiftAssignments.shiftId, shiftId), eq(shiftAssignments.userId, session.user.id)),
      )
      .limit(1);

    const [asCoordinator] = await db
      .select({ id: shifts.id })
      .from(shifts)
      .where(and(eq(shifts.id, shiftId), eq(shifts.coordinatorId, session.user.id)))
      .limit(1);

    if (!access && !asCoordinator) {
      return failure("K tejto smene nemáš prístup.");
    }

    const conversationId = await ensureShiftConversation(shiftId);
    if (!conversationId) return failure("Smena sa nenašla.");

    return success(undefined, { conversationId });
  } catch (error) {
    return toActionResult(error, "Chat k smene sa nepodarilo otvoriť.");
  }
}

const broadcastSchema = z.object({
  title: z.string().trim().min(2, "Zadaj názov správy.").max(120),
  body: z.string().trim().min(1, "Správa nemôže byť prázdna.").max(4000),
  audience: z.enum(["all", "position", "shift", "custom"]),
  positionId: uuidSchema.optional(),
  shiftId: uuidSchema.optional(),
  userIds: z.array(uuidSchema).optional(),
});

/** Hromadná správa: všetkým / na pozíciu / na smenu / vybraným ľuďom (§20). */
export async function sendBroadcast(payload: unknown): Promise<ActionResult<{ conversationId: string }>> {
  try {
    await assertSameOrigin();
    const session = await assertPermission("can_message_staff");
    if (!session.eventId) return failure("Nie je zvolený žiadny event.");
    const eventId = session.eventId;

    const parsed = broadcastSchema.safeParse(payload);
    if (!parsed.success) return failure("Skontroluj správu.", fieldErrors(parsed.error));
    const input = parsed.data;

    const db = await getDb();
    let recipientIds: string[] = [];

    if (input.audience === "all") {
      const rows = await db
        .select({ userId: eventMembers.userId })
        .from(eventMembers)
        .innerJoin(users, eq(users.id, eventMembers.userId))
        .where(
          and(
            eq(eventMembers.eventId, eventId),
            eq(eventMembers.active, true),
            eq(users.status, "active"),
            isNull(users.deletedAt),
          ),
        );
      recipientIds = rows.map((r) => r.userId);
    } else if (input.audience === "position") {
      if (!input.positionId) return failure("Vyber pozíciu.");
      const rows = await db
        .select({ userId: shiftAssignments.userId })
        .from(shiftAssignments)
        .innerJoin(shifts, eq(shifts.id, shiftAssignments.shiftId))
        .where(
          and(
            eq(shifts.eventId, eventId),
            eq(shifts.positionId, input.positionId),
            inArray(shiftAssignments.status, ["invited", "pending_confirmation", "confirmed", "completed"]),
          ),
        );
      recipientIds = [...new Set(rows.map((r) => r.userId))];
    } else if (input.audience === "shift") {
      if (!input.shiftId) return failure("Vyber smenu.");
      const rows = await db
        .select({ userId: shiftAssignments.userId })
        .from(shiftAssignments)
        .where(
          and(
            eq(shiftAssignments.shiftId, input.shiftId),
            inArray(shiftAssignments.status, ["invited", "pending_confirmation", "confirmed", "completed"]),
          ),
        );
      recipientIds = rows.map((r) => r.userId);
    } else {
      if (!input.userIds || input.userIds.length === 0) return failure("Vyber príjemcov.");
      // Aj pri vlastnom výbere overíme, že ide o ľudí z tohto eventu.
      const rows = await db
        .select({ userId: eventMembers.userId })
        .from(eventMembers)
        .where(
          and(
            eq(eventMembers.eventId, eventId),
            eq(eventMembers.active, true),
            inArray(eventMembers.userId, input.userIds),
          ),
        );
      recipientIds = rows.map((r) => r.userId);
    }

    recipientIds = recipientIds.filter((id) => id !== session.user.id);
    if (recipientIds.length === 0) {
      return failure("Pre zvolené publikum sme nenašli žiadneho príjemcu.");
    }

    const result = await createBroadcast({
      eventId,
      createdBy: session.user.id,
      title: input.title,
      body: input.body,
      recipientIds,
      senderName: session.user.fullName,
    });

    await writeAudit({
      eventId,
      actorId: session.user.id,
      action: "message.broadcast",
      entity: "conversation",
      entityId: result.conversationId,
      after: { audience: input.audience, recipients: result.recipients, title: input.title },
      ip: await clientIp(),
    });

    revalidatePath("/admin/messages");
    return success(
      `Správa je odoslaná ${result.recipients} ${result.recipients === 1 ? "človeku" : "ľuďom"}.`,
      { conversationId: result.conversationId },
    );
  } catch (error) {
    return toActionResult(error, "Hromadnú správu sa nepodarilo odoslať.");
  }
}

/** Admin sa pripojí do konverzácie, ktorú potrebuje riešiť. */
export async function joinConversation(conversationId: string): Promise<ActionResult> {
  try {
    await assertSameOrigin();
    const session = await assertPermission("can_message_staff");
    if (!session.eventId) return failure("Nie je zvolený žiadny event.");

    const db = await getDb();
    const [conversation] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.id, conversationId),
          eq(conversations.eventId, session.eventId),
          isNull(conversations.deletedAt),
        ),
      )
      .limit(1);
    if (!conversation) return failure("Konverzácia sa nenašla.");

    await db
      .insert(conversationMembers)
      .values({ conversationId, userId: session.user.id, isAdmin: true })
      .onConflictDoNothing();

    revalidatePath(`/admin/messages/${conversationId}`);
    return success("Pripojil si sa do konverzácie.");
  } catch (error) {
    return toActionResult(error, "Nepodarilo sa pripojiť.");
  }
}

/** Zoznam smien pre výber publika hromadnej správy. */
export async function broadcastAudienceOptions() {
  const session = await assertPermission("can_message_staff");
  if (!session.eventId) return { positions: [], shifts: [] };

  const db = await getDb();
  const [positionRows, shiftRows] = await Promise.all([
    db
      .select({ id: positions.id, name: positions.name })
      .from(positions)
      .where(and(eq(positions.eventId, session.eventId), isNull(positions.deletedAt))),
    db
      .select({
        id: shifts.id,
        startsAt: shifts.startsAt,
        positionName: positions.name,
      })
      .from(shifts)
      .innerJoin(positions, eq(positions.id, shifts.positionId))
      .where(and(eq(shifts.eventId, session.eventId), isNull(shifts.deletedAt)))
      .limit(100),
  ]);

  return {
    positions: positionRows,
    shifts: shiftRows.map((row) => ({
      id: row.id,
      label: `${row.positionName} · ${new Intl.DateTimeFormat("sk-SK", {
        day: "numeric",
        month: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(row.startsAt)}`,
    })),
  };
}
