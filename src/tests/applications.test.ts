import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { getDb } from "@/db/client";
import { applications, eventMembers, users } from "@/db/schema";
import { approveApplication, rejectApplication } from "@/lib/domain/applications";
import { brigadeApplicationSchema, stepExperienceSchema } from "@/lib/validation/application";
import { makeEvent, makeUser } from "./factories";

const validApplication = {
  firstName: "Martin",
  lastName: "Novák",
  email: "martin.novak@test.local",
  phone: "+421 900 123 456",
  birthYear: 2000,
  city: "Bratislava",
  password: "silne-heslo-42",
  experiences: [
    {
      positionLabel: "Barman",
      company: "Kaviareň Urban",
      workType: "bartender" as const,
      dateFrom: "2024-06-01",
      dateTo: "2025-05-31",
    },
  ],
  positions: ["bar" as const],
  days: [{ day: "2026-09-12", timeFrom: "10:00", timeTo: "22:00" }],
  answers: { english: true, night_shifts: true },
  gdpr: true as const,
  terms: true as const,
};

describe("validácia prihlášky brigádnika", () => {
  it("prijme kompletnú prihlášku", () => {
    expect(brigadeApplicationSchema.safeParse(validApplication).success).toBe(true);
  });

  it("vyžaduje aspoň jednu pracovnú skúsenosť", () => {
    const result = stepExperienceSchema.safeParse({ experiences: [] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain("aspoň jednu");
    }
  });

  it("odmietne prihlášku bez skúsenosti", () => {
    const result = brigadeApplicationSchema.safeParse({ ...validApplication, experiences: [] });
    expect(result.success).toBe(false);
  });

  it("odmietne neplatný e-mail", () => {
    const result = brigadeApplicationSchema.safeParse({ ...validApplication, email: "nie-email" });
    expect(result.success).toBe(false);
  });

  it("odmietne neplatné telefónne číslo", () => {
    const result = brigadeApplicationSchema.safeParse({ ...validApplication, phone: "123" });
    expect(result.success).toBe(false);
  });

  it("odmietne slabé heslo", () => {
    const result = brigadeApplicationSchema.safeParse({ ...validApplication, password: "kratke" });
    expect(result.success).toBe(false);
  });

  it("odmietne prihlášku bez GDPR súhlasu", () => {
    const result = brigadeApplicationSchema.safeParse({ ...validApplication, gdpr: false });
    expect(result.success).toBe(false);
  });

  it("odmietne uchádzača mladšieho ako 15 rokov", () => {
    const result = brigadeApplicationSchema.safeParse({
      ...validApplication,
      birthYear: new Date().getFullYear() - 10,
    });
    expect(result.success).toBe(false);
  });

  it("vyžaduje aspoň jednu preferovanú pozíciu", () => {
    const result = brigadeApplicationSchema.safeParse({ ...validApplication, positions: [] });
    expect(result.success).toBe(false);
  });

  it("odmietne skúsenosť, kde je koniec pred začiatkom", () => {
    const result = brigadeApplicationSchema.safeParse({
      ...validApplication,
      experiences: [{ ...validApplication.experiences[0], dateFrom: "2025-01-01", dateTo: "2024-01-01" }],
    });
    expect(result.success).toBe(false);
  });
});

describe("schvaľovanie prihlášok", () => {
  it("schválenie aktivuje staff účet a členstvo, ale nepridelí smenu (Rule 1)", async () => {
    const db = await getDb();
    const event = await makeEvent();
    const applicant = await makeUser({ globalRole: "applicant_volunteer", status: "pending" });
    const admin = await makeUser({ globalRole: "admin" });

    const [application] = await db
      .insert(applications)
      .values({ userId: applicant.id, eventId: event.id, status: "pending" })
      .returning();

    const result = await approveApplication({
      applicationId: application.id,
      eventId: event.id,
      actorId: admin.id,
    });
    expect(result).not.toBeNull();

    const [user] = await db.select().from(users).where(eq(users.id, applicant.id)).limit(1);
    expect(user.globalRole).toBe("staff");
    expect(user.status).toBe("active");

    const [membership] = await db
      .select()
      .from(eventMembers)
      .where(and(eq(eventMembers.userId, applicant.id), eq(eventMembers.eventId, event.id)))
      .limit(1);
    expect(membership.role).toBe("staff");
    expect(membership.active).toBe(true);

    // Rule 1: schválenie samo o sebe nevytvára pridelenie smeny.
    const assignments = await db.query.shiftAssignments.findMany({
      where: (row, { eq: is }) => is(row.userId, applicant.id),
    });
    expect(assignments).toHaveLength(0);
  });

  it("opakované schválenie nič nemení", async () => {
    const db = await getDb();
    const event = await makeEvent();
    const applicant = await makeUser({ globalRole: "applicant_volunteer", status: "pending" });
    const admin = await makeUser({ globalRole: "admin" });

    const [application] = await db
      .insert(applications)
      .values({ userId: applicant.id, eventId: event.id, status: "pending" })
      .returning();

    await approveApplication({ applicationId: application.id, eventId: event.id, actorId: admin.id });
    const second = await approveApplication({
      applicationId: application.id,
      eventId: event.id,
      actorId: admin.id,
    });
    expect(second).toBeNull();
  });

  it("zamietnutie deaktivuje členstvo, ale účet ostáva", async () => {
    const db = await getDb();
    const event = await makeEvent();
    const applicant = await makeUser({ globalRole: "applicant_volunteer", status: "pending" });
    const admin = await makeUser({ globalRole: "admin" });

    const [application] = await db
      .insert(applications)
      .values({ userId: applicant.id, eventId: event.id, status: "pending" })
      .returning();

    await approveApplication({ applicationId: application.id, eventId: event.id, actorId: admin.id });
    await rejectApplication({
      applicationId: application.id,
      eventId: event.id,
      actorId: admin.id,
      reason: "Kapacita naplnená",
    });

    const [membership] = await db
      .select()
      .from(eventMembers)
      .where(and(eq(eventMembers.userId, applicant.id), eq(eventMembers.eventId, event.id)))
      .limit(1);
    expect(membership.active).toBe(false);

    const [user] = await db.select().from(users).where(eq(users.id, applicant.id)).limit(1);
    expect(user).toBeDefined();
  });

  it("duplicitná prihláška na ten istý event neprejde", async () => {
    const db = await getDb();
    const event = await makeEvent();
    const applicant = await makeUser({ globalRole: "applicant_volunteer", status: "pending" });

    await db.insert(applications).values({ userId: applicant.id, eventId: event.id });
    await expect(
      db.insert(applications).values({ userId: applicant.id, eventId: event.id }),
    ).rejects.toThrow();
  });
});
