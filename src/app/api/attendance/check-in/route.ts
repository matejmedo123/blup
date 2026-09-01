import { z } from "zod";

import { CHECK_IN_SOURCES } from "@/db/enums";
import { apiError, apiOk, isSameOrigin } from "@/lib/api-helpers";
import { clientIp } from "@/lib/auth/guards";
import { getSession } from "@/lib/auth/session";
import { performCheckIn } from "@/lib/domain/check-in";
import { can } from "@/lib/permissions";
import { enforceRateLimit } from "@/lib/rate-limit";
import { uuidSchema } from "@/lib/validation/common";

const bodySchema = z.object({
  shiftId: uuidSchema,
  /** Prítomné len pri check-ine za iného — vyžaduje `can_check_in_others`. */
  userId: uuidSchema.optional(),
  qrToken: z.string().max(64).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  accuracy: z.number().optional(),
  source: z.enum(CHECK_IN_SOURCES).optional(),
});

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return apiError("Neplatný pôvod požiadavky.", 403);

  const session = await getSession();
  if (!session) return apiError("Nie si prihlásený.", 401);
  if (!session.eventId) return apiError("Nie je zvolený žiadny event.", 400);

  const limit = await enforceRateLimit("checkIn", session.user.id);
  if (!limit.allowed) {
    return apiError("Príliš veľa pokusov o check-in. Skús to o chvíľu.", 429, {
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
  if (!parsed.success) return apiError("Neplatné dáta check-inu.", 400);
  const input = parsed.data;

  const targetUserId = input.userId ?? session.user.id;
  const onBehalf = targetUserId !== session.user.id;

  if (onBehalf && !can(session.actor, "can_check_in_others")) {
    return apiError("Nemáš oprávnenie checkovať iných ľudí.", 403);
  }

  const source = onBehalf
    ? session.actor.eventRole === "coordinator"
      ? "coordinator"
      : "admin"
    : input.qrToken
      ? "qr"
      : input.lat != null
        ? "geofence"
        : "self";

  try {
    const result = await performCheckIn({
      shiftId: input.shiftId,
      targetUserId,
      actorId: session.user.id,
      eventId: session.eventId,
      source,
      lat: input.lat ?? null,
      lng: input.lng ?? null,
      qrToken: input.qrToken ?? null,
      device: {
        ua: request.headers.get("user-agent")?.slice(0, 200) ?? "",
        accuracy: input.accuracy != null ? String(Math.round(input.accuracy)) : "",
      },
      ip: await clientIp(),
      // Idempotencia: rovnaký retry nikdy nevytvorí druhý check-in (§73).
      idempotencyKey: request.headers.get("idempotency-key"),
    });

    return apiOk({ ...result });
  } catch (error) {
    if (error instanceof Error && error.name === "DomainError") {
      return apiError(error.message, 409);
    }
    console.error("check-in failed", error);
    return apiError("Check-in sa nepodaril. Skús to prosím znova.", 500);
  }
}
