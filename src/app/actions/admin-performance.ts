"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getDb } from "@/db/client";
import { INCIDENT_CATEGORIES, INCIDENT_SEVERITIES } from "@/db/enums";
import { incidents, ratings, scoreRules, shifts } from "@/db/schema";
import { failure, success, toActionResult, type ActionResult } from "@/lib/action-result";
import {
  assertFullAdmin,
  assertPermission,
  assertSameOrigin,
  clientIp,
} from "@/lib/auth/guards";
import { writeAudit } from "@/lib/audit";
import { notify } from "@/lib/domain/notifications";
import { applyScoreRule, ensureScoreRules } from "@/lib/domain/score";
import { fieldErrors, uuidSchema } from "@/lib/validation/common";

const ratingScore = z.coerce.number().int().min(1, "Vyber 1 až 5.").max(5);

const ratingSchema = z.object({
  staffId: uuidSchema,
  shiftId: uuidSchema.optional().or(z.literal("")),
  reliability: ratingScore,
  punctuality: ratingScore,
  workEthic: ratingScore,
  communication: ratingScore,
  quality: ratingScore,
  note: z.string().trim().max(1000).optional(),
});

/** Hodnotenie pracovníka po smene (§22). Pozitívne hodnotenie dvíha skóre. */
export async function rateStaff(payload: unknown): Promise<ActionResult> {
  try {
    await assertSameOrigin();
    const session = await assertPermission("can_rate_staff");
    if (!session.eventId) return failure("Nie je zvolený žiadny event.");
    const eventId = session.eventId;

    const parsed = ratingSchema.safeParse(payload);
    if (!parsed.success) return failure("Skontroluj hodnotenie.", fieldErrors(parsed.error));
    const input = parsed.data;

    if (input.staffId === session.user.id) return failure("Sám seba hodnotiť nemôžeš.");

    const db = await getDb();
    if (input.shiftId) {
      const [shift] = await db
        .select({ id: shifts.id })
        .from(shifts)
        .where(and(eq(shifts.id, input.shiftId), eq(shifts.eventId, eventId)))
        .limit(1);
      if (!shift) return failure("Smena nepatrí do tohto eventu.");
    }

    const overall =
      (input.reliability +
        input.punctuality +
        input.workEthic +
        input.communication +
        input.quality) /
      5;

    const [existing] = await db
      .select({ id: ratings.id })
      .from(ratings)
      .where(
        and(
          eq(ratings.staffId, input.staffId),
          eq(ratings.raterId, session.user.id),
          input.shiftId ? eq(ratings.shiftId, input.shiftId) : eq(ratings.eventId, eventId),
        ),
      )
      .limit(1);

    const values = {
      eventId,
      staffId: input.staffId,
      raterId: session.user.id,
      shiftId: input.shiftId || null,
      reliability: input.reliability,
      punctuality: input.punctuality,
      workEthic: input.workEthic,
      communication: input.communication,
      quality: input.quality,
      overall: overall.toFixed(2),
      note: input.note ?? null,
    };

    if (existing) {
      await db.update(ratings).set(values).where(eq(ratings.id, existing.id));
    } else {
      await db.insert(ratings).values(values);
      if (overall >= 4) {
        await applyScoreRule({
          userId: input.staffId,
          eventId,
          ruleKey: "positive_rating",
          reason: `Pozitívne hodnotenie (${overall.toFixed(1)}/5)`,
          entityType: "rating",
          actorId: session.user.id,
        });
      }
    }

    await writeAudit({
      eventId,
      actorId: session.user.id,
      action: "rating.created",
      entity: "user",
      entityId: input.staffId,
      after: { overall: overall.toFixed(2), shiftId: input.shiftId || null },
      ip: await clientIp(),
    });

    await notify({
      userId: input.staffId,
      eventId,
      type: "rating_received",
      title: "Máš nové hodnotenie",
      body: `Celkovo ${overall.toFixed(1)} z 5.`,
      actionUrl: "/portal/profile",
      entityType: "rating",
    });

    revalidatePath("/admin/ratings");
    revalidatePath(`/admin/staff/${input.staffId}`);
    return success("Hodnotenie je uložené.");
  } catch (error) {
    return toActionResult(error, "Hodnotenie sa nepodarilo uložiť.");
  }
}

/* ------------------------------------------------------------- incidenty */

const incidentSchema = z.object({
  staffId: uuidSchema.optional().or(z.literal("")),
  shiftId: uuidSchema.optional().or(z.literal("")),
  severity: z.enum(INCIDENT_SEVERITIES),
  category: z.enum(INCIDENT_CATEGORIES),
  description: z.string().trim().min(5, "Popíš, čo sa stalo.").max(2000),
});

export async function createIncident(payload: unknown): Promise<ActionResult> {
  try {
    await assertSameOrigin();
    const session = await assertPermission("can_rate_staff");
    if (!session.eventId) return failure("Nie je zvolený žiadny event.");
    const eventId = session.eventId;

    const parsed = incidentSchema.safeParse(payload);
    if (!parsed.success) return failure("Skontroluj incident.", fieldErrors(parsed.error));
    const input = parsed.data;

    const db = await getDb();
    const [created] = await db
      .insert(incidents)
      .values({
        eventId,
        staffId: input.staffId || null,
        shiftId: input.shiftId || null,
        severity: input.severity,
        category: input.category,
        description: input.description,
        createdBy: session.user.id,
      })
      .returning({ id: incidents.id });

    // Vážny incident sa premietne do Crew Score.
    if (input.staffId && (input.severity === "high" || input.severity === "critical")) {
      await applyScoreRule({
        userId: input.staffId,
        eventId,
        ruleKey: "incident_high",
        reason: `Incident: ${input.description.slice(0, 80)}`,
        entityType: "incident",
        entityId: created.id,
        actorId: session.user.id,
      });
    }

    await writeAudit({
      eventId,
      actorId: session.user.id,
      action: "incident.created",
      entity: "incident",
      entityId: created.id,
      after: { severity: input.severity, category: input.category, staffId: input.staffId || null },
      ip: await clientIp(),
    });

    revalidatePath("/admin/incidents");
    revalidatePath("/admin");
    return success("Incident je zaznamenaný.");
  } catch (error) {
    return toActionResult(error, "Incident sa nepodarilo uložiť.");
  }
}

const resolveSchema = z.object({
  incidentId: uuidSchema,
  resolution: z.string().trim().min(3, "Napíš, ako sa to vyriešilo.").max(1000),
});

export async function resolveIncident(payload: unknown): Promise<ActionResult> {
  try {
    await assertSameOrigin();
    const session = await assertPermission("can_rate_staff");
    if (!session.eventId) return failure("Nie je zvolený žiadny event.");

    const parsed = resolveSchema.safeParse(payload);
    if (!parsed.success) return failure("Skontroluj riešenie.", fieldErrors(parsed.error));

    const db = await getDb();
    const [incident] = await db
      .select({ id: incidents.id, resolvedAt: incidents.resolvedAt })
      .from(incidents)
      .where(
        and(eq(incidents.id, parsed.data.incidentId), eq(incidents.eventId, session.eventId)),
      )
      .limit(1);
    if (!incident) return failure("Incident sa nenašiel.");
    if (incident.resolvedAt) return failure("Tento incident je už vyriešený.");

    await db
      .update(incidents)
      .set({
        resolvedAt: new Date(),
        resolvedBy: session.user.id,
        resolution: parsed.data.resolution,
        updatedAt: new Date(),
      })
      .where(eq(incidents.id, parsed.data.incidentId));

    await writeAudit({
      eventId: session.eventId,
      actorId: session.user.id,
      action: "incident.resolved",
      entity: "incident",
      entityId: parsed.data.incidentId,
      after: { resolution: parsed.data.resolution },
      ip: await clientIp(),
    });

    revalidatePath("/admin/incidents");
    revalidatePath("/admin");
    return success("Incident je vyriešený.");
  } catch (error) {
    return toActionResult(error, "Incident sa nepodarilo uzavrieť.");
  }
}

/* ---------------------------------------------------------- pravidlá skóre */

const scoreRulesSchema = z.object({
  rules: z
    .array(
      z.object({
        key: z.string().trim().min(1).max(60),
        label: z.string().trim().min(1).max(120),
        delta: z.coerce.number().int().min(-100).max(100),
        active: z.boolean(),
      }),
    )
    .max(30),
});

export async function saveScoreRules(payload: unknown): Promise<ActionResult> {
  try {
    await assertSameOrigin();
    const session = await assertFullAdmin();
    if (!session.eventId) return failure("Nie je zvolený žiadny event.");
    const eventId = session.eventId;

    const parsed = scoreRulesSchema.safeParse(payload);
    if (!parsed.success) return failure("Skontroluj pravidlá.", fieldErrors(parsed.error));

    const db = await getDb();
    await ensureScoreRules(eventId);

    for (const rule of parsed.data.rules) {
      const [existing] = await db
        .select({ id: scoreRules.id, delta: scoreRules.delta, active: scoreRules.active })
        .from(scoreRules)
        .where(and(eq(scoreRules.eventId, eventId), eq(scoreRules.key, rule.key)))
        .limit(1);

      if (existing) {
        if (existing.delta === rule.delta && existing.active === rule.active) continue;
        await db
          .update(scoreRules)
          .set({ label: rule.label, delta: rule.delta, active: rule.active, updatedAt: new Date() })
          .where(eq(scoreRules.id, existing.id));
        await writeAudit({
          eventId,
          actorId: session.user.id,
          action: "score.rule_changed",
          entity: "score_rule",
          entityId: existing.id,
          before: { delta: existing.delta, active: existing.active },
          after: { delta: rule.delta, active: rule.active },
        });
      } else {
        await db.insert(scoreRules).values({ ...rule, eventId });
      }
    }

    revalidatePath("/admin/score");
    return success("Pravidlá sú uložené.");
  } catch (error) {
    return toActionResult(error, "Pravidlá sa nepodarilo uložiť.");
  }
}

const manualScoreSchema = z.object({
  userId: uuidSchema,
  delta: z.coerce.number().int().min(-100).max(100),
  reason: z.string().trim().min(3, "Uveď dôvod úpravy.").max(300),
});

/** Manuálna úprava skóre — vždy s dôvodom a záznamom v histórii. */
export async function adjustCrewScore(payload: unknown): Promise<ActionResult> {
  try {
    await assertSameOrigin();
    const session = await assertFullAdmin();
    if (!session.eventId) return failure("Nie je zvolený žiadny event.");

    const parsed = manualScoreSchema.safeParse(payload);
    if (!parsed.success) return failure("Skontroluj údaje.", fieldErrors(parsed.error));

    const result = await applyScoreRule({
      userId: parsed.data.userId,
      eventId: session.eventId,
      ruleKey: "manual_adjustment",
      overrideDelta: parsed.data.delta,
      reason: parsed.data.reason,
      actorId: session.user.id,
    });

    await writeAudit({
      eventId: session.eventId,
      actorId: session.user.id,
      action: "score.adjusted",
      entity: "user",
      entityId: parsed.data.userId,
      after: { delta: result?.delta ?? 0, score: result?.score, reason: parsed.data.reason },
      ip: await clientIp(),
    });

    revalidatePath("/admin/score");
    revalidatePath(`/admin/staff/${parsed.data.userId}`);
    return success(`Skóre je upravené na ${result?.score ?? "—"}.`);
  } catch (error) {
    return toActionResult(error, "Skóre sa nepodarilo upraviť.");
  }
}
