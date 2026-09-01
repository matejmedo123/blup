import "server-only";

import { and, eq, isNull } from "drizzle-orm";

import type { Database } from "@/db/client";
import { getDb } from "@/db/client";
import type { NotificationType } from "@/db/enums";
import { notifications, users } from "@/db/schema";
import { sendEmailSafely, type EmailMessage } from "@/lib/email/provider";
import { channels, realtime } from "@/lib/realtime";

export type NotificationInput = {
  userId: string;
  eventId?: string | null;
  type: NotificationType;
  title: string;
  body?: string | null;
  actionUrl?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  requiresAction?: boolean;
};

/**
 * Vytvorí notifikáciu, publikuje ju do realtime kanála a voliteľne pošle e-mail.
 * E-mail je best-effort — nikdy nezhodí biznis operáciu (Rule: notifikácia
 * nesmie zablokovať pridelenie smeny).
 */
export async function notify(
  input: NotificationInput,
  options?: { email?: EmailMessage; tx?: Database },
): Promise<string> {
  const db = options?.tx ?? (await getDb());
  const [row] = await db
    .insert(notifications)
    .values({
      userId: input.userId,
      eventId: input.eventId ?? null,
      type: input.type,
      title: input.title,
      body: input.body ?? null,
      actionUrl: input.actionUrl ?? null,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      requiresAction: input.requiresAction ?? false,
    })
    .returning({ id: notifications.id });

  realtime.publish([channels.user(input.userId)], {
    type: "notification",
    userId: input.userId,
    notificationId: row.id,
  });

  if (options?.email) void sendEmailSafely(options.email);
  return row.id;
}

export async function notifyMany(
  inputs: NotificationInput[],
  options?: { tx?: Database },
): Promise<void> {
  if (inputs.length === 0) return;
  const db = options?.tx ?? (await getDb());
  const rows = await db
    .insert(notifications)
    .values(
      inputs.map((input) => ({
        userId: input.userId,
        eventId: input.eventId ?? null,
        type: input.type,
        title: input.title,
        body: input.body ?? null,
        actionUrl: input.actionUrl ?? null,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        requiresAction: input.requiresAction ?? false,
      })),
    )
    .returning({ id: notifications.id, userId: notifications.userId });

  for (const row of rows) {
    realtime.publish([channels.user(row.userId)], {
      type: "notification",
      userId: row.userId,
      notificationId: row.id,
    });
  }
}

export async function unreadNotificationCount(userId: string): Promise<number> {
  const db = await getDb();
  const rows = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
  return rows.length;
}

export async function markNotificationsRead(userId: string, ids?: string[]): Promise<void> {
  const db = await getDb();
  const base = and(eq(notifications.userId, userId), isNull(notifications.readAt));
  if (ids && ids.length > 0) {
    for (const id of ids) {
      await db
        .update(notifications)
        .set({ readAt: new Date() })
        .where(and(base, eq(notifications.id, id)));
    }
    return;
  }
  await db.update(notifications).set({ readAt: new Date() }).where(base);
}

/** Kontaktné údaje príjemcu pre e-mailové notifikácie. */
export async function recipientContact(userId: string) {
  const db = await getDb();
  const [row] = await db
    .select({
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row ?? null;
}
