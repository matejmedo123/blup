import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import QRCode from "qrcode";

import { getDb } from "@/db/client";
import { shifts } from "@/db/schema";
import { getSession } from "@/lib/auth/session";
import { signShiftQr } from "@/lib/auth/tokens";
import { can, canAccessAdmin } from "@/lib/permissions";

/**
 * QR kód pre check-in na smenu. Kóduje URL, takže ho naskenuje aj natívna
 * fotoaparátová appka telefónu — v CREW. netreba vlastný skener.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session) return new NextResponse("Unauthorized", { status: 401 });
  if (!canAccessAdmin(session.actor) && !can(session.actor, "can_check_in_others")) {
    return new NextResponse("Forbidden", { status: 403 });
  }
  if (!session.eventId) return new NextResponse("No event", { status: 400 });

  const { id } = await params;
  const db = await getDb();
  const [shift] = await db
    .select({ id: shifts.id, qrSecret: shifts.qrSecret })
    .from(shifts)
    .where(and(eq(shifts.id, id), eq(shifts.eventId, session.eventId), isNull(shifts.deletedAt)))
    .limit(1);

  if (!shift) return new NextResponse("Not found", { status: 404 });

  const base = process.env.APP_URL ?? "http://localhost:3000";
  const token = signShiftQr(shift.id, shift.qrSecret);
  const url = `${base.replace(/\/$/, "")}/portal/checkin?s=${shift.id}&t=${token}`;

  const svg = await QRCode.toString(url, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 1,
    color: { dark: "#111111", light: "#ffffff" },
    width: 512,
  });

  return new NextResponse(svg, {
    headers: {
      "Content-Type": "image/svg+xml",
      // Súkromný obsah — nikdy nesmie skončiť vo verejnej cache.
      "Cache-Control": "private, no-store",
    },
  });
}
