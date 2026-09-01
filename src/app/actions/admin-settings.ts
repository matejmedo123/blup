"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getDb } from "@/db/client";
import { EVENT_STATUSES } from "@/db/enums";
import { events } from "@/db/schema";
import { failure, success, toActionResult, type ActionResult } from "@/lib/action-result";
import { assertFullAdmin, assertSameOrigin, clientIp } from "@/lib/auth/guards";
import { diffRecords, writeAudit } from "@/lib/audit";
import { fieldErrors, isoDateSchema, optionalText } from "@/lib/validation/common";

const eventSchema = z
  .object({
    name: z.string().trim().min(2, "Zadaj názov eventu.").max(120),
    description: optionalText(1000),
    location: z.string().trim().max(200).optional().or(z.literal("")),
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
    startDate: isoDateSchema,
    endDate: isoDateSchema,
    timezone: z.string().trim().min(3).max(60),
    status: z.enum(EVENT_STATUSES),
    currency: z.string().trim().length(3, "Mena má tri písmená, napríklad EUR."),
    rounding: z.enum(["exact", "5min", "15min"]),
    overtimeAfterHours: z.coerce.number().min(4).max(24),
    overtimeMultiplier: z.coerce.number().min(1).max(3),
    defaultGeofenceRadiusM: z.coerce.number().int().min(20).max(5000),
    reminderHoursBefore: z.coerce.number().int().min(1).max(168),
  })
  .refine((v) => v.endDate >= v.startDate, {
    message: "Koniec eventu nemôže byť pred začiatkom.",
    path: ["endDate"],
  });

export async function updateEventSettings(payload: unknown): Promise<ActionResult> {
  try {
    await assertSameOrigin();
    const session = await assertFullAdmin();
    if (!session.eventId) return failure("Nie je zvolený žiadny event.");
    const eventId = session.eventId;

    const parsed = eventSchema.safeParse(payload);
    if (!parsed.success) return failure("Skontroluj nastavenia.", fieldErrors(parsed.error));
    const input = parsed.data;

    // Neznáme časové pásmo by rozbilo všetky výpočty času.
    try {
      new Intl.DateTimeFormat("sk-SK", { timeZone: input.timezone });
    } catch {
      return failure("Neznáme časové pásmo.", { timezone: ["Skús napríklad Europe/Bratislava."] });
    }

    const db = await getDb();
    const [before] = await db.select().from(events).where(eq(events.id, eventId)).limit(1);
    if (!before) return failure("Event sa nenašiel.");

    const settings = {
      currency: input.currency.toUpperCase(),
      rounding: input.rounding,
      overtime_after_hours: input.overtimeAfterHours,
      overtime_multiplier: input.overtimeMultiplier,
      default_geofence_radius_m: input.defaultGeofenceRadiusM,
      reminder_hours_before: input.reminderHoursBefore,
    };

    await db
      .update(events)
      .set({
        name: input.name,
        description: input.description ?? null,
        location: input.location || null,
        lat: input.lat != null ? String(input.lat) : null,
        lng: input.lng != null ? String(input.lng) : null,
        startDate: input.startDate,
        endDate: input.endDate,
        timezone: input.timezone,
        status: input.status,
        settings,
        updatedAt: new Date(),
      })
      .where(eq(events.id, eventId));

    const diff = diffRecords(
      {
        name: before.name,
        startDate: before.startDate,
        endDate: before.endDate,
        timezone: before.timezone,
        status: before.status,
      },
      {
        name: input.name,
        startDate: input.startDate,
        endDate: input.endDate,
        timezone: input.timezone,
        status: input.status,
      },
    );

    await writeAudit({
      eventId,
      actorId: session.user.id,
      action: "event.updated",
      entity: "event",
      entityId: eventId,
      before: diff?.before ?? null,
      after: diff?.after ?? { settings },
      ip: await clientIp(),
    });

    revalidatePath("/admin/settings");
    revalidatePath("/admin");
    return success("Nastavenia eventu sú uložené.");
  } catch (error) {
    return toActionResult(error, "Nastavenia sa nepodarilo uložiť.");
  }
}

const newEventSchema = z
  .object({
    name: z.string().trim().min(2, "Zadaj názov eventu.").max(120),
    slug: z
      .string()
      .trim()
      .regex(/^[a-z0-9-]{2,60}$/, "Adresa môže obsahovať len malé písmená, čísla a pomlčky."),
    startDate: isoDateSchema,
    endDate: isoDateSchema,
    location: z.string().trim().max(200).optional().or(z.literal("")),
    timezone: z.string().trim().min(3).max(60).default("Europe/Bratislava"),
  })
  .refine((v) => v.endDate >= v.startDate, {
    message: "Koniec eventu nemôže byť pred začiatkom.",
    path: ["endDate"],
  });

export async function createEvent(payload: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    await assertSameOrigin();
    const session = await assertFullAdmin();

    const parsed = newEventSchema.safeParse(payload);
    if (!parsed.success) return failure("Skontroluj údaje eventu.", fieldErrors(parsed.error));

    const db = await getDb();
    const [clash] = await db
      .select({ id: events.id })
      .from(events)
      .where(eq(events.slug, parsed.data.slug))
      .limit(1);
    if (clash) return failure("Event s touto adresou už existuje.", { slug: ["Adresa je obsadená."] });

    const [created] = await db
      .insert(events)
      .values({
        name: parsed.data.name,
        slug: parsed.data.slug,
        startDate: parsed.data.startDate,
        endDate: parsed.data.endDate,
        location: parsed.data.location || null,
        timezone: parsed.data.timezone,
        status: "draft",
        settings: { currency: "EUR", rounding: "5min" },
      })
      .returning({ id: events.id });

    const { eventMembers } = await import("@/db/schema");
    await db.insert(eventMembers).values({
      userId: session.user.id,
      eventId: created.id,
      role: "admin",
      permissions: {},
    });

    const { ensureScoreRules } = await import("@/lib/domain/score");
    await ensureScoreRules(created.id);

    await writeAudit({
      eventId: created.id,
      actorId: session.user.id,
      action: "event.updated",
      entity: "event",
      entityId: created.id,
      after: { name: parsed.data.name, slug: parsed.data.slug },
      ip: await clientIp(),
    });

    revalidatePath("/admin/settings");
    return success("Event je vytvorený.", { id: created.id });
  } catch (error) {
    return toActionResult(error, "Event sa nepodarilo vytvoriť.");
  }
}
