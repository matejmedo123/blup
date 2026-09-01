import "server-only";

import { and, asc, count, desc, eq, gte, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";

import { getDb } from "@/db/client";
import {
  attendance,
  conversationMembers,
  conversations,
  messages,
  notifications,
  positions,
  shiftAssignments,
  shifts,
  users,
} from "@/db/schema";

export type PortalShift = {
  assignmentId: string;
  shiftId: string;
  positionName: string;
  title: string | null;
  positionColor: string;
  startsAt: Date;
  endsAt: Date;
  location: string | null;
  lat: string | null;
  lng: string | null;
  rate: number;
  assignmentStatus: string;
  needsReplacement: boolean;
  checkInMethod: "manual" | "qr" | "geofence" | "qr_geofence";
  geofenceRadiusM: number;
  instructions: string | null;
  dressCode: string | null;
  showColleagues: boolean;
  coordinatorId: string | null;
  coordinatorFirstName: string | null;
  coordinatorLastName: string | null;
  attendanceId: string | null;
  attendanceStatus: string | null;
  checkInAt: Date | null;
  checkOutAt: Date | null;
  workedMinutes: number | null;
  approved: boolean | null;
  bonus: string | null;
  adjustments: string | null;
};

function portalShiftSelection() {
  return {
    assignmentId: shiftAssignments.id,
    shiftId: shifts.id,
    positionName: positions.name,
    title: shifts.title,
    positionColor: positions.color,
    startsAt: shifts.startsAt,
    endsAt: shifts.endsAt,
    location: shifts.location,
    lat: shifts.lat,
    lng: shifts.lng,
    shiftRate: shifts.hourlyRate,
    positionRate: positions.hourlyRate,
    assignmentStatus: shiftAssignments.status,
    needsReplacement: shiftAssignments.needsReplacement,
    checkInMethod: shifts.checkInMethod,
    geofenceRadiusM: shifts.geofenceRadiusM,
    instructions: shifts.instructions,
    dressCode: shifts.dressCode,
    showColleagues: shifts.showColleagues,
    coordinatorId: shifts.coordinatorId,
    coordinatorFirstName: users.firstName,
    coordinatorLastName: users.lastName,
    attendanceId: attendance.id,
    attendanceStatus: attendance.status,
    checkInAt: attendance.checkInAt,
    checkOutAt: attendance.checkOutAt,
    workedMinutes: attendance.workedMinutes,
    approved: attendance.approved,
    bonus: attendance.bonus,
    adjustments: attendance.adjustments,
  };
}

type RawRow = Awaited<ReturnType<typeof rawShifts>>[number];

async function rawShifts(userId: string, eventId: string) {
  const db = await getDb();
  return db
    .select(portalShiftSelection())
    .from(shiftAssignments)
    .innerJoin(shifts, eq(shifts.id, shiftAssignments.shiftId))
    .innerJoin(positions, eq(positions.id, shifts.positionId))
    .leftJoin(users, eq(users.id, shifts.coordinatorId))
    .leftJoin(attendance, eq(attendance.assignmentId, shiftAssignments.id))
    .where(
      and(
        eq(shiftAssignments.userId, userId),
        eq(shiftAssignments.eventId, eventId),
        ne(shiftAssignments.status, "cancelled"),
        isNull(shifts.deletedAt),
        ne(shifts.status, "draft"),
      ),
    )
    .orderBy(asc(shifts.startsAt));
}

function toPortalShift(row: RawRow): PortalShift {
  return {
    ...row,
    rate: Number(row.shiftRate ?? row.positionRate) || 0,
  };
}

/** Všetky smeny pracovníka rozdelené podľa stavu (§9). */
export async function portalShifts(userId: string, eventId: string) {
  const rows = (await rawShifts(userId, eventId)).map(toPortalShift);
  const now = Date.now();

  const active = rows.filter((row) => row.checkInAt && !row.checkOutAt);
  const completed = rows.filter(
    (row) => row.checkOutAt || (row.endsAt.getTime() < now && !row.checkInAt),
  );
  const upcoming = rows.filter(
    (row) => !active.includes(row) && !completed.includes(row) && row.endsAt.getTime() >= now,
  );

  return { all: rows, active, upcoming, completed };
}

export async function portalShift(
  userId: string,
  eventId: string,
  shiftId: string,
): Promise<PortalShift | null> {
  const rows = await rawShifts(userId, eventId);
  const row = rows.find((r) => r.shiftId === shiftId);
  return row ? toPortalShift(row) : null;
}

/** Kolegovia na tej istej smene — len ak to smena povoľuje. */
export async function shiftColleagues(shiftId: string, excludeUserId: string) {
  const db = await getDb();
  return db
    .select({
      userId: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
      avatarUrl: users.avatarUrl,
      status: shiftAssignments.status,
    })
    .from(shiftAssignments)
    .innerJoin(users, eq(users.id, shiftAssignments.userId))
    .where(
      and(
        eq(shiftAssignments.shiftId, shiftId),
        ne(shiftAssignments.userId, excludeUserId),
        inArray(shiftAssignments.status, ["confirmed", "pending_confirmation", "completed"]),
      ),
    )
    .orderBy(asc(users.firstName));
}

export async function unreadCounts(userId: string) {
  const db = await getDb();

  const [[notificationRow], [messageRow]] = await Promise.all([
    db
      .select({ value: count() })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt))),
    db
      .select({ value: count() })
      .from(messages)
      .innerJoin(conversationMembers, eq(conversationMembers.conversationId, messages.conversationId))
      .where(
        and(
          eq(conversationMembers.userId, userId),
          isNull(messages.deletedAt),
          ne(messages.senderId, userId),
          or(
            isNull(conversationMembers.lastReadAt),
            sql`${messages.createdAt} > ${conversationMembers.lastReadAt}`,
          ),
        ),
      ),
  ]);

  return {
    notifications: Number(notificationRow?.value ?? 0),
    messages: Number(messageRow?.value ?? 0),
  };
}

export async function portalNotifications(userId: string, limit = 50) {
  const db = await getDb();
  return db
    .select()
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.createdAt))
    .limit(limit);
}

/** Smeny, ktoré začínajú do 24 h a čakajú na potvrdenie (§18). */
export async function shiftsAwaitingConfirmation(userId: string, eventId: string) {
  const db = await getDb();
  const now = new Date();
  const until = new Date(now.getTime() + 36 * 3_600_000);

  return db
    .select({
      assignmentId: shiftAssignments.id,
      shiftId: shifts.id,
      positionName: positions.name,
      startsAt: shifts.startsAt,
      endsAt: shifts.endsAt,
      location: shifts.location,
    })
    .from(shiftAssignments)
    .innerJoin(shifts, eq(shifts.id, shiftAssignments.shiftId))
    .innerJoin(positions, eq(positions.id, shifts.positionId))
    .where(
      and(
        eq(shiftAssignments.userId, userId),
        eq(shiftAssignments.eventId, eventId),
        inArray(shiftAssignments.status, ["invited", "pending_confirmation"]),
        gte(shifts.startsAt, now),
        lt(shifts.startsAt, until),
        isNull(shifts.deletedAt),
      ),
    )
    .orderBy(asc(shifts.startsAt));
}

/** Konverzácie pracovníka s náhľadom poslednej správy a počtom neprečítaných. */
export async function portalConversations(userId: string, eventId: string) {
  const db = await getDb();

  const rows = await db
    .select({
      id: conversations.id,
      type: conversations.type,
      title: conversations.title,
      shiftId: conversations.shiftId,
      lastMessageAt: conversations.lastMessageAt,
      lastReadAt: conversationMembers.lastReadAt,
      memberCount: sql<number>`(
        select count(*)::int from ${conversationMembers} cm where cm.conversation_id = ${conversations.id}
      )`,
      unread: sql<number>`(
        select count(*)::int from ${messages} m
        where m.conversation_id = ${conversations.id}
          and m.deleted_at is null
          and (m.sender_id is null or m.sender_id <> ${userId})
          and (${conversationMembers.lastReadAt} is null or m.created_at > ${conversationMembers.lastReadAt})
      )`,
    })
    .from(conversationMembers)
    .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
    .where(
      and(
        eq(conversationMembers.userId, userId),
        eq(conversations.eventId, eventId),
        isNull(conversations.deletedAt),
      ),
    )
    .orderBy(desc(conversations.lastMessageAt), desc(conversations.createdAt));

  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const previews = await db
    .select({
      conversationId: messages.conversationId,
      body: messages.body,
      createdAt: messages.createdAt,
      senderId: messages.senderId,
      senderFirstName: users.firstName,
    })
    .from(messages)
    .leftJoin(users, eq(users.id, messages.senderId))
    .where(and(inArray(messages.conversationId, ids), isNull(messages.deletedAt)))
    .orderBy(desc(messages.createdAt));

  const previewByConversation = new Map<string, (typeof previews)[number]>();
  for (const preview of previews) {
    if (!previewByConversation.has(preview.conversationId)) {
      previewByConversation.set(preview.conversationId, preview);
    }
  }

  // Priame konverzácie nemajú názov — poskladáme ho z mien ostatných členov.
  const directIds = rows.filter((r) => r.type === "direct").map((r) => r.id);
  const counterparts =
    directIds.length > 0
      ? await db
          .select({
            conversationId: conversationMembers.conversationId,
            firstName: users.firstName,
            lastName: users.lastName,
          })
          .from(conversationMembers)
          .innerJoin(users, eq(users.id, conversationMembers.userId))
          .where(
            and(
              inArray(conversationMembers.conversationId, directIds),
              ne(conversationMembers.userId, userId),
            ),
          )
      : [];
  const nameByConversation = new Map<string, string>();
  for (const row of counterparts) {
    if (!nameByConversation.has(row.conversationId)) {
      nameByConversation.set(row.conversationId, `${row.firstName} ${row.lastName}`);
    }
  }

  return rows.map((row) => {
    const preview = previewByConversation.get(row.id);
    return {
      id: row.id,
      type: row.type,
      title: row.title ?? nameByConversation.get(row.id) ?? "Konverzácia",
      shiftId: row.shiftId,
      memberCount: Number(row.memberCount),
      unread: Number(row.unread),
      lastMessageAt: row.lastMessageAt,
      preview: preview
        ? {
            body: preview.body,
            createdAt: preview.createdAt,
            senderName: preview.senderFirstName ?? "CREW.",
            isOwn: preview.senderId === userId,
          }
        : null,
    };
  });
}
