"use server";

import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { redirect } from "next/navigation";
import { z } from "zod";

import { getDb } from "@/db/client";
import { authTokens, users } from "@/db/schema";
import { failure, success, toActionResult, type ActionResult } from "@/lib/action-result";
import { assertSameOrigin, clientIp } from "@/lib/auth/guards";
import { fakeVerifyDelay, hashPassword, verifyPassword } from "@/lib/auth/password";
import {
  createSession,
  destroyAllSessions,
  destroySession,
  getSession,
} from "@/lib/auth/session";
import { generateToken, hashToken } from "@/lib/auth/tokens";
import { sendEmailSafely } from "@/lib/email/provider";
import { emailTemplates } from "@/lib/email/templates";
import { canAccessAdmin, canAccessPortal } from "@/lib/permissions";
import { enforceRateLimit } from "@/lib/rate-limit";
import { emailSchema, fieldErrors, passwordSchema } from "@/lib/validation/common";

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Zadaj heslo."),
  next: z.string().optional(),
});

/** Kam patrí používateľ po prihlásení — uchádzač nikdy nedostane portál (§6). */
export async function landingRouteForCurrentUser(): Promise<string> {
  const session = await getSession();
  if (!session) return "/brigada/prihlasenie";
  if (canAccessAdmin(session.actor)) return "/admin";
  if (canAccessPortal(session.user) && session.user.status === "active") return "/portal";
  return "/prihlaska/stav";
}

export async function login(payload: unknown): Promise<ActionResult<{ redirectTo: string }>> {
  try {
    await assertSameOrigin();
    const parsed = loginSchema.safeParse(payload);
    if (!parsed.success) {
      return failure("Skontroluj prihlasovacie údaje.", fieldErrors(parsed.error));
    }
    const { email, password, next } = parsed.data;

    const ip = await clientIp();
    const limit = await enforceRateLimit("login", `${ip ?? "?"}:${email}`);
    if (!limit.allowed) {
      return failure(
        `Príliš veľa pokusov o prihlásenie. Skús to znova o ${Math.ceil(limit.retryAfterSeconds / 60)} minút.`,
      );
    }

    const db = await getDb();
    const [user] = await db
      .select({
        id: users.id,
        passwordHash: users.passwordHash,
        status: users.status,
        globalRole: users.globalRole,
      })
      .from(users)
      .where(and(sql`lower(${users.email}) = ${email}`, isNull(users.deletedAt)))
      .limit(1);

    if (!user) {
      await fakeVerifyDelay();
      return failure("Nesprávny e-mail alebo heslo.");
    }
    if (!(await verifyPassword(password, user.passwordHash))) {
      return failure("Nesprávny e-mail alebo heslo.");
    }
    if (user.status === "suspended") {
      return failure("Tvoj účet je deaktivovaný. Ozvi sa prosím koordinátorovi.");
    }

    await createSession(user.id);

    const redirectTo =
      next && next.startsWith("/") && !next.startsWith("//")
        ? next
        : await landingRouteForCurrentUser();

    return success(undefined, { redirectTo });
  } catch (error) {
    return toActionResult(error, "Prihlásenie zlyhalo. Skús to prosím znova.");
  }
}

export async function logout(): Promise<void> {
  await assertSameOrigin();
  await destroySession();
  redirect("/");
}

/* -------------------------------------------------------- overenie e-mailu */

export async function verifyEmail(token: string): Promise<ActionResult> {
  try {
    const db = await getDb();
    const [row] = await db
      .select({ id: authTokens.id, userId: authTokens.userId })
      .from(authTokens)
      .where(
        and(
          eq(authTokens.tokenHash, hashToken(token)),
          eq(authTokens.kind, "email_verify"),
          isNull(authTokens.usedAt),
          gt(authTokens.expiresAt, new Date()),
        ),
      )
      .limit(1);

    if (!row) return failure("Odkaz je neplatný alebo mu vypršala platnosť.");

    await db.transaction(async (tx) => {
      await tx.update(authTokens).set({ usedAt: new Date() }).where(eq(authTokens.id, row.id));
      await tx
        .update(users)
        .set({ emailVerifiedAt: new Date(), updatedAt: new Date() })
        .where(eq(users.id, row.userId));
    });

    return success("E-mail je overený.");
  } catch (error) {
    return toActionResult(error, "Overenie e-mailu zlyhalo.");
  }
}

export async function resendVerificationEmail(): Promise<ActionResult> {
  try {
    await assertSameOrigin();
    const session = await getSession();
    if (!session) return failure("Nie si prihlásený.");
    if (session.user.emailVerifiedAt) return success("E-mail už je overený.");

    const limit = await enforceRateLimit("passwordReset", session.user.id);
    if (!limit.allowed) return failure("Overovací e-mail sme už poslali. Skontroluj si schránku.");

    const db = await getDb();
    const token = generateToken(32);
    await db.insert(authTokens).values({
      userId: session.user.id,
      kind: "email_verify",
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    void sendEmailSafely(
      emailTemplates.emailVerification({
        to: session.user.email,
        firstName: session.user.firstName,
        token,
      }),
    );
    return success("Overovací e-mail sme poslali znova.");
  } catch (error) {
    return toActionResult(error, "E-mail sa nepodarilo odoslať.");
  }
}

/* ------------------------------------------------------------ reset hesla */

export async function requestPasswordReset(payload: unknown): Promise<ActionResult> {
  try {
    await assertSameOrigin();
    const parsed = z.object({ email: emailSchema }).safeParse(payload);
    if (!parsed.success) return failure("Zadaj platný e-mail.", fieldErrors(parsed.error));

    const ip = await clientIp();
    const limit = await enforceRateLimit("passwordReset", `${ip ?? "?"}:${parsed.data.email}`);
    // Odpoveď je vždy rovnaká — nesmie prezradiť, či účet existuje.
    if (!limit.allowed) {
      return success("Ak účet s týmto e-mailom existuje, poslali sme naň odkaz na obnovu hesla.");
    }

    const db = await getDb();
    const [user] = await db
      .select({ id: users.id, firstName: users.firstName, email: users.email })
      .from(users)
      .where(and(sql`lower(${users.email}) = ${parsed.data.email}`, isNull(users.deletedAt)))
      .limit(1);

    if (user) {
      const token = generateToken(32);
      await db.insert(authTokens).values({
        userId: user.id,
        kind: "password_reset",
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });
      void sendEmailSafely(
        emailTemplates.passwordReset({ to: user.email, firstName: user.firstName, token }),
      );
    }

    return success("Ak účet s týmto e-mailom existuje, poslali sme naň odkaz na obnovu hesla.");
  } catch (error) {
    return toActionResult(error, "Požiadavku sa nepodarilo spracovať.");
  }
}

export async function resetPassword(payload: unknown): Promise<ActionResult> {
  try {
    await assertSameOrigin();
    const parsed = z
      .object({ token: z.string().min(10), password: passwordSchema })
      .safeParse(payload);
    if (!parsed.success) return failure("Skontroluj nové heslo.", fieldErrors(parsed.error));

    const db = await getDb();
    const [row] = await db
      .select({ id: authTokens.id, userId: authTokens.userId })
      .from(authTokens)
      .where(
        and(
          eq(authTokens.tokenHash, hashToken(parsed.data.token)),
          eq(authTokens.kind, "password_reset"),
          isNull(authTokens.usedAt),
          gt(authTokens.expiresAt, new Date()),
        ),
      )
      .limit(1);

    if (!row) return failure("Odkaz je neplatný alebo mu vypršala platnosť. Požiadaj o nový.");

    const passwordHash = await hashPassword(parsed.data.password);
    await db.transaction(async (tx) => {
      await tx.update(authTokens).set({ usedAt: new Date() }).where(eq(authTokens.id, row.id));
      await tx
        .update(users)
        .set({ passwordHash, updatedAt: new Date() })
        .where(eq(users.id, row.userId));
    });

    // Zmena hesla ukončí všetky existujúce relácie.
    await destroyAllSessions(row.userId);
    return success("Heslo je zmenené. Môžeš sa prihlásiť.");
  } catch (error) {
    return toActionResult(error, "Heslo sa nepodarilo zmeniť.");
  }
}
