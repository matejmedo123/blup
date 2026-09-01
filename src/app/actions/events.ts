"use server";

import { and, eq } from "drizzle-orm";

import { getDb } from "@/db/client";
import { eventMembers, events } from "@/db/schema";
import { assertSession, assertSameOrigin } from "@/lib/auth/guards";
import { setActiveEvent } from "@/lib/auth/session";
import { isAdmin } from "@/lib/permissions";

/** Prepnutie aktívneho eventu — len na eventy, ku ktorým má actor prístup. */
export async function switchEvent(eventId: string): Promise<void> {
  await assertSameOrigin();
  const session = await assertSession();

  const db = await getDb();
  if (!isAdmin(session.actor)) {
    const [membership] = await db
      .select({ id: eventMembers.id })
      .from(eventMembers)
      .where(
        and(
          eq(eventMembers.userId, session.user.id),
          eq(eventMembers.eventId, eventId),
          eq(eventMembers.active, true),
        ),
      )
      .limit(1);
    if (!membership) return;
  } else {
    const [exists] = await db.select({ id: events.id }).from(events).where(eq(events.id, eventId)).limit(1);
    if (!exists) return;
  }

  await setActiveEvent(eventId);
}
