import "server-only";

import { headers } from "next/headers";
import { forbidden, redirect, unauthorized } from "next/navigation";

import {
  canAccessAdmin,
  canAccessPortal,
  can,
  isAdmin,
  type PermissionKey,
} from "@/lib/permissions";

import { getSession, type SessionContext } from "./session";

export class AuthorizationError extends Error {
  constructor(message = "Nemáte oprávnenie na túto akciu.") {
    super(message);
    this.name = "AuthorizationError";
  }
}

/** Prihlásený používateľ, inak redirect na login. */
export async function requireSession(returnTo?: string): Promise<SessionContext> {
  const session = await getSession();
  if (!session) {
    const target = returnTo ? `?next=${encodeURIComponent(returnTo)}` : "";
    redirect(`/brigada/prihlasenie${target}`);
  }
  return session;
}

/** Staff portál — iba schválený staff alebo admin (§6, Rule 4). */
export async function requireStaff(returnTo?: string): Promise<SessionContext> {
  const session = await requireSession(returnTo);
  if (!canAccessPortal(session.user)) redirect("/prihlaska/stav");
  if (session.user.status !== "active") redirect("/prihlaska/stav");
  return session;
}

/** Admin rozhranie — admin alebo koordinátor s aspoň jedným právom. */
export async function requireAdminAccess(): Promise<SessionContext> {
  const session = await requireSession("/admin");
  if (!canAccessAdmin(session.actor)) forbidden();
  return session;
}

/** Plné admin práva (schvaľovanie, nastavenia, role). */
export async function requireFullAdmin(): Promise<SessionContext> {
  const session = await requireSession("/admin");
  if (!isAdmin(session.actor) && session.actor.eventRole !== "admin") forbidden();
  return session;
}

export async function requirePermission(permission: PermissionKey): Promise<SessionContext> {
  const session = await requireSession("/admin");
  if (!can(session.actor, permission)) forbidden();
  return session;
}

/** Variant pre server actions / route handlery — vyhodí chybu namiesto redirectu. */
export async function assertPermission(permission: PermissionKey): Promise<SessionContext> {
  const session = await getSession();
  if (!session) throw new AuthorizationError("Nie ste prihlásený.");
  if (!can(session.actor, permission)) throw new AuthorizationError();
  return session;
}

export async function assertSession(): Promise<SessionContext> {
  const session = await getSession();
  if (!session) throw new AuthorizationError("Nie ste prihlásený.");
  return session;
}

export async function assertFullAdmin(): Promise<SessionContext> {
  const session = await assertSession();
  if (!isAdmin(session.actor) && session.actor.eventRole !== "admin") throw new AuthorizationError();
  return session;
}

export async function assertActiveEvent(): Promise<SessionContext & { eventId: string }> {
  const session = await assertSession();
  if (!session.eventId) throw new AuthorizationError("Nie je zvolený žiadny event.");
  return session as SessionContext & { eventId: string };
}

/**
 * CSRF: session cookie je `sameSite=lax`, čo blokuje cross-site POST z formulárov.
 * Navyše overujeme Origin proti Host — server actions aj fetch posielajú Origin.
 */
export async function assertSameOrigin(): Promise<void> {
  const hdrs = await headers();
  const origin = hdrs.get("origin");
  if (!origin) return; // same-origin navigácia bez Origin hlavičky (GET)

  const host = hdrs.get("x-forwarded-host") ?? hdrs.get("host");
  if (!host) throw new AuthorizationError("Neplatná požiadavka.");

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new AuthorizationError("Neplatný pôvod požiadavky.");
  }
  if (originHost !== host) throw new AuthorizationError("Neplatný pôvod požiadavky (CSRF).");
}

export async function clientIp(): Promise<string | null> {
  const hdrs = await headers();
  return hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? hdrs.get("x-real-ip") ?? null;
}
