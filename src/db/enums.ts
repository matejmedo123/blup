/**
 * Explicitné stavové enumy (§40 zadania).
 * Hodnoty sú zároveň PostgreSQL enum typy — pozri `schema.ts`.
 */

export const GLOBAL_ROLES = [
  "admin",
  "staff",
  "applicant_volunteer",
  "applicant_vendor",
] as const;
export type GlobalRole = (typeof GLOBAL_ROLES)[number];

export const EVENT_ROLES = ["admin", "coordinator", "staff"] as const;
export type EventRole = (typeof EVENT_ROLES)[number];

export const USER_STATUSES = ["pending", "active", "suspended"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const EVENT_STATUSES = ["draft", "active", "archived"] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export const APPLICATION_STATUSES = [
  "pending",
  "reviewing",
  "approved",
  "rejected",
  "waitlist",
  "archived",
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const SHIFT_STATUSES = [
  "draft",
  "published",
  "full",
  "in_progress",
  "completed",
  "cancelled",
] as const;
export type ShiftStatus = (typeof SHIFT_STATUSES)[number];

export const ASSIGNMENT_STATUSES = [
  "invited",
  "pending_confirmation",
  "confirmed",
  "declined",
  "cancelled",
  "completed",
] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

export const ATTENDANCE_STATUSES = [
  "not_started",
  "checked_in",
  "checked_out",
  "late",
  "missing",
  "manually_corrected",
] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

export const CHECK_IN_METHODS = ["manual", "qr", "geofence", "qr_geofence"] as const;
export type CheckInMethod = (typeof CHECK_IN_METHODS)[number];

export const CHECK_IN_SOURCES = ["self", "qr", "geofence", "coordinator", "admin", "system"] as const;
export type CheckInSource = (typeof CHECK_IN_SOURCES)[number];

export const CONVERSATION_TYPES = [
  "direct",
  "shift",
  "group",
  "broadcast",
  "system",
] as const;
export type ConversationType = (typeof CONVERSATION_TYPES)[number];

export const MESSAGE_KINDS = ["text", "system", "attachment"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export const NOTIFICATION_TYPES = [
  "shift_assigned",
  "shift_updated",
  "shift_cancelled",
  "shift_reminder",
  "shift_confirmation_required",
  "message_received",
  "check_in_reminder",
  "check_out_reminder",
  "application_approved",
  "application_rejected",
  "payout_updated",
  "rating_received",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const INCIDENT_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

export const INCIDENT_CATEGORIES = [
  "no_show",
  "late",
  "behaviour",
  "safety",
  "equipment",
  "guest",
  "other",
] as const;
export type IncidentCategory = (typeof INCIDENT_CATEGORIES)[number];

export const PAYROLL_STATUSES = ["draft", "approved", "exported", "paid"] as const;
export type PayrollStatus = (typeof PAYROLL_STATUSES)[number];

export const AUTH_TOKEN_KINDS = ["email_verify", "password_reset"] as const;
export type AuthTokenKind = (typeof AUTH_TOKEN_KINDS)[number];

export const VENDOR_STAND_TYPES = [
  "food_truck",
  "stand",
  "tent",
  "trailer",
  "table",
  "other",
] as const;
export type VendorStandType = (typeof VENDOR_STAND_TYPES)[number];

export const VENDOR_ASSORTMENTS = [
  "food",
  "drinks",
  "crafts",
  "clothing",
  "facepainting",
  "rides",
  "tattoo",
  "handmade",
  "services",
  "other",
] as const;
export type VendorAssortment = (typeof VENDOR_ASSORTMENTS)[number];

export const VOLUNTEER_PREFERENCES = [
  "waste",
  "orange_vests",
  "security",
  "guest_help",
  "backstage",
  "build",
  "other",
] as const;
export type VolunteerPreference = (typeof VOLUNTEER_PREFERENCES)[number];

/** Preferované pozície v prihláške brigádnika (§5, krok 3). */
export const POSITION_KEYS = [
  "bar",
  "helper",
  "runner",
  "cashier",
  "security",
  "cleaning",
  "ticketing",
  "production",
  "stage",
  "hospitality",
  "registration",
  "other",
] as const;
export type PositionKey = (typeof POSITION_KEYS)[number];

export const WORK_TYPES = [
  "bartender",
  "waiter",
  "helper",
  "security",
  "runner",
  "ticketing",
  "stagehand",
  "cashier",
  "cleaning",
  "production",
  "hospitality",
  "other",
] as const;
export type WorkType = (typeof WORK_TYPES)[number];
