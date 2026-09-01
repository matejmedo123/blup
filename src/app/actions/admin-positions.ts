"use server";

import { and, eq, isNull, ne } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { getDb } from "@/db/client";
import { positions, shifts } from "@/db/schema";
import { failure, success, toActionResult, type ActionResult } from "@/lib/action-result";
import { assertPermission, assertSameOrigin, clientIp } from "@/lib/auth/guards";
import { diffRecords, writeAudit } from "@/lib/audit";
import { fieldErrors, uuidSchema } from "@/lib/validation/common";
import { positionSchema } from "@/lib/validation/scheduling";

function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

export async function savePosition(payload: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    await assertSameOrigin();
    const session = await assertPermission("can_manage_shifts");
    if (!session.eventId) return failure("Nie je zvolený žiadny event.");

    const parsed = positionSchema.safeParse(payload);
    if (!parsed.success) return failure("Skontroluj vyplnené údaje.", fieldErrors(parsed.error));
    const input = parsed.data;

    const db = await getDb();
    const baseSlug = slugify(input.name) || "pozicia";

    // Slug musí byť v rámci eventu unikátny — doplníme príponu, ak koliduje.
    let slug = baseSlug;
    for (let i = 2; i < 50; i += 1) {
      const conditions = [eq(positions.eventId, session.eventId), eq(positions.slug, slug)];
      if (input.id) conditions.push(ne(positions.id, input.id));
      const [clash] = await db
        .select({ id: positions.id })
        .from(positions)
        .where(and(...conditions))
        .limit(1);
      if (!clash) break;
      slug = `${baseSlug}-${i}`;
    }

    const values = {
      name: input.name,
      slug,
      description: input.description ?? null,
      hourlyRate: input.hourlyRate.toFixed(2),
      capacity: input.capacity,
      color: input.color,
      requiredSkills: input.requiredSkills,
      active: input.active,
      updatedAt: new Date(),
    };

    const ip = await clientIp();

    if (input.id) {
      const [before] = await db
        .select()
        .from(positions)
        .where(and(eq(positions.id, input.id), eq(positions.eventId, session.eventId)))
        .limit(1);
      if (!before) return failure("Pozícia sa nenašla.");

      await db.update(positions).set(values).where(eq(positions.id, input.id));

      const diff = diffRecords(
        {
          name: before.name,
          hourlyRate: before.hourlyRate,
          capacity: before.capacity,
          active: before.active,
        },
        {
          name: values.name,
          hourlyRate: values.hourlyRate,
          capacity: values.capacity,
          active: values.active,
        },
      );
      if (diff) {
        await writeAudit({
          eventId: session.eventId,
          actorId: session.user.id,
          action: before.hourlyRate !== values.hourlyRate ? "rate.changed" : "position.updated",
          entity: "position",
          entityId: input.id,
          before: diff.before,
          after: diff.after,
          ip,
        });
      }

      revalidatePath("/admin/positions");
      return success("Pozícia je uložená.", { id: input.id });
    }

    const [created] = await db
      .insert(positions)
      .values({ ...values, eventId: session.eventId })
      .returning({ id: positions.id });

    await writeAudit({
      eventId: session.eventId,
      actorId: session.user.id,
      action: "position.created",
      entity: "position",
      entityId: created.id,
      after: { name: values.name, hourlyRate: values.hourlyRate },
      ip,
    });

    revalidatePath("/admin/positions");
    return success("Pozícia je vytvorená.", { id: created.id });
  } catch (error) {
    return toActionResult(error, "Pozíciu sa nepodarilo uložiť.");
  }
}

/** Mäkké mazanie — pozícia so smenami ostáva, len sa deaktivuje. */
export async function deletePosition(payload: unknown): Promise<ActionResult> {
  try {
    await assertSameOrigin();
    const session = await assertPermission("can_manage_shifts");
    if (!session.eventId) return failure("Nie je zvolený žiadny event.");

    const parsed = uuidSchema.safeParse(payload);
    if (!parsed.success) return failure("Neplatná pozícia.");

    const db = await getDb();
    const [position] = await db
      .select()
      .from(positions)
      .where(and(eq(positions.id, parsed.data), eq(positions.eventId, session.eventId)))
      .limit(1);
    if (!position) return failure("Pozícia sa nenašla.");

    const [usage] = await db
      .select({ id: shifts.id })
      .from(shifts)
      .where(and(eq(shifts.positionId, parsed.data), isNull(shifts.deletedAt)))
      .limit(1);

    if (usage) {
      await db
        .update(positions)
        .set({ active: false, updatedAt: new Date() })
        .where(eq(positions.id, parsed.data));
      revalidatePath("/admin/positions");
      return success("Pozícia má naviazané smeny, preto sme ju len deaktivovali.");
    }

    await db
      .update(positions)
      .set({ deletedAt: new Date(), active: false, updatedAt: new Date() })
      .where(eq(positions.id, parsed.data));

    await writeAudit({
      eventId: session.eventId,
      actorId: session.user.id,
      action: "position.deleted",
      entity: "position",
      entityId: parsed.data,
      before: { name: position.name },
      ip: await clientIp(),
    });

    revalidatePath("/admin/positions");
    return success("Pozícia je odstránená.");
  } catch (error) {
    return toActionResult(error, "Pozíciu sa nepodarilo odstrániť.");
  }
}
