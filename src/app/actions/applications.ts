"use server";

import { and, eq, sql } from "drizzle-orm";

import { getDb } from "@/db/client";
import {
  applicationAnswers,
  applicationPositions,
  applications,
  authTokens,
  availabilities,
  consents,
  experiences,
  users,
  vendorApplications,
  volunteerApplications,
} from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { assertSameOrigin, clientIp } from "@/lib/auth/guards";
import { createSession } from "@/lib/auth/session";
import { generateToken, hashToken } from "@/lib/auth/tokens";
import { failure, success, toActionResult, type ActionResult } from "@/lib/action-result";
import { emailTemplates } from "@/lib/email/templates";
import { sendEmailSafely } from "@/lib/email/provider";
import { getEventById, getPublicEvent } from "@/lib/domain/events";
import { ensureCrewScore } from "@/lib/domain/score";
import { enforceRateLimit } from "@/lib/rate-limit";
import { fieldErrors } from "@/lib/validation/common";
import {
  brigadeApplicationSchema,
  vendorApplicationSchema,
  volunteerApplicationSchema,
} from "@/lib/validation/application";

const CONSENT_VERSION = "2026-01";

/* ------------------------------------------------- brigádnik: registrácia */

export async function submitBrigadeApplication(payload: unknown): Promise<ActionResult<{ applicationId: string }>> {
  try {
    await assertSameOrigin();
    const ip = await clientIp();

    const limit = await enforceRateLimit("register", ip);
    if (!limit.allowed) {
      return failure(
        `Príliš veľa pokusov. Skús to znova o ${Math.ceil(limit.retryAfterSeconds / 60)} minút.`,
      );
    }

    const parsed = brigadeApplicationSchema.safeParse(payload);
    if (!parsed.success) {
      return failure("Skontroluj prosím vyplnené údaje.", fieldErrors(parsed.error));
    }
    const input = parsed.data;

    const event = input.eventId ? await getEventById(input.eventId) : await getPublicEvent();
    if (!event) return failure("Momentálne neprebieha nábor na žiadny event.");

    const db = await getDb();

    const [existingUser] = await db
      .select({ id: users.id, passwordHash: users.passwordHash, globalRole: users.globalRole })
      .from(users)
      .where(sql`lower(${users.email}) = ${input.email}`)
      .limit(1);

    // Účet s heslom už existuje — používateľ sa má prihlásiť, nie registrovať znova.
    if (existingUser?.passwordHash) {
      const [existingApplication] = await db
        .select({ id: applications.id })
        .from(applications)
        .where(and(eq(applications.userId, existingUser.id), eq(applications.eventId, event.id)))
        .limit(1);
      if (existingApplication) {
        return failure(
          "Na tento event už prihlášku máš. Prihlás sa a stav nájdeš vo svojom profile.",
          { email: ["Prihláška s týmto e-mailom už existuje."] },
        );
      }
      return failure("Účet s týmto e-mailom už existuje. Prihlás sa prosím.", {
        email: ["Účet s týmto e-mailom už existuje."],
      });
    }

    const passwordHash = await hashPassword(input.password);
    const applicationId = await db.transaction(async (tx) => {
      let userId = existingUser?.id;

      if (userId) {
        await tx
          .update(users)
          .set({
            passwordHash,
            firstName: input.firstName,
            lastName: input.lastName,
            phone: input.phone,
            city: input.city,
            birthYear: input.birthYear,
            avatarUrl: input.avatarUrl || null,
            globalRole: "applicant_volunteer",
            status: "pending",
            updatedAt: new Date(),
          })
          .where(eq(users.id, userId));
      } else {
        const [created] = await tx
          .insert(users)
          .values({
            email: input.email,
            passwordHash,
            firstName: input.firstName,
            lastName: input.lastName,
            phone: input.phone,
            city: input.city,
            birthYear: input.birthYear,
            avatarUrl: input.avatarUrl || null,
            // Uchádzač nedostáva rolu `staff` — tú pridelí až schválenie (Rule 1).
            globalRole: "applicant_volunteer",
            status: "pending",
          })
          .returning({ id: users.id });
        userId = created.id;
      }

      const [application] = await tx
        .insert(applications)
        .values({
          userId,
          eventId: event.id,
          status: "pending",
          motivation: input.motivation ?? null,
          source: "web",
        })
        .returning({ id: applications.id });

      await tx.insert(experiences).values(
        input.experiences.map((exp) => ({
          userId,
          positionLabel: exp.positionLabel,
          company: exp.company,
          workType: exp.workType,
          dateFrom: exp.dateFrom,
          dateTo: exp.dateTo || null,
          description: exp.description ?? null,
        })),
      );

      await tx.insert(applicationPositions).values(
        input.positions.map((positionKey) => ({ applicationId: application.id, positionKey })),
      );

      const answerRows = Object.entries(input.answers).map(([questionKey, value]) => ({
        applicationId: application.id,
        questionKey,
        answerBool: value,
      }));
      if (answerRows.length > 0) await tx.insert(applicationAnswers).values(answerRows);

      await tx.insert(availabilities).values(
        input.days.map((day) => ({
          userId,
          eventId: event.id,
          day: day.day,
          timeFrom: day.timeFrom,
          timeTo: day.timeTo,
          maxHours: input.maxHours ?? null,
          note: input.note ?? null,
        })),
      );

      await tx.insert(consents).values([
        { userId, email: input.email, kind: "gdpr", textVersion: CONSENT_VERSION, ip },
        { userId, email: input.email, kind: "terms", textVersion: CONSENT_VERSION, ip },
      ]);

      await ensureCrewScore(userId, event.id, tx);

      const verifyToken = generateToken(32);
      await tx.insert(authTokens).values({
        userId,
        kind: "email_verify",
        tokenHash: hashToken(verifyToken),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });

      void sendEmailSafely(
        emailTemplates.emailVerification({
          to: input.email,
          firstName: input.firstName,
          token: verifyToken,
        }),
      );

      return application.id;
    });

    void sendEmailSafely(
      emailTemplates.applicationReceived({
        to: input.email,
        firstName: input.firstName,
        eventName: event.name,
      }),
    );

    // Prihlásime ho, ale prístup do /portal ostáva zamknutý až do schválenia.
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${input.email}`)
      .limit(1);
    if (user) await createSession(user.id);

    return success("Prihlášku sme prijali.", { applicationId });
  } catch (error) {
    return toActionResult(error, "Prihlášku sa nepodarilo odoslať. Skús to prosím znova.");
  }
}

/* ------------------------------------------------------------ dobrovoľník */

export async function submitVolunteerApplication(payload: unknown): Promise<ActionResult> {
  try {
    await assertSameOrigin();
    const ip = await clientIp();

    const limit = await enforceRateLimit("publicForm", ip);
    if (!limit.allowed) return failure("Príliš veľa odoslaní. Skús to prosím neskôr.");

    const parsed = volunteerApplicationSchema.safeParse(payload);
    if (!parsed.success) {
      return failure("Skontroluj prosím vyplnené údaje.", fieldErrors(parsed.error));
    }
    const input = parsed.data;

    const event = input.eventId ? await getEventById(input.eventId) : await getPublicEvent();
    if (!event) return failure("Momentálne neprebieha nábor dobrovoľníkov.");

    const db = await getDb();
    const [duplicate] = await db
      .select({ id: volunteerApplications.id })
      .from(volunteerApplications)
      .where(
        and(
          eq(volunteerApplications.eventId, event.id),
          sql`lower(${volunteerApplications.email}) = ${input.email}`,
        ),
      )
      .limit(1);
    if (duplicate) {
      return failure("S týmto e-mailom už prihlášku evidujeme. Ozveme sa ti.", {
        email: ["Prihláška s týmto e-mailom už existuje."],
      });
    }

    await db.insert(volunteerApplications).values({
      eventId: event.id,
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email,
      phone: input.phone,
      city: input.city || null,
      birthYear: input.birthYear ?? null,
      preferences: input.preferences,
      availability: input.availability,
      note: input.note ?? null,
      status: "pending",
    });

    await db.insert(consents).values({
      email: input.email,
      kind: "gdpr",
      textVersion: CONSENT_VERSION,
      ip,
    });

    void sendEmailSafely(
      emailTemplates.applicationReceived({
        to: input.email,
        firstName: input.firstName,
        eventName: event.name,
      }),
    );

    return success("Prihlášku sme prijali.");
  } catch (error) {
    return toActionResult(error, "Prihlášku sa nepodarilo odoslať. Skús to prosím znova.");
  }
}

/* --------------------------------------------------------------- stánkar */

export async function submitVendorApplication(payload: unknown): Promise<ActionResult> {
  try {
    await assertSameOrigin();
    const ip = await clientIp();

    const limit = await enforceRateLimit("publicForm", ip);
    if (!limit.allowed) return failure("Príliš veľa odoslaní. Skús to prosím neskôr.");

    const parsed = vendorApplicationSchema.safeParse(payload);
    if (!parsed.success) {
      return failure("Skontroluj prosím vyplnené údaje.", fieldErrors(parsed.error));
    }
    const input = parsed.data;

    const event = input.eventId ? await getEventById(input.eventId) : await getPublicEvent();
    if (!event) return failure("Momentálne neprijímame prihlášky stánkarov.");

    const db = await getDb();
    const [duplicate] = await db
      .select({ id: vendorApplications.id })
      .from(vendorApplications)
      .where(
        and(
          eq(vendorApplications.eventId, event.id),
          sql`lower(${vendorApplications.email}) = ${input.email}`,
        ),
      )
      .limit(1);
    if (duplicate) {
      return failure("S týmto e-mailom už prihlášku evidujeme. Ozveme sa ti.", {
        email: ["Prihláška s týmto e-mailom už existuje."],
      });
    }

    await db.insert(vendorApplications).values({
      eventId: event.id,
      contactName: input.contactName,
      companyName: input.companyName || null,
      ico: input.ico || null,
      email: input.email,
      phone: input.phone,
      website: input.website || null,
      instagram: input.instagram || null,
      facebook: input.facebook || null,
      standType: input.standType,
      assortment: input.assortment,
      assortmentDetail: input.assortmentDetail ?? null,
      widthM: String(input.widthM),
      depthM: String(input.depthM),
      needsElectricity: input.needsElectricity,
      powerKw: input.powerKw != null ? String(input.powerKw) : null,
      needsWater: input.needsWater,
      needsWaste: input.needsWaste,
      placementRequest: input.placementRequest ?? null,
      note: input.note ?? null,
      attachments: input.attachments ?? [],
      status: "pending",
    });

    await db.insert(consents).values({
      email: input.email,
      kind: "gdpr",
      textVersion: CONSENT_VERSION,
      ip,
    });

    void sendEmailSafely(
      emailTemplates.applicationReceived({
        to: input.email,
        firstName: input.contactName.split(" ")[0],
        eventName: event.name,
      }),
    );

    return success("Prihlášku sme prijali.");
  } catch (error) {
    return toActionResult(error, "Prihlášku sa nepodarilo odoslať. Skús to prosím znova.");
  }
}
