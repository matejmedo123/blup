import "server-only";

import { and, asc, eq, isNull } from "drizzle-orm";
import { cache } from "react";

import { getDb } from "@/db/client";
import { events, type Event, type EventSettings } from "@/db/schema";

export const DEFAULT_EVENT_SETTINGS: Required<EventSettings> = {
  rounding: "exact",
  overtime_after_hours: 10,
  overtime_multiplier: 1.25,
  currency: "EUR",
  default_geofence_radius_m: 150,
  reminder_hours_before: 24,
};

export function eventSettings(event: Pick<Event, "settings">): Required<EventSettings> {
  return { ...DEFAULT_EVENT_SETTINGS, ...(event.settings ?? {}) };
}

/** Event, do ktorého idú verejné prihlášky — prvý aktívny podľa dátumu začiatku. */
export const getPublicEvent = cache(async (): Promise<Event | null> => {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(events)
    .where(and(eq(events.status, "active"), isNull(events.deletedAt)))
    .orderBy(asc(events.startDate))
    .limit(1);
  return row ?? null;
});

export const getEventById = cache(async (id: string): Promise<Event | null> => {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(events)
    .where(and(eq(events.id, id), isNull(events.deletedAt)))
    .limit(1);
  return row ?? null;
});

export async function listEvents(): Promise<Event[]> {
  const db = await getDb();
  return db.select().from(events).where(isNull(events.deletedAt)).orderBy(asc(events.startDate));
}

/** Dni eventu ako ISO reťazce — používajú ich formuláre dostupnosti. */
export function eventDays(event: Pick<Event, "startDate" | "endDate">): string[] {
  const days: string[] = [];
  const start = new Date(`${event.startDate}T00:00:00Z`);
  const end = new Date(`${event.endDate}T00:00:00Z`);
  for (let d = start; d <= end; d = new Date(d.getTime() + 86400000)) {
    days.push(d.toISOString().slice(0, 10));
    if (days.length > 60) break;
  }
  return days;
}
