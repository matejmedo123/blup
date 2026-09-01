import "server-only";

import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import { cache } from "react";

import { getDb } from "@/db/client";
import { eventMembers, events, sessions, users } from "@/db/schema";
import type { EventPermissions } from "@/db/schema";
import type { Actor } from "@/lib/permissions";

import { generateToken, hashToken } from "./tokens";

export const SESSION_COOKIE = "crew_session";
export const EVENT_COOKIE = "crew_event";
const SESSION_TTL_DAYS = 30;
/** Cookie sa obnoví, keď zostáva menej než 25 dní — nie pri každom requeste. */
const SESSION_REFRESH_AFTER_DAYS = 5;

export type SessionUser = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  fullName: string;
  phone: string | null;
  city: string | null;
  avatarUrl: string | null;
  globalRole: (typeof users.$inferSelect)["globalRole"];
  status: (typeof users.$inferSelect)["status"];
  emailVerifiedAt: Date | null;
};

export type SessionContext = {
  user: SessionUser;
  sessionId: string;
  actor: Actor;
  eventId: string | null;
};

function expiryDate(days = SESSION_TTL_DAYS): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

export async function createSession(userId: string): Promise<string> {
  const db = await getDb();
  const token = generateToken(32);
  const hdrs = await headers();

  await db.insert(sessions).values({
    userId,
    tokenHash: hashToken(token),
    expiresAt: expiryDate(),
    ip: hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: hdrs.get("user-agent")?.slice(0, 500) ?? null,
  });

  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiryDate(),
  });

  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));
  return token;
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    const db = await getDb();
    await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
  }
  jar.delete(SESSION_COOKIE);
}

/** Odhlási všetky ostatné relácie používateľa (napr. po zmene hesla). */
export async function destroyAllSessions(userId: string): Promise<void> {
  const db = await getDb();
  await db.delete(sessions).where(eq(sessions.userId, userId));
}

/**
 * Aktívny event pre daného používateľa.
 * Priorita: cookie `crew_event` (ak k nemu má prístup) → jeho členstvo → prvý aktívny event.
 */
async function resolveEventId(userId: string): Promise<string | null> {
  const db = await getDb();
  const jar = await cookies();
  const requested = jar.get(EVENT_COOKIE)?.value;

  const memberships = await db
    .select({ eventId: eventMembers.eventId, role: eventMembers.role })
    .from(eventMembers)
    .innerJoin(events, eq(events.id, eventMembers.eventId))
    .where(and(eq(eventMembers.userId, userId), eq(eventMembers.active, true), isNull(events.deletedAt)));

  if (requested && memberships.some((m) => m.eventId === requested)) return requested;
  if (memberships.length > 0) return memberships[0].eventId;

  const [fallback] = await db
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.status, "active"), isNull(events.deletedAt)))
    .limit(1);
  return fallback?.id ?? null;
}

async function loadSession(): Promise<SessionContext | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const db = await getDb();
  const [row] = await db
    .select({
      sessionId: sessions.id,
      expiresAt: sessions.expiresAt,
      user: users,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date()), isNull(users.deletedAt)))
    .limit(1);

  if (!row) return null;
  if (row.user.status === "suspended") return null;

  const eventId = await resolveEventId(row.user.id);

  let eventRole: Actor["eventRole"] = null;
  let permissions: EventPermissions = {};
  if (eventId) {
    const [membership] = await db
      .select({ role: eventMembers.role, permissions: eventMembers.permissions })
      .from(eventMembers)
      .where(
        and(
          eq(eventMembers.userId, row.user.id),
          eq(eventMembers.eventId, eventId),
          eq(eventMembers.active, true),
        ),
      )
      .limit(1);
    if (membership) {
      eventRole = membership.role;
      permissions = membership.permissions ?? {};
    }
  }

  // Rolling session — predĺž len keď sa blíži expirácia.
  const remainingDays = (row.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
  if (remainingDays < SESSION_TTL_DAYS - SESSION_REFRESH_AFTER_DAYS) {
    await db.update(sessions).set({ expiresAt: expiryDate() }).where(eq(sessions.id, row.sessionId));
  }

  return {
    sessionId: row.sessionId,
    eventId,
    user: {
      id: row.user.id,
      email: row.user.email,
      firstName: row.user.firstName,
      lastName: row.user.lastName,
      fullName: `${row.user.firstName} ${row.user.lastName}`,
      phone: row.user.phone,
      city: row.user.city,
      avatarUrl: row.user.avatarUrl,
      globalRole: row.user.globalRole,
      status: row.user.status,
      emailVerifiedAt: row.user.emailVerifiedAt,
    },
    actor: {
      userId: row.user.id,
      globalRole: row.user.globalRole,
      eventRole,
      permissions,
    },
  };
}

/** Per-request memoizácia — jeden DB round-trip na render. */
export const getSession = cache(loadSession);

export async function setActiveEvent(eventId: string): Promise<void> {
  const jar = await cookies();
  jar.set(EVENT_COOKIE, eventId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
}

/** Upratovanie expirovaných relácií a tokenov (volané z cron skriptu). */
export async function pruneExpiredSessions(): Promise<number> {
  const db = await getDb();
  const result = await db.delete(sessions).where(sql`${sessions.expiresAt} < now()`);
  return (result as { rowCount?: number }).rowCount ?? 0;
}
