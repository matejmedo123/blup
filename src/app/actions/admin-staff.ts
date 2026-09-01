"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getDb } from "@/db/client";
import { EVENT_ROLES } from "@/db/enums";
import { eventMembers, users } from "@/db/schema";
import { failure, success, toActionResult, type ActionResult } from "@/lib/action-result";
import { assertFullAdmin, assertSameOrigin, clientIp } from "@/lib/auth/guards";
import { destroyAllSessions } from "@/lib/auth/session";
import { diffRecords, writeAudit } from "@/lib/audit";
import { COORDINATOR_DEFAULT_PERMISSIONS, PERMISSION_KEYS } from "@/lib/permissions";
import { fieldErrors, uuidSchema } from "@/lib/validation/common";

const permissionsSchema = z.object(
  Object.fromEntries(PERMISSION_KEYS.map((key) => [key, z.boolean().optional()])) as Record<
    (typeof PERMISSION_KEYS)[number],
    z.ZodOptional<z.ZodBoolean>
  >,
);

const roleSchema = z.object({
  userId: uuidSchema,
  role: z.enum(EVENT_ROLES),
  permissions: permissionsSchema,
});

/** Zmena role a granulárnych oprávnení koordinátora (§11, §28). */
export async function updateStaffRole(payload: unknown): Promise<ActionResult> {
  try {
    await assertSameOrigin();
    const session = await assertFullAdmin();
    if (!session.eventId) return failure("Nie je zvolený žiadny event.");

    const parsed = roleSchema.safeParse(payload);
    if (!parsed.success) return failure("Neplatné údaje.", fieldErrors(parsed.error));
    const { userId, role, permissions } = parsed.data;

    if (userId === session.user.id && role !== "admin") {
      return failure("Vlastnú admin rolu si odobrať nemôžeš.");
    }

    const db = await getDb();
    const [membership] = await db
      .select()
      .from(eventMembers)
      .where(and(eq(eventMembers.userId, userId), eq(eventMembers.eventId, session.eventId)))
      .limit(1);

    // Staff nemá granulárne práva — tie dávajú zmysel len koordinátorovi a adminovi.
    const nextPermissions = role === "staff" ? {} : permissions;

    if (membership) {
      const diff = diffRecords(
        { role: membership.role, permissions: membership.permissions },
        { role, permissions: nextPermissions },
      );
      await db
        .update(eventMembers)
        .set({ role, permissions: nextPermissions, updatedAt: new Date() })
        .where(eq(eventMembers.id, membership.id));

      if (diff) {
        await writeAudit({
          eventId: session.eventId,
          actorId: session.user.id,
          action: "user.permissions_changed",
          entity: "user",
          entityId: userId,
          before: diff.before,
          after: diff.after,
          ip: await clientIp(),
        });
      }
    } else {
      await db.insert(eventMembers).values({
        userId,
        eventId: session.eventId,
        role,
        permissions: nextPermissions,
      });
      await writeAudit({
        eventId: session.eventId,
        actorId: session.user.id,
        action: "user.role_changed",
        entity: "user",
        entityId: userId,
        after: { role, permissions: nextPermissions },
        ip: await clientIp(),
      });
    }

    revalidatePath(`/admin/staff/${userId}`);
    revalidatePath("/admin/staff");
    return success("Rola a oprávnenia sú uložené.");
  } catch (error) {
    return toActionResult(error, "Rolu sa nepodarilo zmeniť.");
  }
}

const accountSchema = z.object({
  userId: uuidSchema,
  status: z.enum(["active", "suspended"]),
});

/** Dočasná deaktivácia účtu — odhlási všetky relácie (§28). */
export async function setAccountStatus(payload: unknown): Promise<ActionResult> {
  try {
    await assertSameOrigin();
    const session = await assertFullAdmin();
    if (!session.eventId) return failure("Nie je zvolený žiadny event.");

    const parsed = accountSchema.safeParse(payload);
    if (!parsed.success) return failure("Neplatný stav.", fieldErrors(parsed.error));
    if (parsed.data.userId === session.user.id) {
      return failure("Vlastný účet deaktivovať nemôžeš.");
    }

    const db = await getDb();
    const [before] = await db
      .select({ status: users.status })
      .from(users)
      .where(eq(users.id, parsed.data.userId))
      .limit(1);
    if (!before) return failure("Používateľ sa nenašiel.");

    await db
      .update(users)
      .set({ status: parsed.data.status, updatedAt: new Date() })
      .where(eq(users.id, parsed.data.userId));

    if (parsed.data.status === "suspended") {
      await destroyAllSessions(parsed.data.userId);
    }

    await writeAudit({
      eventId: session.eventId,
      actorId: session.user.id,
      action: parsed.data.status === "suspended" ? "user.suspended" : "user.activated",
      entity: "user",
      entityId: parsed.data.userId,
      before: { status: before.status },
      after: { status: parsed.data.status },
      ip: await clientIp(),
    });

    revalidatePath(`/admin/staff/${parsed.data.userId}`);
    revalidatePath("/admin/staff");
    return success(
      parsed.data.status === "suspended"
        ? "Účet je deaktivovaný a odhlásený zo všetkých zariadení."
        : "Účet je znova aktívny.",
    );
  } catch (error) {
    return toActionResult(error, "Stav účtu sa nepodarilo zmeniť.");
  }
}

export async function coordinatorDefaults() {
  return COORDINATOR_DEFAULT_PERMISSIONS;
}
