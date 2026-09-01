import type { EventPermissions } from "@/db/schema";
import type { EventRole, GlobalRole } from "@/db/enums";

export const PERMISSION_KEYS = [
  "can_check_in_others",
  "can_check_out_others",
  "can_edit_attendance",
  "can_manage_shifts",
  "can_message_staff",
  "can_view_payroll",
  "can_rate_staff",
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

export const PERMISSION_LABELS: Record<PermissionKey, string> = {
  can_check_in_others: "Check-in za iných",
  can_check_out_others: "Check-out za iných",
  can_edit_attendance: "Editácia dochádzky",
  can_manage_shifts: "Správa smien",
  can_message_staff: "Posielanie správ crew",
  can_view_payroll: "Prístup k mzdám",
  can_rate_staff: "Hodnotenie pracovníkov",
};

export const PERMISSION_DESCRIPTIONS: Record<PermissionKey, string> = {
  can_check_in_others: "Môže checknúť pracovníkov na smenu namiesto nich.",
  can_check_out_others: "Môže ukončiť smenu pracovníkom.",
  can_edit_attendance: "Môže opravovať časy dochádzky (vždy s audit logom).",
  can_manage_shifts: "Môže vytvárať, meniť a obsadzovať smeny.",
  can_message_staff: "Môže písať pracovníkom a posielať hromadné správy.",
  can_view_payroll: "Vidí mzdové podklady a exporty.",
  can_rate_staff: "Môže hodnotiť pracovníkov po smene.",
};

/** Predvolená sada práv pre rolu Shift Coordinator (§11). */
export const COORDINATOR_DEFAULT_PERMISSIONS: EventPermissions = {
  can_check_in_others: true,
  can_check_out_others: true,
  can_edit_attendance: true,
  can_manage_shifts: false,
  can_message_staff: true,
  can_view_payroll: false,
  can_rate_staff: true,
};

export type Actor = {
  userId: string;
  globalRole: GlobalRole;
  eventRole: EventRole | null;
  permissions: EventPermissions;
};

export function isAdmin(actor: Pick<Actor, "globalRole">): boolean {
  return actor.globalRole === "admin";
}

/** Admin má implicitne všetky práva; koordinátor iba tie explicitne udelené. */
export function can(actor: Actor, permission: PermissionKey): boolean {
  if (isAdmin(actor)) return true;
  if (actor.eventRole === "admin") return true;
  return actor.permissions[permission] === true;
}

/** Prístup do admin rozhrania — admin alebo koordinátor s aspoň jedným právom. */
export function canAccessAdmin(actor: Actor): boolean {
  if (isAdmin(actor) || actor.eventRole === "admin") return true;
  if (actor.eventRole !== "coordinator") return false;
  return PERMISSION_KEYS.some((key) => actor.permissions[key] === true);
}

export function canAccessPortal(actor: Pick<Actor, "globalRole">): boolean {
  return actor.globalRole === "admin" || actor.globalRole === "staff";
}

/** Sekcie admin navigácie, ktoré daný actor smie vidieť. */
export function visibleAdminSections(actor: Actor): Set<string> {
  const sections = new Set<string>(["dashboard"]);
  if (isAdmin(actor) || actor.eventRole === "admin") {
    return new Set([
      "dashboard",
      "applicants",
      "staff",
      "volunteers",
      "vendors",
      "positions",
      "shifts",
      "assignments",
      "calendar",
      "attendance",
      "corrections",
      "messages",
      "notifications",
      "ratings",
      "score",
      "incidents",
      "payroll",
      "exports",
      "settings",
    ]);
  }
  if (can(actor, "can_manage_shifts")) {
    sections.add("shifts").add("assignments").add("calendar").add("positions");
  }
  if (can(actor, "can_edit_attendance") || can(actor, "can_check_in_others")) {
    sections.add("attendance").add("staff");
  }
  if (can(actor, "can_edit_attendance")) sections.add("corrections");
  if (can(actor, "can_message_staff")) sections.add("messages").add("notifications");
  if (can(actor, "can_rate_staff")) sections.add("ratings").add("incidents").add("staff");
  if (can(actor, "can_view_payroll")) sections.add("payroll").add("exports");
  return sections;
}
