import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import {
  APPLICATION_STATUSES,
  ASSIGNMENT_STATUSES,
  ATTENDANCE_STATUSES,
  AUTH_TOKEN_KINDS,
  CHECK_IN_METHODS,
  CHECK_IN_SOURCES,
  CONVERSATION_TYPES,
  EVENT_ROLES,
  EVENT_STATUSES,
  GLOBAL_ROLES,
  INCIDENT_CATEGORIES,
  INCIDENT_SEVERITIES,
  MESSAGE_KINDS,
  NOTIFICATION_TYPES,
  PAYROLL_STATUSES,
  SHIFT_STATUSES,
  USER_STATUSES,
} from "./enums";

/* ------------------------------------------------------------------ enums */

export const globalRoleEnum = pgEnum("global_role", GLOBAL_ROLES);
export const eventRoleEnum = pgEnum("event_role", EVENT_ROLES);
export const userStatusEnum = pgEnum("user_status", USER_STATUSES);
export const eventStatusEnum = pgEnum("event_status", EVENT_STATUSES);
export const applicationStatusEnum = pgEnum("application_status", APPLICATION_STATUSES);
export const shiftStatusEnum = pgEnum("shift_status", SHIFT_STATUSES);
export const assignmentStatusEnum = pgEnum("assignment_status", ASSIGNMENT_STATUSES);
export const attendanceStatusEnum = pgEnum("attendance_status", ATTENDANCE_STATUSES);
export const checkInMethodEnum = pgEnum("check_in_method", CHECK_IN_METHODS);
export const checkInSourceEnum = pgEnum("check_in_source", CHECK_IN_SOURCES);
export const conversationTypeEnum = pgEnum("conversation_type", CONVERSATION_TYPES);
export const messageKindEnum = pgEnum("message_kind", MESSAGE_KINDS);
export const notificationTypeEnum = pgEnum("notification_type", NOTIFICATION_TYPES);
export const incidentSeverityEnum = pgEnum("incident_severity", INCIDENT_SEVERITIES);
export const incidentCategoryEnum = pgEnum("incident_category", INCIDENT_CATEGORIES);
export const payrollStatusEnum = pgEnum("payroll_status", PAYROLL_STATUSES);
export const authTokenKindEnum = pgEnum("auth_token_kind", AUTH_TOKEN_KINDS);

/* ---------------------------------------------------------------- helpers */

const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
const money = (name: string) => numeric(name, { precision: 10, scale: 2 });

/** Granulárne oprávnenia koordinátora (§11). */
export type EventPermissions = {
  can_check_in_others?: boolean;
  can_check_out_others?: boolean;
  can_edit_attendance?: boolean;
  can_manage_shifts?: boolean;
  can_message_staff?: boolean;
  can_view_payroll?: boolean;
  can_rate_staff?: boolean;
};

/** Nastavenia eventu (zaokrúhľovanie, overtime, geofence default…). */
export type EventSettings = {
  rounding?: "exact" | "5min" | "15min";
  overtime_after_hours?: number;
  overtime_multiplier?: number;
  currency?: string;
  default_geofence_radius_m?: number;
  reminder_hours_before?: number;
};

/* -------------------------------------------------------------- identita */

export const users = pgTable(
  "users",
  {
    id: id(),
    email: text("email").notNull(),
    passwordHash: text("password_hash"),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    phone: text("phone"),
    city: text("city"),
    birthYear: integer("birth_year"),
    avatarUrl: text("avatar_url"),
    globalRole: globalRoleEnum("global_role").notNull().default("applicant_volunteer"),
    status: userStatusEnum("status").notNull().default("pending"),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("users_email_unique").on(sql`lower(${t.email})`),
    index("users_role_status_idx").on(t.globalRole, t.status),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("sessions_token_hash_unique").on(t.tokenHash),
    index("sessions_user_idx").on(t.userId),
    index("sessions_expires_idx").on(t.expiresAt),
  ],
);

export const authTokens = pgTable(
  "auth_tokens",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: authTokenKindEnum("kind").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("auth_tokens_hash_unique").on(t.tokenHash),
    index("auth_tokens_user_kind_idx").on(t.userId, t.kind),
  ],
);

export const events = pgTable(
  "events",
  {
    id: id(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    location: text("location"),
    lat: numeric("lat", { precision: 9, scale: 6 }),
    lng: numeric("lng", { precision: 9, scale: 6 }),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    timezone: text("timezone").notNull().default("Europe/Bratislava"),
    status: eventStatusEnum("status").notNull().default("draft"),
    settings: jsonb("settings").$type<EventSettings>().notNull().default({}),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("events_slug_unique").on(t.slug), index("events_status_idx").on(t.status)],
);

export const eventMembers = pgTable(
  "event_members",
  {
    id: id(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: eventRoleEnum("role").notNull().default("staff"),
    permissions: jsonb("permissions").$type<EventPermissions>().notNull().default({}),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("event_members_unique").on(t.eventId, t.userId),
    index("event_members_user_idx").on(t.userId),
    index("event_members_event_role_idx").on(t.eventId, t.role),
  ],
);

/* ------------------------------------------------------------- prihlášky */

export const applications = pgTable(
  "applications",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    status: applicationStatusEnum("status").notNull().default("pending"),
    motivation: text("motivation"),
    source: text("source"),
    internalNote: text("internal_note"),
    reviewedBy: uuid("reviewed_by").references(() => users.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    rejectionReason: text("rejection_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("applications_user_event_unique").on(t.userId, t.eventId),
    index("applications_event_status_idx").on(t.eventId, t.status),
  ],
);

export const experiences = pgTable(
  "experiences",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    positionLabel: text("position_label").notNull(),
    company: text("company").notNull(),
    workType: text("work_type").notNull().default("other"),
    dateFrom: date("date_from").notNull(),
    dateTo: date("date_to"),
    description: text("description"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("experiences_user_idx").on(t.userId)],
);

export const applicationPositions = pgTable(
  "application_positions",
  {
    id: id(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    positionKey: text("position_key").notNull(),
  },
  (t) => [uniqueIndex("application_positions_unique").on(t.applicationId, t.positionKey)],
);

export const applicationAnswers = pgTable(
  "application_answers",
  {
    id: id(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    questionKey: text("question_key").notNull(),
    answerBool: boolean("answer_bool"),
    answerText: text("answer_text"),
  },
  (t) => [uniqueIndex("application_answers_unique").on(t.applicationId, t.questionKey)],
);

export const availabilities = pgTable(
  "availabilities",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    timeFrom: text("time_from").notNull().default("08:00"),
    timeTo: text("time_to").notNull().default("22:00"),
    maxHours: integer("max_hours"),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("availabilities_unique").on(t.userId, t.eventId, t.day),
    index("availabilities_event_idx").on(t.eventId),
  ],
);

export const consents = pgTable(
  "consents",
  {
    id: id(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    email: text("email"),
    kind: text("kind").notNull(),
    textVersion: text("text_version").notNull(),
    granted: boolean("granted").notNull().default(true),
    ip: text("ip"),
    createdAt: createdAt(),
  },
  (t) => [index("consents_user_idx").on(t.userId)],
);

export const volunteerApplications = pgTable(
  "volunteer_applications",
  {
    id: id(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    email: text("email").notNull(),
    phone: text("phone").notNull(),
    city: text("city"),
    birthYear: integer("birth_year"),
    preferences: jsonb("preferences").$type<string[]>().notNull().default([]),
    availability: jsonb("availability").$type<{ day: string; from: string; to: string }[]>().notNull().default([]),
    note: text("note"),
    status: applicationStatusEnum("status").notNull().default("pending"),
    internalNote: text("internal_note"),
    reviewedBy: uuid("reviewed_by").references(() => users.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("volunteer_applications_event_status_idx").on(t.eventId, t.status),
    uniqueIndex("volunteer_applications_event_email_unique").on(t.eventId, sql`lower(${t.email})`),
  ],
);

export const vendorApplications = pgTable(
  "vendor_applications",
  {
    id: id(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    contactName: text("contact_name").notNull(),
    companyName: text("company_name"),
    ico: text("ico"),
    email: text("email").notNull(),
    phone: text("phone").notNull(),
    website: text("website"),
    instagram: text("instagram"),
    facebook: text("facebook"),
    standType: text("stand_type").notNull(),
    assortment: jsonb("assortment").$type<string[]>().notNull().default([]),
    assortmentDetail: text("assortment_detail"),
    widthM: numeric("width_m", { precision: 6, scale: 2 }),
    depthM: numeric("depth_m", { precision: 6, scale: 2 }),
    needsElectricity: boolean("needs_electricity").notNull().default(false),
    powerKw: numeric("power_kw", { precision: 6, scale: 2 }),
    needsWater: boolean("needs_water").notNull().default(false),
    needsWaste: boolean("needs_waste").notNull().default(false),
    placementRequest: text("placement_request"),
    note: text("note"),
    attachments: jsonb("attachments").$type<{ name: string; url: string; size?: number }[]>().notNull().default([]),
    status: applicationStatusEnum("status").notNull().default("pending"),
    internalNote: text("internal_note"),
    reviewedBy: uuid("reviewed_by").references(() => users.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("vendor_applications_event_status_idx").on(t.eventId, t.status),
    uniqueIndex("vendor_applications_event_email_unique").on(t.eventId, sql`lower(${t.email})`),
  ],
);

/* ------------------------------------------------------------ plánovanie */

export const positions = pgTable(
  "positions",
  {
    id: id(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    hourlyRate: money("hourly_rate").notNull().default("0"),
    capacity: integer("capacity").notNull().default(0),
    color: text("color").notNull().default("#6366f1"),
    icon: text("icon").notNull().default("dot"),
    requiredSkills: jsonb("required_skills").$type<string[]>().notNull().default([]),
    active: boolean("active").notNull().default(true),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("positions_event_slug_unique").on(t.eventId, t.slug),
    index("positions_event_active_idx").on(t.eventId, t.active),
  ],
);

export const shifts = pgTable(
  "shifts",
  {
    id: id(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    positionId: uuid("position_id")
      .notNull()
      .references(() => positions.id, { onDelete: "restrict" }),
    title: text("title"),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    location: text("location"),
    lat: numeric("lat", { precision: 9, scale: 6 }),
    lng: numeric("lng", { precision: 9, scale: 6 }),
    capacity: integer("capacity").notNull().default(1),
    hourlyRate: money("hourly_rate"),
    status: shiftStatusEnum("status").notNull().default("draft"),
    checkInMethod: checkInMethodEnum("check_in_method").notNull().default("manual"),
    geofenceRadiusM: integer("geofence_radius_m").notNull().default(150),
    qrSecret: text("qr_secret").notNull(),
    coordinatorId: uuid("coordinator_id").references(() => users.id, { onDelete: "set null" }),
    instructions: text("instructions"),
    dressCode: text("dress_code"),
    showColleagues: boolean("show_colleagues").notNull().default(true),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("shifts_time_order", sql`${t.endsAt} > ${t.startsAt}`),
    check("shifts_capacity_positive", sql`${t.capacity} > 0`),
    index("shifts_event_start_idx").on(t.eventId, t.startsAt),
    index("shifts_position_idx").on(t.positionId),
    index("shifts_status_idx").on(t.eventId, t.status),
    index("shifts_coordinator_idx").on(t.coordinatorId),
  ],
);

export const shiftAssignments = pgTable(
  "shift_assignments",
  {
    id: id(),
    shiftId: uuid("shift_id")
      .notNull()
      .references(() => shifts.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    status: assignmentStatusEnum("status").notNull().default("pending_confirmation"),
    assignedBy: uuid("assigned_by").references(() => users.id, { onDelete: "set null" }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    declinedAt: timestamp("declined_at", { withTimezone: true }),
    declineReason: text("decline_reason"),
    needsReplacement: boolean("needs_replacement").notNull().default(false),
    note: text("note"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("shift_assignments_unique").on(t.shiftId, t.userId),
    index("shift_assignments_user_idx").on(t.userId),
    index("shift_assignments_event_status_idx").on(t.eventId, t.status),
  ],
);

export const attendance = pgTable(
  "attendance",
  {
    id: id(),
    assignmentId: uuid("assignment_id")
      .notNull()
      .references(() => shiftAssignments.id, { onDelete: "cascade" }),
    shiftId: uuid("shift_id")
      .notNull()
      .references(() => shifts.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    status: attendanceStatusEnum("status").notNull().default("not_started"),
    checkInAt: timestamp("check_in_at", { withTimezone: true }),
    checkOutAt: timestamp("check_out_at", { withTimezone: true }),
    checkInSource: checkInSourceEnum("check_in_source"),
    checkOutSource: checkInSourceEnum("check_out_source"),
    checkInBy: uuid("check_in_by").references(() => users.id, { onDelete: "set null" }),
    checkOutBy: uuid("check_out_by").references(() => users.id, { onDelete: "set null" }),
    checkInLat: numeric("check_in_lat", { precision: 9, scale: 6 }),
    checkInLng: numeric("check_in_lng", { precision: 9, scale: 6 }),
    checkOutLat: numeric("check_out_lat", { precision: 9, scale: 6 }),
    checkOutLng: numeric("check_out_lng", { precision: 9, scale: 6 }),
    device: jsonb("device").$type<Record<string, string>>(),
    breakMinutes: integer("break_minutes").notNull().default(0),
    workedMinutes: integer("worked_minutes"),
    lateMinutes: integer("late_minutes").notNull().default(0),
    approved: boolean("approved").notNull().default(false),
    approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    bonus: money("bonus").notNull().default("0"),
    adjustments: money("adjustments").notNull().default("0"),
    adjustmentNote: text("adjustment_note"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      "attendance_time_order",
      sql`${t.checkOutAt} is null or ${t.checkInAt} is null or ${t.checkOutAt} >= ${t.checkInAt}`,
    ),
    check("attendance_checkout_needs_checkin", sql`${t.checkOutAt} is null or ${t.checkInAt} is not null`),
    uniqueIndex("attendance_assignment_unique").on(t.assignmentId),
    index("attendance_event_status_idx").on(t.eventId, t.status),
    index("attendance_user_idx").on(t.userId),
    index("attendance_shift_idx").on(t.shiftId),
  ],
);

export const attendanceCorrections = pgTable(
  "attendance_corrections",
  {
    id: id(),
    attendanceId: uuid("attendance_id")
      .notNull()
      .references(() => attendance.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    field: text("field").notNull(),
    beforeValue: text("before_value"),
    afterValue: text("after_value"),
    reason: text("reason").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("attendance_corrections_attendance_idx").on(t.attendanceId)],
);

/** Ochrana pred dvojitým check-inom pri retry na slabom pripojení (§73). */
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    id: id(),
    key: text("key").notNull(),
    scope: text("scope").notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    response: jsonb("response").$type<Record<string, unknown>>(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("idempotency_keys_unique").on(t.scope, t.key)],
);

/* ---------------------------------------------------------- komunikácia */

export const conversations = pgTable(
  "conversations",
  {
    id: id(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    type: conversationTypeEnum("type").notNull().default("direct"),
    title: text("title"),
    shiftId: uuid("shift_id").references(() => shifts.id, { onDelete: "cascade" }),
    positionId: uuid("position_id").references(() => positions.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("conversations_event_idx").on(t.eventId, t.type),
    index("conversations_shift_idx").on(t.shiftId),
    index("conversations_last_message_idx").on(t.lastMessageAt),
  ],
);

export const conversationMembers = pgTable(
  "conversation_members",
  {
    id: id(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    isAdmin: boolean("is_admin").notNull().default(false),
    canWrite: boolean("can_write").notNull().default(true),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }),
    muted: boolean("muted").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("conversation_members_unique").on(t.conversationId, t.userId),
    index("conversation_members_user_idx").on(t.userId),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: id(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    senderId: uuid("sender_id").references(() => users.id, { onDelete: "set null" }),
    kind: messageKindEnum("kind").notNull().default("text"),
    body: text("body").notNull(),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("messages_conversation_created_idx").on(t.conversationId, t.createdAt)],
);

export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    eventId: uuid("event_id").references(() => events.id, { onDelete: "cascade" }),
    type: notificationTypeEnum("type").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    actionUrl: text("action_url"),
    entityType: text("entity_type"),
    entityId: uuid("entity_id"),
    requiresAction: boolean("requires_action").notNull().default(false),
    actionTakenAt: timestamp("action_taken_at", { withTimezone: true }),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("notifications_user_read_idx").on(t.userId, t.readAt),
    index("notifications_created_idx").on(t.createdAt),
  ],
);

/* -------------------------------------------------- výkon, skóre, payroll */

export const ratings = pgTable(
  "ratings",
  {
    id: id(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    raterId: uuid("rater_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    shiftId: uuid("shift_id").references(() => shifts.id, { onDelete: "set null" }),
    reliability: integer("reliability").notNull(),
    punctuality: integer("punctuality").notNull(),
    workEthic: integer("work_ethic").notNull(),
    communication: integer("communication").notNull(),
    quality: integer("quality").notNull(),
    overall: numeric("overall", { precision: 3, scale: 2 }).notNull(),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      "ratings_range",
      sql`${t.reliability} between 1 and 5 and ${t.punctuality} between 1 and 5 and ${t.workEthic} between 1 and 5 and ${t.communication} between 1 and 5 and ${t.quality} between 1 and 5`,
    ),
    index("ratings_staff_idx").on(t.staffId),
    uniqueIndex("ratings_shift_staff_rater_unique").on(t.shiftId, t.staffId, t.raterId),
  ],
);

export const crewScores = pgTable(
  "crew_scores",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    score: integer("score").notNull().default(70),
    updatedAt: updatedAt(),
    createdAt: createdAt(),
  },
  (t) => [
    check("crew_scores_range", sql`${t.score} between 0 and 100`),
    uniqueIndex("crew_scores_unique").on(t.userId, t.eventId),
  ],
);

export const scoreRules = pgTable(
  "score_rules",
  {
    id: id(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    delta: integer("delta").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("score_rules_unique").on(t.eventId, t.key)],
);

export const scoreTransactions = pgTable(
  "score_transactions",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    ruleKey: text("rule_key").notNull(),
    delta: integer("delta").notNull(),
    reason: text("reason"),
    entityType: text("entity_type"),
    entityId: uuid("entity_id"),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("score_transactions_user_idx").on(t.userId, t.eventId)],
);

export const incidents = pgTable(
  "incidents",
  {
    id: id(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    staffId: uuid("staff_id").references(() => users.id, { onDelete: "set null" }),
    shiftId: uuid("shift_id").references(() => shifts.id, { onDelete: "set null" }),
    severity: incidentSeverityEnum("severity").notNull().default("low"),
    category: incidentCategoryEnum("category").notNull().default("other"),
    description: text("description").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: uuid("resolved_by").references(() => users.id, { onDelete: "set null" }),
    resolution: text("resolution"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("incidents_event_resolved_idx").on(t.eventId, t.resolvedAt)],
);

export const payrollRecords = pgTable(
  "payroll_records",
  {
    id: id(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    attendanceId: uuid("attendance_id").references(() => attendance.id, { onDelete: "set null" }),
    positionId: uuid("position_id").references(() => positions.id, { onDelete: "set null" }),
    workDate: date("work_date").notNull(),
    hours: numeric("hours", { precision: 6, scale: 2 }).notNull().default("0"),
    hourlyRate: money("hourly_rate").notNull().default("0"),
    gross: money("gross").notNull().default("0"),
    bonus: money("bonus").notNull().default("0"),
    adjustments: money("adjustments").notNull().default("0"),
    total: money("total").notNull().default("0"),
    status: payrollStatusEnum("status").notNull().default("draft"),
    approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    exportedAt: timestamp("exported_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("payroll_records_attendance_unique").on(t.attendanceId),
    index("payroll_records_event_user_idx").on(t.eventId, t.userId),
  ],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: id(),
    eventId: uuid("event_id").references(() => events.id, { onDelete: "set null" }),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    entity: text("entity").notNull(),
    entityId: uuid("entity_id"),
    beforeValue: jsonb("before_value").$type<Record<string, unknown> | null>(),
    afterValue: jsonb("after_value").$type<Record<string, unknown> | null>(),
    ip: text("ip"),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_logs_entity_idx").on(t.entity, t.entityId),
    index("audit_logs_created_idx").on(t.createdAt),
    index("audit_logs_actor_idx").on(t.actorId),
  ],
);

export const staffNotes = pgTable(
  "staff_notes",
  {
    id: id(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    body: text("body").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("staff_notes_staff_idx").on(t.staffId)],
);

/* ------------------------------------------------------------- relations */

export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(eventMembers),
  applications: many(applications),
  experiences: many(experiences),
  assignments: many(shiftAssignments),
  attendance: many(attendance),
  notifications: many(notifications),
}));

export const eventsRelations = relations(events, ({ many }) => ({
  members: many(eventMembers),
  positions: many(positions),
  shifts: many(shifts),
  applications: many(applications),
}));

export const eventMembersRelations = relations(eventMembers, ({ one }) => ({
  event: one(events, { fields: [eventMembers.eventId], references: [events.id] }),
  user: one(users, { fields: [eventMembers.userId], references: [users.id] }),
}));

export const applicationsRelations = relations(applications, ({ one, many }) => ({
  user: one(users, { fields: [applications.userId], references: [users.id] }),
  event: one(events, { fields: [applications.eventId], references: [events.id] }),
  positions: many(applicationPositions),
  answers: many(applicationAnswers),
}));

export const shiftsRelations = relations(shifts, ({ one, many }) => ({
  event: one(events, { fields: [shifts.eventId], references: [events.id] }),
  position: one(positions, { fields: [shifts.positionId], references: [positions.id] }),
  coordinator: one(users, { fields: [shifts.coordinatorId], references: [users.id] }),
  assignments: many(shiftAssignments),
}));

export const shiftAssignmentsRelations = relations(shiftAssignments, ({ one }) => ({
  shift: one(shifts, { fields: [shiftAssignments.shiftId], references: [shifts.id] }),
  user: one(users, { fields: [shiftAssignments.userId], references: [users.id] }),
  attendance: one(attendance, {
    fields: [shiftAssignments.id],
    references: [attendance.assignmentId],
  }),
}));

export const attendanceRelations = relations(attendance, ({ one, many }) => ({
  assignment: one(shiftAssignments, {
    fields: [attendance.assignmentId],
    references: [shiftAssignments.id],
  }),
  shift: one(shifts, { fields: [attendance.shiftId], references: [shifts.id] }),
  user: one(users, { fields: [attendance.userId], references: [users.id] }),
  corrections: many(attendanceCorrections),
}));

export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  event: one(events, { fields: [conversations.eventId], references: [events.id] }),
  shift: one(shifts, { fields: [conversations.shiftId], references: [shifts.id] }),
  members: many(conversationMembers),
  messages: many(messages),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
  sender: one(users, { fields: [messages.senderId], references: [users.id] }),
}));

/* ----------------------------------------------------------------- types */

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Event = typeof events.$inferSelect;
export type EventMember = typeof eventMembers.$inferSelect;
export type Application = typeof applications.$inferSelect;
export type Experience = typeof experiences.$inferSelect;
export type Availability = typeof availabilities.$inferSelect;
export type Position = typeof positions.$inferSelect;
export type Shift = typeof shifts.$inferSelect;
export type ShiftAssignment = typeof shiftAssignments.$inferSelect;
export type Attendance = typeof attendance.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type Rating = typeof ratings.$inferSelect;
export type Incident = typeof incidents.$inferSelect;
export type PayrollRecord = typeof payrollRecords.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;
export type VolunteerApplication = typeof volunteerApplications.$inferSelect;
export type VendorApplication = typeof vendorApplications.$inferSelect;
