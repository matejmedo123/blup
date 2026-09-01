import "server-only";

import { and, asc, eq, isNull } from "drizzle-orm";

import { getDb } from "@/db/client";
import { eventMembers, events, type Event } from "@/db/schema";
import { requireAdminAccess } from "@/lib/auth/guards";
import type { SessionContext } from "@/lib/auth/session";
import { isAdmin } from "@/lib/permissions";

export type AdminContext = SessionContext & {
  event: Event;
  eventId: string;
  events: { id: string; name: string }[];
};

/**
 * Kontext pre admin stránky: overí prístup, načíta aktívny event
 * a zoznam eventov, medzi ktorými môže actor prepínať.
 */
export async function getAdminContext(): Promise<AdminContext | null> {
  const session = await requireAdminAccess();
  const db = await getDb();

  const available = isAdmin(session.actor)
    ? await db
        .select({ id: events.id, name: events.name })
        .from(events)
        .where(isNull(events.deletedAt))
        .orderBy(asc(events.startDate))
    : await db
        .select({ id: events.id, name: events.name })
        .from(events)
        .innerJoin(eventMembers, eq(eventMembers.eventId, events.id))
        .where(
          and(
            eq(eventMembers.userId, session.user.id),
            eq(eventMembers.active, true),
            isNull(events.deletedAt),
          ),
        )
        .orderBy(asc(events.startDate));

  const eventId = session.eventId ?? available[0]?.id ?? null;
  if (!eventId) return null;

  const [event] = await db.select().from(events).where(eq(events.id, eventId)).limit(1);
  if (!event) return null;

  return { ...session, event, eventId, events: available };
}
