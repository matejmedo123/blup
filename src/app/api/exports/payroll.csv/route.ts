import { and, eq } from "drizzle-orm";

import { getDb } from "@/db/client";
import { payrollRecords } from "@/db/schema";
import { getSession } from "@/lib/auth/session";
import { writeAudit } from "@/lib/audit";
import { clientIp } from "@/lib/auth/guards";
import { eventSettings, getEventById } from "@/lib/domain/events";
import { payrollCsv, payrollLines } from "@/lib/domain/payroll";
import { can } from "@/lib/permissions";

/**
 * CSV export miezd. Predvolene iba schválená dochádzka (Rule 6);
 * `?all=1` pridá aj neschválené riadky s príznakom `approved=no`.
 */
export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return new Response("Unauthorized", { status: 401 });
  if (!can(session.actor, "can_view_payroll")) return new Response("Forbidden", { status: 403 });
  if (!session.eventId) return new Response("No event", { status: 400 });

  const url = new URL(request.url);
  const includeAll = url.searchParams.get("all") === "1";

  const event = await getEventById(session.eventId);
  if (!event) return new Response("Event not found", { status: 404 });

  const lines = await payrollLines(session.eventId, { onlyApproved: !includeAll });
  const csv = payrollCsv(lines, {
    eventName: event.name,
    currency: eventSettings(event).currency,
  });

  const db = await getDb();
  await db
    .update(payrollRecords)
    .set({ exportedAt: new Date(), status: "exported" })
    .where(
      and(eq(payrollRecords.eventId, session.eventId), eq(payrollRecords.status, "approved")),
    );

  await writeAudit({
    eventId: session.eventId,
    actorId: session.user.id,
    action: "payroll.exported",
    entity: "event",
    entityId: session.eventId,
    after: { rows: lines.length, includeUnapproved: includeAll },
    ip: await clientIp(),
  });

  const filename = `crew-mzdy-${event.slug}-${new Date().toISOString().slice(0, 10)}.csv`;

  // BOM na začiatku — slovenský Excel inak rozbije diakritiku.
  return new Response(`﻿${csv}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
