import { z } from "zod";

import { apiError, apiOk, isSameOrigin } from "@/lib/api-helpers";
import { clientIp } from "@/lib/auth/guards";
import { getSession } from "@/lib/auth/session";
import { performCheckOut } from "@/lib/domain/check-in";
import { can } from "@/lib/permissions";
import { enforceRateLimit } from "@/lib/rate-limit";
import { uuidSchema } from "@/lib/validation/common";

const bodySchema = z.object({
  shiftId: uuidSchema,
  userId: uuidSchema.optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  breakMinutes: z.number().int().min(0).max(600).optional(),
});

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return apiError("Neplatný pôvod požiadavky.", 403);

  const session = await getSession();
  if (!session) return apiError("Nie si prihlásený.", 401);
  if (!session.eventId) return apiError("Nie je zvolený žiadny event.", 400);

  const limit = await enforceRateLimit("checkIn", session.user.id);
  if (!limit.allowed) {
    return apiError("Príliš veľa pokusov. Skús to o chvíľu.", 429, {
      retryAfter: limit.retryAfterSeconds,
    });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return apiError("Neplatné dáta.", 400);
  }

  const parsed = bodySchema.safeParse(payload);
  if (!parsed.success) return apiError("Neplatné dáta check-outu.", 400);
  const input = parsed.data;

  const targetUserId = input.userId ?? session.user.id;
  const onBehalf = targetUserId !== session.user.id;

  if (onBehalf && !can(session.actor, "can_check_out_others")) {
    return apiError("Nemáš oprávnenie ukončovať smenu iným.", 403);
  }

  try {
    const result = await performCheckOut({
      shiftId: input.shiftId,
      targetUserId,
      actorId: session.user.id,
      eventId: session.eventId,
      source: onBehalf
        ? session.actor.eventRole === "coordinator"
          ? "coordinator"
          : "admin"
        : "self",
      lat: input.lat ?? null,
      lng: input.lng ?? null,
      breakMinutes: input.breakMinutes,
      ip: await clientIp(),
      idempotencyKey: request.headers.get("idempotency-key"),
    });

    return apiOk({ ...result });
  } catch (error) {
    if (error instanceof Error && error.name === "DomainError") {
      return apiError(error.message, 409);
    }
    console.error("check-out failed", error);
    return apiError("Check-out sa nepodaril. Skús to prosím znova.", 500);
  }
}
