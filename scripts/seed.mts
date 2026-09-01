/**
 * Seed pre vývoj a demo (§49).
 * Vytvorí jeden event, pozície, crew, smeny, dochádzku, správy, hodnotenia
 * a notifikácie tak, aby bolo vidieť celý tok od prihlášky po výplatu.
 *
 * Prihlasovacie údaje sa berú z premenných prostredia — nie sú v kóde.
 *   SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD
 *   SEED_STAFF_PASSWORD
 */
import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import * as schema from "../src/db/schema";
import { hashPassword } from "../src/lib/auth/password";
import { generateToken, signShiftQr } from "../src/lib/auth/tokens";
import { DEFAULT_SCORE_RULES } from "../src/lib/domain/score";
import { COORDINATOR_DEFAULT_PERMISSIONS } from "../src/lib/permissions";

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? "admin@crew.local";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "crew-admin-2026";
const STAFF_PASSWORD = process.env.SEED_STAFF_PASSWORD ?? "crew-staff-2026";

if (process.env.NODE_ENV === "production" && !process.env.SEED_ADMIN_PASSWORD) {
  throw new Error("V produkcii musíš nastaviť SEED_ADMIN_PASSWORD.");
}

/* --------------------------------------------------------------- pripojenie */

async function connect() {
  const url = process.env.DATABASE_URL;
  if (url && /^postgres(ql)?:\/\//.test(url)) {
    const { Pool } = await import("pg");
    const { drizzle: drizzleNode } = await import("drizzle-orm/node-postgres");
    const pool = new Pool({ connectionString: url });
    return {
      db: drizzleNode(pool, { schema, casing: "snake_case" }) as unknown as NodePgDatabase<
        typeof schema
      >,
      close: () => pool.end(),
    };
  }
  const client = await PGlite.create(process.env.PGLITE_DATA_DIR ?? ".pglite");
  return {
    db: drizzle(client, { schema, casing: "snake_case" }) as unknown as NodePgDatabase<
      typeof schema
    >,
    close: () => client.close(),
  };
}

const { db, close } = await connect();

/* ------------------------------------------------------------------ pomôcky */

const DAY = 86_400_000;
const HOUR = 3_600_000;

function at(dayOffset: number, hour: number, minute = 0): Date {
  const base = new Date();
  base.setHours(0, 0, 0, 0);
  return new Date(base.getTime() + dayOffset * DAY + hour * HOUR + minute * 60_000);
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function pick<T>(items: readonly T[], index: number): T {
  return items[index % items.length];
}

/* -------------------------------------------------------------------- event */

console.log("→ event");

const eventStart = at(-1, 0);
const eventEnd = at(3, 0);

await db.delete(schema.events).where(eq(schema.events.slug, "grape-2026"));

const [event] = await db
  .insert(schema.events)
  .values({
    name: "Grape Festival 2026",
    slug: "grape-2026",
    description: "Dvojdňový festival v areáli letiska Piešťany. Crew: bar, vstupy, produkcia.",
    location: "Letisko Piešťany",
    lat: "48.625000",
    lng: "17.828000",
    startDate: isoDay(eventStart),
    endDate: isoDay(eventEnd),
    timezone: "Europe/Bratislava",
    status: "active",
    settings: {
      currency: "EUR",
      rounding: "5min",
      overtime_after_hours: 10,
      overtime_multiplier: 1.25,
      default_geofence_radius_m: 200,
      reminder_hours_before: 24,
    },
  })
  .returning();

await db
  .insert(schema.scoreRules)
  .values(DEFAULT_SCORE_RULES.map((rule) => ({ ...rule, eventId: event.id })));

/* ------------------------------------------------------------------ ľudia */

console.log("→ používatelia");

const adminHash = await hashPassword(ADMIN_PASSWORD);
const staffHash = await hashPassword(STAFF_PASSWORD);

async function upsertUser(input: {
  email: string;
  firstName: string;
  lastName: string;
  city: string;
  phone: string;
  birthYear: number;
  role: "admin" | "staff" | "applicant_volunteer";
  status: "active" | "pending";
  hash: string;
}) {
  const [existing] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(sql`lower(${schema.users.email}) = ${input.email.toLowerCase()}`)
    .limit(1);

  if (existing) {
    await db
      .update(schema.users)
      .set({
        passwordHash: input.hash,
        firstName: input.firstName,
        lastName: input.lastName,
        city: input.city,
        phone: input.phone,
        birthYear: input.birthYear,
        globalRole: input.role,
        status: input.status,
        emailVerifiedAt: new Date(),
      })
      .where(eq(schema.users.id, existing.id));
    return existing.id;
  }

  const [created] = await db
    .insert(schema.users)
    .values({
      email: input.email,
      passwordHash: input.hash,
      firstName: input.firstName,
      lastName: input.lastName,
      city: input.city,
      phone: input.phone,
      birthYear: input.birthYear,
      globalRole: input.role,
      status: input.status,
      emailVerifiedAt: new Date(),
    })
    .returning({ id: schema.users.id });
  return created.id;
}

const adminId = await upsertUser({
  email: ADMIN_EMAIL,
  firstName: "Eva",
  lastName: "Krajčírová",
  city: "Bratislava",
  phone: "+421 903 111 222",
  birthYear: 1992,
  role: "admin",
  status: "active",
  hash: adminHash,
});

const COORDINATORS = [
  { email: "peter@crew.local", firstName: "Peter", lastName: "Varga", city: "Trnava", birthYear: 1994 },
  { email: "lucia@crew.local", firstName: "Lucia", lastName: "Bartošová", city: "Bratislava", birthYear: 1996 },
];

const coordinatorIds: string[] = [];
for (const [index, person] of COORDINATORS.entries()) {
  const id = await upsertUser({
    ...person,
    phone: `+421 905 ${200 + index}00 ${100 + index}`,
    role: "staff",
    status: "active",
    hash: staffHash,
  });
  coordinatorIds.push(id);
}

const STAFF = [
  { email: "martin@crew.local", firstName: "Martin", lastName: "Novák", city: "Bratislava", birthYear: 2000 },
  { email: "zuzana@crew.local", firstName: "Zuzana", lastName: "Horváthová", city: "Nitra", birthYear: 2001 },
  { email: "tomas@crew.local", firstName: "Tomáš", lastName: "Kováč", city: "Trenčín", birthYear: 1999 },
  { email: "ema@crew.local", firstName: "Ema", lastName: "Dubová", city: "Košice", birthYear: 2002 },
  { email: "jakub@crew.local", firstName: "Jakub", lastName: "Slovák", city: "Bratislava", birthYear: 1998 },
  { email: "klara@crew.local", firstName: "Klára", lastName: "Mikulová", city: "Nitra", birthYear: 2003 },
  { email: "roman@crew.local", firstName: "Roman", lastName: "Hlaváč", city: "Žilina", birthYear: 1997 },
  { email: "nina@crew.local", firstName: "Nina", lastName: "Bieliková", city: "Banská Bystrica", birthYear: 2001 },
  { email: "adam@crew.local", firstName: "Adam", lastName: "Šimko", city: "Trnava", birthYear: 2000 },
  { email: "sara@crew.local", firstName: "Sára", lastName: "Polláková", city: "Bratislava", birthYear: 2002 },
];

const staffIds: string[] = [];
for (const [index, person] of STAFF.entries()) {
  const id = await upsertUser({
    ...person,
    phone: `+421 90${index} 123 45${index}`,
    role: "staff",
    status: "active",
    hash: staffHash,
  });
  staffIds.push(id);
}

const APPLICANTS = [
  { email: "uchadzac1@crew.local", firstName: "Michal", lastName: "Bartek", city: "Prešov", birthYear: 2003 },
  { email: "uchadzac2@crew.local", firstName: "Veronika", lastName: "Danková", city: "Bratislava", birthYear: 2004 },
  { email: "uchadzac3@crew.local", firstName: "Filip", lastName: "Urban", city: "Martin", birthYear: 2001 },
  { email: "uchadzac4@crew.local", firstName: "Barbora", lastName: "Lieskovská", city: "Zvolen", birthYear: 2002 },
  { email: "uchadzac5@crew.local", firstName: "Oliver", lastName: "Rusnák", city: "Poprad", birthYear: 2000 },
];

const applicantIds: string[] = [];
for (const [index, person] of APPLICANTS.entries()) {
  const id = await upsertUser({
    ...person,
    phone: `+421 91${index} 987 65${index}`,
    role: "applicant_volunteer",
    status: "pending",
    hash: staffHash,
  });
  applicantIds.push(id);
}

/* -------------------------------------------------------------- členstvá */

console.log("→ členstvá a skóre");

await db.insert(schema.eventMembers).values([
  { userId: adminId, eventId: event.id, role: "admin", permissions: {} },
  ...coordinatorIds.map((userId) => ({
    userId,
    eventId: event.id,
    role: "coordinator" as const,
    permissions: COORDINATOR_DEFAULT_PERMISSIONS,
  })),
  ...staffIds.map((userId) => ({
    userId,
    eventId: event.id,
    role: "staff" as const,
    permissions: {},
  })),
]);

const SCORES = [92, 88, 85, 71, 96, 78, 64, 90, 83, 74];
await db.insert(schema.crewScores).values([
  ...coordinatorIds.map((userId) => ({ userId, eventId: event.id, score: 95 })),
  ...staffIds.map((userId, index) => ({ userId, eventId: event.id, score: pick(SCORES, index) })),
]);

/* -------------------------------------------------------------- pozície */

console.log("→ pozície");

const POSITIONS = [
  { name: "Bar", slug: "bar", rate: "8.50", capacity: 10, color: "#111111", skills: ["výčap"] },
  { name: "Vstupy", slug: "vstupy", rate: "7.50", capacity: 6, color: "#3A7CB0", skills: [] },
  { name: "Runner", slug: "runner", rate: "8.00", capacity: 4, color: "#5C9E2E", skills: [] },
  { name: "Security", slug: "security", rate: "10.00", capacity: 8, color: "#8C2F26", skills: ["preukaz SBS"] },
  { name: "Garderoba", slug: "garderoba", rate: "7.50", capacity: 5, color: "#D08A16", skills: [] },
  { name: "Produkcia", slug: "produkcia", rate: "9.00", capacity: 4, color: "#6B6B66", skills: [] },
  { name: "Stánky", slug: "stanky", rate: "8.00", capacity: 9, color: "#9DBF52", skills: [] },
  { name: "Upratovanie", slug: "upratovanie", rate: "7.00", capacity: 6, color: "#9A9A93", skills: [] },
  { name: "Hospitality", slug: "hospitality", rate: "9.50", capacity: 3, color: "#1F4E75", skills: ["angličtina"] },
  { name: "Stage", slug: "stage", rate: "9.50", capacity: 4, color: "#3E6B1F", skills: [] },
];

const positionRows = await db
  .insert(schema.positions)
  .values(
    POSITIONS.map((position) => ({
      eventId: event.id,
      name: position.name,
      slug: position.slug,
      description: `${position.name} — práca na evente ${event.name}.`,
      hourlyRate: position.rate,
      capacity: position.capacity,
      color: position.color,
      requiredSkills: position.skills,
    })),
  )
  .returning({ id: schema.positions.id, name: schema.positions.name, slug: schema.positions.slug });

const positionBySlug = new Map(positionRows.map((row) => [row.slug, row]));

/* ------------------------------------------------------------ prihlášky */

console.log("→ prihlášky");

const APPLICATION_STATUSES = ["pending", "pending", "reviewing", "waitlist", "rejected"] as const;

for (const [index, userId] of applicantIds.entries()) {
  const [application] = await db
    .insert(schema.applications)
    .values({
      userId,
      eventId: event.id,
      status: APPLICATION_STATUSES[index],
      motivation: "Chcem si privyrobiť a byť pri tom, ako event vzniká.",
      source: "web",
      ...(APPLICATION_STATUSES[index] === "rejected"
        ? { rejectionReason: "Kapacita na tejto pozícii je naplnená.", reviewedBy: adminId, reviewedAt: new Date() }
        : {}),
    })
    .returning({ id: schema.applications.id });

  await db.insert(schema.experiences).values({
    userId,
    positionLabel: pick(["Barman", "Čašník", "Pomocné práce", "Vstupy"], index),
    company: pick(["Kaviareň Urban", "Pohoda Festival", "Reštaurácia Modrá", "Uni Klub"], index),
    workType: pick(["bartender", "waiter", "helper", "ticketing"], index),
    dateFrom: "2024-06-01",
    dateTo: index % 2 === 0 ? "2025-09-30" : null,
    description: "Obsluha zákazníkov, príprava prevádzky, upratovanie po smene.",
  });

  await db.insert(schema.applicationPositions).values(
    pick(
      [
        ["bar", "helper"],
        ["ticketing", "registration"],
        ["runner", "production"],
        ["cleaning", "helper"],
      ],
      index,
    ).map((positionKey) => ({ applicationId: application.id, positionKey })),
  );

  await db.insert(schema.applicationAnswers).values(
    [
      { key: "driving_licence", value: index % 2 === 0 },
      { key: "english", value: true },
      { key: "german", value: index % 3 === 0 },
      { key: "event_experience", value: index % 2 === 1 },
      { key: "night_shifts", value: true },
      { key: "own_transport", value: index % 3 !== 0 },
    ].map((answer) => ({
      applicationId: application.id,
      questionKey: answer.key,
      answerBool: answer.value,
    })),
  );

  await db.insert(schema.availabilities).values(
    [0, 1, 2].map((offset) => ({
      userId,
      eventId: event.id,
      day: isoDay(at(offset, 12)),
      timeFrom: "10:00",
      timeTo: "23:59",
      maxHours: 30,
    })),
  );

  await db.insert(schema.consents).values([
    { userId, kind: "gdpr", textVersion: "2026-01" },
    { userId, kind: "terms", textVersion: "2026-01" },
  ]);
}

// Dostupnosť a skúsenosti aj pre už schválenú crew — bez nich by auto-prideľovanie nemalo z čoho vyberať.
for (const [index, userId] of staffIds.entries()) {
  await db.insert(schema.availabilities).values(
    [-1, 0, 1, 2].map((offset) => ({
      userId,
      eventId: event.id,
      day: isoDay(at(offset, 12)),
      timeFrom: "08:00",
      timeTo: "23:59",
      maxHours: 40,
    })),
  );
  await db.insert(schema.experiences).values({
    userId,
    positionLabel: pick(["Barman", "Vstupy", "Runner", "Security", "Garderoba"], index),
    company: pick(["Grape 2025", "Pohoda 2025", "Uprising", "Lovestream"], index),
    workType: pick(["bartender", "ticketing", "runner", "security", "helper"], index),
    dateFrom: "2025-07-01",
    dateTo: "2025-08-31",
  });

  const [application] = await db
    .insert(schema.applications)
    .values({
      userId,
      eventId: event.id,
      status: "approved",
      reviewedBy: adminId,
      reviewedAt: new Date(Date.now() - 5 * DAY),
      source: "web",
    })
    .returning({ id: schema.applications.id });

  await db.insert(schema.applicationPositions).values(
    pick(
      [
        ["bar", "helper"],
        ["ticketing"],
        ["runner", "production"],
        ["security"],
        ["cleaning", "helper"],
      ],
      index,
    ).map((positionKey) => ({ applicationId: application.id, positionKey })),
  );
}

/* ----------------------------------------------------- dobrovoľníci a stánky */

console.log("→ dobrovoľníci a stánkari");

await db.insert(schema.volunteerApplications).values([
  {
    eventId: event.id,
    firstName: "Katarína",
    lastName: "Vargová",
    email: "katka@example.sk",
    phone: "+421 907 555 111",
    city: "Piešťany",
    birthYear: 2004,
    preferences: ["guest_help", "waste"],
    availability: [{ day: isoDay(at(0, 12)), from: "10:00", to: "18:00" }],
    note: "Môžem prísť aj skôr na prípravu.",
    status: "pending",
  },
  {
    eventId: event.id,
    firstName: "Dominik",
    lastName: "Hrivnák",
    email: "dominik@example.sk",
    phone: "+421 908 555 222",
    city: "Trnava",
    birthYear: 2003,
    preferences: ["build", "backstage"],
    availability: [
      { day: isoDay(at(-1, 12)), from: "08:00", to: "20:00" },
      { day: isoDay(at(0, 12)), from: "08:00", to: "20:00" },
    ],
    status: "approved",
    reviewedBy: adminId,
    reviewedAt: new Date(),
  },
]);

await db.insert(schema.vendorApplications).values([
  {
    eventId: event.id,
    contactName: "Jana Kollárová",
    companyName: "Bistro Zelená",
    ico: "51234567",
    email: "jana@bistrozelena.sk",
    phone: "+421 911 222 333",
    website: "https://bistrozelena.sk",
    instagram: "@bistrozelena",
    standType: "food_truck",
    assortment: ["food", "drinks"],
    assortmentDetail: "Vegetariánske burgery, hranolky, domáca limonáda.",
    widthM: "4.00",
    depthM: "2.50",
    needsElectricity: true,
    powerKw: "6.00",
    needsWater: true,
    needsWaste: true,
    placementRequest: "Radi by sme boli blízko food zóny.",
    status: "approved",
    reviewedBy: adminId,
    reviewedAt: new Date(),
  },
  {
    eventId: event.id,
    contactName: "Tomáš Bezák",
    companyName: "Handmade Drevo",
    email: "tomas@handmadedrevo.sk",
    phone: "+421 912 333 444",
    standType: "stand",
    assortment: ["handmade", "crafts"],
    assortmentDetail: "Drevené šperky a doplnky.",
    widthM: "3.00",
    depthM: "2.00",
    needsElectricity: false,
    needsWater: false,
    needsWaste: false,
    status: "pending",
  },
]);

/* ------------------------------------------------------------------ smeny */

console.log("→ smeny a pridelenia");

type ShiftPlan = {
  slug: string;
  dayOffset: number;
  from: number;
  to: number;
  capacity: number;
  location: string;
  status: "published" | "completed" | "in_progress";
  coordinator: number;
};

const SHIFT_PLANS: ShiftPlan[] = [
  { slug: "produkcia", dayOffset: -1, from: 8, to: 16, capacity: 3, location: "Produkčný stan", status: "completed", coordinator: 0 },
  { slug: "stage", dayOffset: -1, from: 10, to: 18, capacity: 3, location: "Hlavná scéna", status: "completed", coordinator: 1 },
  { slug: "bar", dayOffset: -1, from: 17, to: 23, capacity: 4, location: "Bar pri scéne", status: "completed", coordinator: 0 },
  { slug: "vstupy", dayOffset: 0, from: 10, to: 18, capacity: 4, location: "Brána A", status: "in_progress", coordinator: 1 },
  { slug: "bar", dayOffset: 0, from: 14, to: 22, capacity: 4, location: "Bar pri scéne", status: "in_progress", coordinator: 0 },
  { slug: "garderoba", dayOffset: 0, from: 16, to: 23, capacity: 3, location: "Vstup B", status: "published", coordinator: 1 },
  { slug: "runner", dayOffset: 0, from: 12, to: 20, capacity: 2, location: "Areál", status: "published", coordinator: 0 },
  { slug: "security", dayOffset: 0, from: 18, to: 23, capacity: 4, location: "Brána A", status: "published", coordinator: 1 },
  { slug: "bar", dayOffset: 1, from: 16, to: 23, capacity: 5, location: "Bar pri scéne", status: "published", coordinator: 0 },
  { slug: "vstupy", dayOffset: 1, from: 10, to: 18, capacity: 4, location: "Brána A", status: "published", coordinator: 1 },
  { slug: "stanky", dayOffset: 1, from: 11, to: 20, capacity: 4, location: "Food zóna", status: "published", coordinator: 0 },
  { slug: "hospitality", dayOffset: 1, from: 12, to: 20, capacity: 2, location: "Backstage", status: "published", coordinator: 1 },
  { slug: "upratovanie", dayOffset: 2, from: 8, to: 14, capacity: 4, location: "Areál", status: "published", coordinator: 0 },
  { slug: "produkcia", dayOffset: 2, from: 9, to: 17, capacity: 3, location: "Produkčný stan", status: "published", coordinator: 1 },
  { slug: "security", dayOffset: 2, from: 10, to: 18, capacity: 3, location: "Brána A", status: "published", coordinator: 0 },
];

const shiftIds: { id: string; plan: ShiftPlan; startsAt: Date; endsAt: Date }[] = [];

for (const plan of SHIFT_PLANS) {
  const position = positionBySlug.get(plan.slug);
  if (!position) continue;

  const startsAt = at(plan.dayOffset, plan.from);
  const endsAt = at(plan.dayOffset, plan.to);

  const [shift] = await db
    .insert(schema.shifts)
    .values({
      eventId: event.id,
      positionId: position.id,
      startsAt,
      endsAt,
      location: plan.location,
      lat: "48.625000",
      lng: "17.828000",
      capacity: plan.capacity,
      status: plan.status,
      checkInMethod: plan.slug === "bar" ? "qr" : "manual",
      geofenceRadiusM: 200,
      qrSecret: generateToken(16),
      coordinatorId: coordinatorIds[plan.coordinator],
      instructions:
        "Príchod 15 minút pred začiatkom, hlás sa koordinátorovi. Vodu a jedlo máš v crew zóne.",
      dressCode: "Čierne tričko, čierne nohavice, pohodlná obuv",
    })
    .returning({ id: schema.shifts.id });

  shiftIds.push({ id: shift.id, plan, startsAt, endsAt });
}

/* ------------------------------------------------ pridelenia a dochádzka */

let staffCursor = 0;
const now = new Date();

for (const shift of shiftIds) {
  // Poslednú smenu necháme čiastočne obsadenú, nech je vidieť alert na dashboarde.
  const fill = shift.plan.status === "published" && shift.plan.slug === "garderoba"
    ? Math.max(1, shift.plan.capacity - 2)
    : shift.plan.capacity;

  for (let i = 0; i < fill; i += 1) {
    const userId = staffIds[staffCursor % staffIds.length];
    staffCursor += 1;

    const past = shift.endsAt.getTime() < now.getTime();
    const running = shift.startsAt.getTime() <= now.getTime() && !past;

    const [assignment] = await db
      .insert(schema.shiftAssignments)
      .values({
        shiftId: shift.id,
        userId,
        eventId: event.id,
        status: past || running ? "confirmed" : i === 0 ? "pending_confirmation" : "confirmed",
        assignedBy: adminId,
        confirmedAt: past || running || i > 0 ? new Date(shift.startsAt.getTime() - 2 * DAY) : null,
      })
      .onConflictDoNothing()
      .returning({ id: schema.shiftAssignments.id });

    if (!assignment) continue;

    if (past) {
      // Jeden človek na prvej smene neprišiel — nech je vidieť no-show aj incident.
      const noShow = shift.plan.slug === "produkcia" && i === 2;
      if (noShow) {
        await db.insert(schema.attendance).values({
          assignmentId: assignment.id,
          shiftId: shift.id,
          userId,
          eventId: event.id,
          status: "missing",
          workedMinutes: 0,
        });
        continue;
      }

      const lateMinutes = i === 1 ? 14 : 0;
      const checkInAt = new Date(shift.startsAt.getTime() + lateMinutes * 60_000);
      const checkOutAt = new Date(shift.endsAt.getTime() + 5 * 60_000);
      const workedMinutes = Math.round((checkOutAt.getTime() - checkInAt.getTime()) / 60_000);

      await db.insert(schema.attendance).values({
        assignmentId: assignment.id,
        shiftId: shift.id,
        userId,
        eventId: event.id,
        status: lateMinutes > 10 ? "late" : "checked_out",
        checkInAt,
        checkOutAt,
        checkInSource: "self",
        checkOutSource: "self",
        checkInBy: userId,
        checkOutBy: userId,
        lateMinutes,
        workedMinutes,
        approved: true,
        approvedBy: adminId,
        approvedAt: new Date(),
      });

      await db
        .update(schema.shiftAssignments)
        .set({ status: "completed" })
        .where(eq(schema.shiftAssignments.id, assignment.id));
    } else if (running && i < fill - 1) {
      const checkInAt = new Date(shift.startsAt.getTime() + i * 3 * 60_000);
      await db.insert(schema.attendance).values({
        assignmentId: assignment.id,
        shiftId: shift.id,
        userId,
        eventId: event.id,
        status: "checked_in",
        checkInAt,
        checkInSource: "self",
        checkInBy: userId,
      });
    }
  }
}

/* ------------------------------------------------------ správy a chat */

console.log("→ správy");

const barShift = shiftIds.find((s) => s.plan.slug === "bar" && s.plan.dayOffset === 1);
if (barShift) {
  const [conversation] = await db
    .insert(schema.conversations)
    .values({
      eventId: event.id,
      type: "shift",
      title: "BAR · sobota",
      shiftId: barShift.id,
      createdBy: coordinatorIds[0],
      lastMessageAt: new Date(now.getTime() - 22 * 60_000),
    })
    .returning({ id: schema.conversations.id });

  const barMembers = await db
    .select({ userId: schema.shiftAssignments.userId })
    .from(schema.shiftAssignments)
    .where(eq(schema.shiftAssignments.shiftId, barShift.id));

  const memberIds = [...new Set([coordinatorIds[0], ...barMembers.map((m) => m.userId)])];
  await db.insert(schema.conversationMembers).values(
    memberIds.map((userId) => ({
      conversationId: conversation.id,
      userId,
      isAdmin: userId === coordinatorIds[0],
    })),
  );

  await db.insert(schema.messages).values([
    {
      conversationId: conversation.id,
      senderId: coordinatorIds[0],
      body: "Zajtra prosím príďte o 15 minút skôr, robíme rýchle zaškolenie na výčap.",
      createdAt: new Date(now.getTime() - 40 * 60_000),
    },
    {
      conversationId: conversation.id,
      senderId: memberIds[1] ?? coordinatorIds[0],
      body: "Jasné, budem tam 15:45.",
      createdAt: new Date(now.getTime() - 32 * 60_000),
    },
    {
      conversationId: conversation.id,
      senderId: memberIds[2] ?? coordinatorIds[0],
      body: "Ja tiež. Parkuje sa pri bráne C?",
      createdAt: new Date(now.getTime() - 22 * 60_000),
    },
  ]);
}

// Priama konverzácia koordinátor ↔ Martin.
const [direct] = await db
  .insert(schema.conversations)
  .values({
    eventId: event.id,
    type: "direct",
    createdBy: coordinatorIds[0],
    lastMessageAt: new Date(now.getTime() - 4 * 60_000),
  })
  .returning({ id: schema.conversations.id });

await db.insert(schema.conversationMembers).values([
  { conversationId: direct.id, userId: coordinatorIds[0], isAdmin: true },
  { conversationId: direct.id, userId: staffIds[0] },
]);

await db.insert(schema.messages).values({
  conversationId: direct.id,
  senderId: coordinatorIds[0],
  body: "Ahoj Martin, vieš zajtra zobrať aj poobednú smenu na bare?",
  createdAt: new Date(now.getTime() - 4 * 60_000),
});

/* ---------------------------------------- notifikácie, hodnotenia, incidenty */

console.log("→ notifikácie, hodnotenia, incidenty");

await db.insert(schema.notifications).values([
  {
    userId: staffIds[0],
    eventId: event.id,
    type: "shift_confirmation_required",
    title: "Potvrď zajtrajšiu smenu",
    body: "BAR · 16:00 — 23:00",
    actionUrl: `/portal/shifts/${barShift?.id ?? ""}`,
    entityType: "shift",
    entityId: barShift?.id ?? null,
    requiresAction: true,
  },
  {
    userId: staffIds[0],
    eventId: event.id,
    type: "payout_updated",
    title: "Výplata je pripravená",
    body: "Hodiny za prvý deň sú schválené.",
    actionUrl: "/portal/earnings",
    readAt: new Date(now.getTime() - 2 * HOUR),
  },
  {
    userId: staffIds[1],
    eventId: event.id,
    type: "shift_assigned",
    title: "Máš novú smenu",
    body: "VSTUPY · zajtra 10:00 — 18:00",
    actionUrl: "/portal/shifts",
    entityType: "shift",
  },
]);

const completedShift = shiftIds.find((s) => s.plan.status === "completed");
if (completedShift) {
  await db.insert(schema.ratings).values(
    staffIds.slice(0, 4).map((staffId, index) => ({
      eventId: event.id,
      staffId,
      raterId: coordinatorIds[index % coordinatorIds.length],
      shiftId: completedShift.id,
      reliability: 5 - (index % 2),
      punctuality: 5 - (index % 3),
      workEthic: 4 + (index % 2),
      communication: 5 - (index % 2),
      quality: 4 + (index % 2),
      overall: (((5 - (index % 2)) + (5 - (index % 3)) + (4 + (index % 2)) + (5 - (index % 2)) + (4 + (index % 2))) / 5).toFixed(2),
      note: index === 0 ? "Skvelý na bare, sám od seba dopĺňal zásoby." : null,
    })),
  );
}

await db.insert(schema.incidents).values([
  {
    eventId: event.id,
    staffId: staffIds[6],
    shiftId: shiftIds[0]?.id ?? null,
    severity: "high",
    category: "no_show",
    description: "Neprišiel na rannú produkčnú smenu a nedvíhal telefón.",
    createdBy: coordinatorIds[0],
  },
  {
    eventId: event.id,
    shiftId: shiftIds[3]?.id ?? null,
    severity: "low",
    category: "equipment",
    description: "Chýba predlžovačka pri bráne A, vyriešené požičaním z produkcie.",
    createdBy: coordinatorIds[1],
    resolvedAt: new Date(),
    resolvedBy: adminId,
    resolution: "Požičaná predlžovačka z produkčného skladu.",
  },
]);

await db.insert(schema.scoreTransactions).values(
  staffIds.slice(0, 5).map((userId, index) => ({
    userId,
    eventId: event.id,
    ruleKey: index === 3 ? "late" : "on_time",
    delta: index === 3 ? -10 : 10,
    reason: index === 3 ? "Meškanie 14 min · Produkcia" : "Príchod načas · Bar",
  })),
);

await db.insert(schema.auditLogs).values({
  eventId: event.id,
  actorId: adminId,
  action: "application.approved",
  entity: "application",
  afterValue: { status: "approved" },
});
await db.insert(schema.auditLogs).values({
  eventId: event.id,
  actorId: adminId,
  action: "payroll.generated",
  entity: "event",
  entityId: event.id,
  afterValue: { created: 12, updated: 0 },
});

/* -------------------------------------------------------------------- QR */

const qrShift = shiftIds.find((s) => s.plan.slug === "bar" && s.plan.dayOffset === 1);
if (qrShift) {
  const [row] = await db
    .select({ qrSecret: schema.shifts.qrSecret })
    .from(schema.shifts)
    .where(eq(schema.shifts.id, qrShift.id))
    .limit(1);
  console.log(
    `\n  QR check-in odkaz: /portal/checkin?s=${qrShift.id}&t=${signShiftQr(qrShift.id, row.qrSecret)}`,
  );
}

console.log(`
✓ Seed hotový — ${event.name}

  Admin        ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}
  Koordinátor  peter@crew.local / ${STAFF_PASSWORD}
  Crew         martin@crew.local / ${STAFF_PASSWORD}

  ${POSITIONS.length} pozícií · ${SHIFT_PLANS.length} smien · ${staffIds.length} crew · ${applicantIds.length} uchádzačov
`);

await close();
process.exit(0);
