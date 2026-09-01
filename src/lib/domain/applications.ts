import "server-only";

import { and, asc, count, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";

import type { Database } from "@/db/client";
import { getDb } from "@/db/client";
import type { ApplicationStatus } from "@/db/enums";
import {
  applicationPositions,
  applications,
  availabilities,
  conversationMembers,
  conversations,
  crewScores,
  eventMembers,
  experiences,
  users,
} from "@/db/schema";
import { writeAudit } from "@/lib/audit";
import { sendEmailSafely } from "@/lib/email/provider";
import { emailTemplates } from "@/lib/email/templates";

import { notify } from "./notifications";
import { ensureCrewScore } from "./score";

export type ApplicantFilters = {
  q?: string;
  status?: ApplicationStatus;
  position?: string;
  city?: string;
  minScore?: number;
  sort?: "newest" | "oldest" | "name" | "score";
  page?: number;
  pageSize?: number;
};

export type ApplicantRow = {
  applicationId: string;
  userId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  city: string | null;
  birthYear: number | null;
  avatarUrl: string | null;
  status: ApplicationStatus;
  createdAt: Date;
  score: number | null;
  experienceCount: number;
  positions: string[];
};

const PAGE_SIZE = 25;

export async function listApplicants(
  eventId: string,
  filters: ApplicantFilters,
): Promise<{ rows: ApplicantRow[]; total: number; page: number; pageCount: number; pageSize: number }> {
  const db = await getDb();
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = filters.pageSize ?? PAGE_SIZE;

  const conditions: SQL[] = [eq(applications.eventId, eventId), isNull(users.deletedAt)];
  if (filters.status) conditions.push(eq(applications.status, filters.status));
  if (filters.city) conditions.push(ilike(users.city, `%${filters.city}%`));
  if (filters.q) {
    const like = `%${filters.q}%`;
    const search = or(
      ilike(users.firstName, like),
      ilike(users.lastName, like),
      ilike(users.email, like),
      ilike(users.phone, like),
      ilike(users.city, like),
      sql`lower(${users.firstName} || ' ' || ${users.lastName}) like lower(${like})`,
    );
    if (search) conditions.push(search);
  }
  if (filters.position) {
    conditions.push(
      sql`exists (select 1 from ${applicationPositions} ap where ap.application_id = ${applications.id} and ap.position_key = ${filters.position})`,
    );
  }
  if (filters.minScore != null) {
    conditions.push(sql`coalesce(${crewScores.score}, 70) >= ${filters.minScore}`);
  }

  const where = and(...conditions);

  const orderBy = (() => {
    switch (filters.sort) {
      case "oldest":
        return [asc(applications.createdAt)];
      case "name":
        return [asc(users.lastName), asc(users.firstName)];
      case "score":
        return [desc(sql`coalesce(${crewScores.score}, 70)`)];
      default:
        return [desc(applications.createdAt)];
    }
  })();

  const base = db
    .select({
      applicationId: applications.id,
      userId: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
      email: users.email,
      phone: users.phone,
      city: users.city,
      birthYear: users.birthYear,
      avatarUrl: users.avatarUrl,
      status: applications.status,
      createdAt: applications.createdAt,
      score: crewScores.score,
    })
    .from(applications)
    .innerJoin(users, eq(users.id, applications.userId))
    .leftJoin(
      crewScores,
      and(eq(crewScores.userId, users.id), eq(crewScores.eventId, applications.eventId)),
    )
    .where(where);

  const [{ value: total }] = await db
    .select({ value: count() })
    .from(applications)
    .innerJoin(users, eq(users.id, applications.userId))
    .leftJoin(
      crewScores,
      and(eq(crewScores.userId, users.id), eq(crewScores.eventId, applications.eventId)),
    )
    .where(where);

  const rows = await base
    .orderBy(...orderBy)
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  const ids = rows.map((r) => r.applicationId);
  const userIds = rows.map((r) => r.userId);

  const positionRows =
    ids.length > 0
      ? await db
          .select({
            applicationId: applicationPositions.applicationId,
            positionKey: applicationPositions.positionKey,
          })
          .from(applicationPositions)
          .where(inArray(applicationPositions.applicationId, ids))
      : [];

  const experienceRows =
    userIds.length > 0
      ? await db
          .select({ userId: experiences.userId, value: count() })
          .from(experiences)
          .where(inArray(experiences.userId, userIds))
          .groupBy(experiences.userId)
      : [];

  const positionsByApplication = new Map<string, string[]>();
  for (const row of positionRows) {
    const list = positionsByApplication.get(row.applicationId) ?? [];
    list.push(row.positionKey);
    positionsByApplication.set(row.applicationId, list);
  }
  const experienceByUser = new Map(experienceRows.map((r) => [r.userId, Number(r.value)]));

  return {
    rows: rows.map((row) => ({
      ...row,
      positions: positionsByApplication.get(row.applicationId) ?? [],
      experienceCount: experienceByUser.get(row.userId) ?? 0,
    })),
    total: Number(total),
    page,
    pageCount: Math.max(1, Math.ceil(Number(total) / pageSize)),
    pageSize,
  };
}

export async function countApplicantsByStatus(eventId: string) {
  const db = await getDb();
  const rows = await db
    .select({ status: applications.status, value: count() })
    .from(applications)
    .where(eq(applications.eventId, eventId))
    .groupBy(applications.status);
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.value)])) as Partial<
    Record<ApplicationStatus, number>
  >;
}

export async function getApplicantDetail(applicationId: string, eventId: string) {
  const db = await getDb();
  const [row] = await db
    .select({
      application: applications,
      user: users,
      score: crewScores.score,
    })
    .from(applications)
    .innerJoin(users, eq(users.id, applications.userId))
    .leftJoin(
      crewScores,
      and(eq(crewScores.userId, users.id), eq(crewScores.eventId, applications.eventId)),
    )
    .where(and(eq(applications.id, applicationId), eq(applications.eventId, eventId)))
    .limit(1);

  if (!row) return null;

  const [experienceRows, positionRows, availabilityRows] = await Promise.all([
    db
      .select()
      .from(experiences)
      .where(eq(experiences.userId, row.user.id))
      .orderBy(desc(experiences.dateFrom)),
    db
      .select({ positionKey: applicationPositions.positionKey })
      .from(applicationPositions)
      .where(eq(applicationPositions.applicationId, applicationId)),
    db
      .select()
      .from(availabilities)
      .where(and(eq(availabilities.userId, row.user.id), eq(availabilities.eventId, eventId)))
      .orderBy(asc(availabilities.day)),
  ]);

  return {
    application: row.application,
    user: row.user,
    score: row.score,
    experiences: experienceRows,
    positions: positionRows.map((p) => p.positionKey),
    availability: availabilityRows,
  };
}

/**
 * Schválenie prihlášky: aktivuje staff účet a členstvo v evente.
 * Zámerne **nepriradí žiadnu smenu** — to je samostatná akcia (Rule 1).
 */
export async function approveApplication(args: {
  applicationId: string;
  eventId: string;
  actorId: string;
  ip?: string | null;
  tx?: Database;
}): Promise<{ userId: string; email: string; firstName: string } | null> {
  const db = args.tx ?? (await getDb());

  const [row] = await db
    .select({
      id: applications.id,
      status: applications.status,
      userId: users.id,
      email: users.email,
      firstName: users.firstName,
      globalRole: users.globalRole,
      userStatus: users.status,
    })
    .from(applications)
    .innerJoin(users, eq(users.id, applications.userId))
    .where(and(eq(applications.id, args.applicationId), eq(applications.eventId, args.eventId)))
    .limit(1);

  if (!row || row.status === "approved") return null;

  await db
    .update(applications)
    .set({
      status: "approved",
      reviewedBy: args.actorId,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(applications.id, args.applicationId));

  await db
    .update(users)
    .set({ globalRole: "staff", status: "active", updatedAt: new Date() })
    .where(eq(users.id, row.userId));

  const [membership] = await db
    .select({ id: eventMembers.id })
    .from(eventMembers)
    .where(and(eq(eventMembers.userId, row.userId), eq(eventMembers.eventId, args.eventId)))
    .limit(1);

  if (membership) {
    await db
      .update(eventMembers)
      .set({ active: true, updatedAt: new Date() })
      .where(eq(eventMembers.id, membership.id));
  } else {
    await db.insert(eventMembers).values({
      userId: row.userId,
      eventId: args.eventId,
      role: "staff",
      permissions: {},
    });
  }

  await ensureCrewScore(row.userId, args.eventId, db);

  await writeAudit(
    {
      eventId: args.eventId,
      actorId: args.actorId,
      action: "application.approved",
      entity: "application",
      entityId: args.applicationId,
      before: { status: row.status },
      after: { status: "approved" },
      ip: args.ip,
    },
    db,
  );

  return { userId: row.userId, email: row.email, firstName: row.firstName };
}

export async function rejectApplication(args: {
  applicationId: string;
  eventId: string;
  actorId: string;
  reason?: string | null;
  ip?: string | null;
  tx?: Database;
}): Promise<{ userId: string; email: string; firstName: string } | null> {
  const db = args.tx ?? (await getDb());

  const [row] = await db
    .select({
      status: applications.status,
      userId: users.id,
      email: users.email,
      firstName: users.firstName,
    })
    .from(applications)
    .innerJoin(users, eq(users.id, applications.userId))
    .where(and(eq(applications.id, args.applicationId), eq(applications.eventId, args.eventId)))
    .limit(1);

  if (!row) return null;

  await db
    .update(applications)
    .set({
      status: "rejected",
      rejectionReason: args.reason ?? null,
      reviewedBy: args.actorId,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(applications.id, args.applicationId));

  // Účet ostáva, ale bez prístupu do portálu — profil sa dá použiť na ďalší event.
  await db
    .update(eventMembers)
    .set({ active: false, updatedAt: new Date() })
    .where(and(eq(eventMembers.userId, row.userId), eq(eventMembers.eventId, args.eventId)));

  await writeAudit(
    {
      eventId: args.eventId,
      actorId: args.actorId,
      action: "application.rejected",
      entity: "application",
      entityId: args.applicationId,
      before: { status: row.status },
      after: { status: "rejected", reason: args.reason ?? null },
      ip: args.ip,
    },
    db,
  );

  return { userId: row.userId, email: row.email, firstName: row.firstName };
}

/** Odošle notifikáciu + e-mail po zmene stavu prihlášky. */
export async function notifyApplicationDecision(args: {
  userId: string;
  email: string;
  firstName: string;
  eventId: string;
  eventName: string;
  approved: boolean;
  reason?: string | null;
}): Promise<void> {
  await notify({
    userId: args.userId,
    eventId: args.eventId,
    type: args.approved ? "application_approved" : "application_rejected",
    title: args.approved ? "Prihláška schválená" : "Prihláška zamietnutá",
    body: args.approved
      ? `Si v crew na ${args.eventName}. Pozri si svoje smeny v portáli.`
      : `Na ${args.eventName} sme ťa tentokrát nezaradili.`,
    actionUrl: args.approved ? "/portal" : "/prihlaska/stav",
    entityType: "application",
  });

  void sendEmailSafely(
    args.approved
      ? emailTemplates.applicationApproved({
          to: args.email,
          firstName: args.firstName,
          eventName: args.eventName,
        })
      : emailTemplates.applicationRejected({
          to: args.email,
          firstName: args.firstName,
          eventName: args.eventName,
          reason: args.reason,
        }),
  );
}

/** Priama konverzácia medzi adminom/koordinátorom a pracovníkom. */
export async function ensureDirectConversation(args: {
  eventId: string;
  userA: string;
  userB: string;
}): Promise<string> {
  const db = await getDb();
  const [existing] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.eventId, args.eventId),
        eq(conversations.type, "direct"),
        isNull(conversations.deletedAt),
        sql`(select count(*) from ${conversationMembers} cm where cm.conversation_id = ${conversations.id}) = 2`,
        sql`exists (select 1 from ${conversationMembers} cm where cm.conversation_id = ${conversations.id} and cm.user_id = ${args.userA})`,
        sql`exists (select 1 from ${conversationMembers} cm where cm.conversation_id = ${conversations.id} and cm.user_id = ${args.userB})`,
      ),
    )
    .limit(1);

  if (existing) return existing.id;

  const [created] = await db
    .insert(conversations)
    .values({ eventId: args.eventId, type: "direct", createdBy: args.userA })
    .returning({ id: conversations.id });

  await db.insert(conversationMembers).values([
    { conversationId: created.id, userId: args.userA, isAdmin: true },
    { conversationId: created.id, userId: args.userB },
  ]);

  return created.id;
}
