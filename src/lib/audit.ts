import "server-only";

import type { Database } from "@/db/client";
import { getDb } from "@/db/client";
import { auditLogs } from "@/db/schema";

export type AuditAction =
  | "application.approved"
  | "application.rejected"
  | "application.status_changed"
  | "application.note_updated"
  | "volunteer.status_changed"
  | "vendor.status_changed"
  | "user.role_changed"
  | "user.permissions_changed"
  | "user.suspended"
  | "user.activated"
  | "user.deleted"
  | "position.created"
  | "position.updated"
  | "position.deleted"
  | "shift.created"
  | "shift.updated"
  | "shift.cancelled"
  | "shift.deleted"
  | "assignment.created"
  | "assignment.removed"
  | "assignment.status_changed"
  | "assignment.auto_assigned"
  | "attendance.checked_in"
  | "attendance.checked_out"
  | "attendance.corrected"
  | "attendance.approved"
  | "rate.changed"
  | "score.adjusted"
  | "score.rule_changed"
  | "rating.created"
  | "incident.created"
  | "incident.resolved"
  | "payroll.generated"
  | "payroll.approved"
  | "payroll.exported"
  | "message.broadcast"
  | "event.updated";

export type AuditEntry = {
  eventId?: string | null;
  actorId?: string | null;
  action: AuditAction;
  entity: string;
  entityId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  ip?: string | null;
};

/**
 * Zapíše audit záznam. `tx` sa použije, ak je akcia súčasťou transakcie —
 * dochádzková korekcia a jej audit musia byť atomické (Rule 3).
 */
export async function writeAudit(entry: AuditEntry, tx?: Database): Promise<void> {
  const db = tx ?? (await getDb());
  await db.insert(auditLogs).values({
    eventId: entry.eventId ?? null,
    actorId: entry.actorId ?? null,
    action: entry.action,
    entity: entry.entity,
    entityId: entry.entityId ?? null,
    beforeValue: entry.before ?? null,
    afterValue: entry.after ?? null,
    ip: entry.ip ?? null,
  });
}

/** Vyberie iba zmenené polia — audit log tak nesie diff, nie celé záznamy. */
export function diffRecords<T extends Record<string, unknown>>(
  before: T,
  after: Partial<T>,
): { before: Record<string, unknown>; after: Record<string, unknown> } | null {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const [key, nextValue] of Object.entries(after)) {
    const prevValue = before[key];
    const normalise = (v: unknown) => (v instanceof Date ? v.toISOString() : v);
    if (JSON.stringify(normalise(prevValue)) !== JSON.stringify(normalise(nextValue))) {
      b[key] = normalise(prevValue) ?? null;
      a[key] = normalise(nextValue) ?? null;
    }
  }
  return Object.keys(a).length > 0 ? { before: b, after: a } : null;
}

export const AUDIT_ACTION_LABELS: Record<string, string> = {
  "application.approved": "Schválil prihlášku",
  "application.rejected": "Zamietol prihlášku",
  "application.status_changed": "Zmenil stav prihlášky",
  "application.note_updated": "Upravil internú poznámku",
  "volunteer.status_changed": "Zmenil stav dobrovoľníka",
  "vendor.status_changed": "Zmenil stav stánkara",
  "user.role_changed": "Zmenil rolu",
  "user.permissions_changed": "Zmenil oprávnenia",
  "user.suspended": "Deaktivoval účet",
  "user.activated": "Aktivoval účet",
  "user.deleted": "Odstránil účet",
  "position.created": "Vytvoril pozíciu",
  "position.updated": "Upravil pozíciu",
  "position.deleted": "Odstránil pozíciu",
  "shift.created": "Vytvoril smenu",
  "shift.updated": "Upravil smenu",
  "shift.cancelled": "Zrušil smenu",
  "shift.deleted": "Odstránil smenu",
  "assignment.created": "Pridelil smenu",
  "assignment.removed": "Odobral smenu",
  "assignment.status_changed": "Zmenil stav pridelenia",
  "assignment.auto_assigned": "Automaticky rozdelil smeny",
  "attendance.checked_in": "Check-in",
  "attendance.checked_out": "Check-out",
  "attendance.corrected": "Opravil dochádzku",
  "attendance.approved": "Schválil dochádzku",
  "rate.changed": "Zmenil hodinovku",
  "score.adjusted": "Upravil skóre",
  "score.rule_changed": "Zmenil pravidlo skóre",
  "rating.created": "Ohodnotil pracovníka",
  "incident.created": "Vytvoril incident",
  "incident.resolved": "Vyriešil incident",
  "payroll.generated": "Vygeneroval mzdové podklady",
  "payroll.approved": "Schválil mzdy",
  "payroll.exported": "Exportoval mzdy",
  "message.broadcast": "Poslal hromadnú správu",
  "event.updated": "Upravil event",
};
