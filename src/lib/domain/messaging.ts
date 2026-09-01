import "server-only";

import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import { getDb } from "@/db/client";
import type { ConversationType } from "@/db/enums";
import {
  conversationMembers,
  conversations,
  messages,
  positions,
  shiftAssignments,
  shifts,
  users,
} from "@/db/schema";
import { DomainError } from "@/lib/action-result";
import { channels, realtime } from "@/lib/realtime";

import { notify } from "./notifications";

/**
 * Prístup ku konverzácii je vždy cez členstvo (Rule 8).
 * Ani admin nečíta konverzáciu, ktorej nie je členom.
 */
export async function requireConversationMember(conversationId: string, userId: string) {
  const db = await getDb();
  const [row] = await db
    .select({
      conversationId: conversations.id,
      eventId: conversations.eventId,
      type: conversations.type,
      title: conversations.title,
      shiftId: conversations.shiftId,
      canWrite: conversationMembers.canWrite,
      isAdmin: conversationMembers.isAdmin,
      lastReadAt: conversationMembers.lastReadAt,
    })
    .from(conversationMembers)
    .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.userId, userId),
        isNull(conversations.deletedAt),
      ),
    )
    .limit(1);

  if (!row) throw new DomainError("Do tejto konverzácie nemáš prístup.");
  return row;
}

export async function conversationMessages(conversationId: string, limit = 100) {
  const db = await getDb();
  const rows = await db
    .select({
      id: messages.id,
      body: messages.body,
      kind: messages.kind,
      createdAt: messages.createdAt,
      editedAt: messages.editedAt,
      senderId: messages.senderId,
      senderFirstName: users.firstName,
      senderLastName: users.lastName,
      senderAvatar: users.avatarUrl,
    })
    .from(messages)
    .leftJoin(users, eq(users.id, messages.senderId))
    .where(and(eq(messages.conversationId, conversationId), isNull(messages.deletedAt)))
    .orderBy(desc(messages.createdAt))
    .limit(limit);

  return rows.reverse();
}

export async function conversationMemberList(conversationId: string) {
  const db = await getDb();
  return db
    .select({
      userId: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
      avatarUrl: users.avatarUrl,
      isAdmin: conversationMembers.isAdmin,
    })
    .from(conversationMembers)
    .innerJoin(users, eq(users.id, conversationMembers.userId))
    .where(eq(conversationMembers.conversationId, conversationId))
    .orderBy(asc(users.firstName));
}

export async function markConversationRead(conversationId: string, userId: string) {
  const db = await getDb();
  await db
    .update(conversationMembers)
    .set({ lastReadAt: new Date() })
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.userId, userId),
      ),
    );
}

export type SendMessageArgs = {
  conversationId: string;
  senderId: string | null;
  body: string;
  kind?: "text" | "system";
  eventId: string;
  /** Meno odosielateľa do e-mailovej notifikácie. */
  senderName?: string;
};

export async function sendMessage(args: SendMessageArgs): Promise<string> {
  const db = await getDb();

  const [created] = await db
    .insert(messages)
    .values({
      conversationId: args.conversationId,
      senderId: args.senderId,
      body: args.body,
      kind: args.kind ?? "text",
    })
    .returning({ id: messages.id, createdAt: messages.createdAt });

  await db
    .update(conversations)
    .set({ lastMessageAt: created.createdAt, updatedAt: new Date() })
    .where(eq(conversations.id, args.conversationId));

  realtime.publish([channels.conversation(args.conversationId)], {
    type: "message",
    conversationId: args.conversationId,
    messageId: created.id,
    senderId: args.senderId,
  });

  // Notifikáciu dostanú všetci členovia okrem odosielateľa.
  const recipients = await db
    .select({ userId: conversationMembers.userId, muted: conversationMembers.muted })
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.conversationId, args.conversationId),
        args.senderId ? ne(conversationMembers.userId, args.senderId) : sql`true`,
      ),
    );

  const preview = args.body.length > 90 ? `${args.body.slice(0, 90)}…` : args.body;

  for (const recipient of recipients) {
    if (recipient.muted) continue;
    await notify({
      userId: recipient.userId,
      eventId: args.eventId,
      type: "message_received",
      title: args.senderName ? `Nová správa od ${args.senderName}` : "Nová správa",
      body: preview,
      actionUrl: `/portal/messages/${args.conversationId}`,
      entityType: "conversation",
      entityId: args.conversationId,
    });
  }

  return created.id;
}

/** Konverzácia k smene — členmi sú pridelení ľudia a koordinátor (§20). */
export async function ensureShiftConversation(
  shiftId: string,
  tx?: Database,
): Promise<string | null> {
  const db = tx ?? (await getDb());

  const [shift] = await db
    .select({
      id: shifts.id,
      eventId: shifts.eventId,
      startsAt: shifts.startsAt,
      coordinatorId: shifts.coordinatorId,
      positionName: positions.name,
      title: shifts.title,
    })
    .from(shifts)
    .innerJoin(positions, eq(positions.id, shifts.positionId))
    .where(and(eq(shifts.id, shiftId), isNull(shifts.deletedAt)))
    .limit(1);
  if (!shift) return null;

  const [existing] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.shiftId, shiftId),
        eq(conversations.type, "shift"),
        isNull(conversations.deletedAt),
      ),
    )
    .limit(1);

  const dayLabel = new Intl.DateTimeFormat("sk-SK", {
    weekday: "long",
    timeZone: "Europe/Bratislava",
  }).format(shift.startsAt);
  const title = `${(shift.title ?? shift.positionName).toUpperCase()} · ${dayLabel}`;

  const conversationId =
    existing?.id ??
    (
      await db
        .insert(conversations)
        .values({
          eventId: shift.eventId,
          type: "shift",
          title,
          shiftId,
          createdBy: shift.coordinatorId,
        })
        .returning({ id: conversations.id })
    )[0].id;

  const assignees = await db
    .select({ userId: shiftAssignments.userId })
    .from(shiftAssignments)
    .where(
      and(
        eq(shiftAssignments.shiftId, shiftId),
        inArray(shiftAssignments.status, ["invited", "pending_confirmation", "confirmed", "completed"]),
      ),
    );

  const memberIds = new Set(assignees.map((a) => a.userId));
  if (shift.coordinatorId) memberIds.add(shift.coordinatorId);
  if (memberIds.size === 0) return conversationId;

  const current = await db
    .select({ userId: conversationMembers.userId })
    .from(conversationMembers)
    .where(eq(conversationMembers.conversationId, conversationId));
  const currentIds = new Set(current.map((c) => c.userId));

  const missing = [...memberIds].filter((id) => !currentIds.has(id));
  if (missing.length > 0) {
    await db.insert(conversationMembers).values(
      missing.map((userId) => ({
        conversationId,
        userId,
        isAdmin: userId === shift.coordinatorId,
      })),
    );
  }

  return conversationId;
}

/** Hromadná správa — vytvorí broadcast konverzáciu s vybraným publikom. */
export async function createBroadcast(args: {
  eventId: string;
  createdBy: string;
  title: string;
  body: string;
  recipientIds: string[];
  senderName: string;
}): Promise<{ conversationId: string; recipients: number }> {
  if (args.recipientIds.length === 0) {
    throw new DomainError("Vyber aspoň jedného príjemcu.");
  }

  const db = await getDb();
  const [conversation] = await db
    .insert(conversations)
    .values({
      eventId: args.eventId,
      type: "broadcast",
      title: args.title,
      createdBy: args.createdBy,
    })
    .returning({ id: conversations.id });

  const memberIds = new Set(args.recipientIds);
  memberIds.add(args.createdBy);

  await db.insert(conversationMembers).values(
    [...memberIds].map((userId) => ({
      conversationId: conversation.id,
      userId,
      isAdmin: userId === args.createdBy,
      // Broadcast je jednosmerný — odpovedať môže len odosielateľ.
      canWrite: userId === args.createdBy,
    })),
  );

  await sendMessage({
    conversationId: conversation.id,
    senderId: args.createdBy,
    body: args.body,
    eventId: args.eventId,
    senderName: args.senderName,
  });

  return { conversationId: conversation.id, recipients: args.recipientIds.length };
}

export async function adminConversations(eventId: string, query?: string) {
  const db = await getDb();
  const rows = await db
    .select({
      id: conversations.id,
      type: conversations.type,
      title: conversations.title,
      shiftId: conversations.shiftId,
      lastMessageAt: conversations.lastMessageAt,
      createdAt: conversations.createdAt,
      memberCount: sql<number>`(
        select count(*)::int from ${conversationMembers} cm where cm.conversation_id = ${conversations.id}
      )`,
      messageCount: sql<number>`(
        select count(*)::int from ${messages} m
        where m.conversation_id = ${conversations.id} and m.deleted_at is null
      )`,
    })
    .from(conversations)
    .where(and(eq(conversations.eventId, eventId), isNull(conversations.deletedAt)))
    .orderBy(desc(conversations.lastMessageAt), desc(conversations.createdAt))
    .limit(100);

  if (!query) return rows;
  const q = query.toLowerCase();
  return rows.filter((row) => (row.title ?? "").toLowerCase().includes(q));
}

export type ConversationTypeLabel = Record<ConversationType, string>;

export const CONVERSATION_TYPE_LABELS: ConversationTypeLabel = {
  direct: "Priama správa",
  shift: "Chat k smene",
  group: "Skupina",
  broadcast: "Hromadná správa",
  system: "Systémové",
};
