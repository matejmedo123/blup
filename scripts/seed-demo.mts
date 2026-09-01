/** Demo dáta pre lokálne overenie portálu: crew, pozície, smeny, pridelenia. */
import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import * as schema from "../src/db/schema";
import { hashPassword } from "../src/lib/auth/password";

const client = await PGlite.create(process.env.PGLITE_DATA_DIR ?? ".pglite");
const db = drizzle(client, { schema, casing: "snake_case" });

const [event] = await db.select().from(schema.events).limit(1);
if (!event) throw new Error("Najprv spusti seed-event.");

const passwordHash = await hashPassword("crew-staff-2026");

async function upsertStaff(email: string, firstName: string, lastName: string, city: string) {
  const [existing] = await db
    .select()
    .from(schema.users)
    .where(sql`lower(${schema.users.email}) = ${email}`)
    .limit(1);
  if (existing) return existing.id;
  const [created] = await db
    .insert(schema.users)
    .values({
      email,
      passwordHash,
      firstName,
      lastName,
      city,
      phone: "+421 900 123 456",
      birthYear: 2000,
      globalRole: "staff",
      status: "active",
      emailVerifiedAt: new Date(),
    })
    .returning({ id: schema.users.id });
  await db
    .insert(schema.eventMembers)
    .values({ userId: created.id, eventId: event.id, role: "staff", permissions: {} });
  await db.insert(schema.crewScores).values({ userId: created.id, eventId: event.id, score: 92 });
  return created.id;
}

const martinId = await upsertStaff("martin@crew.local", "Martin", "Novák", "Bratislava");
const luciaId = await upsertStaff("lucia@crew.local", "Lucia", "Bartošová", "Bratislava");

const [position] = await db
  .insert(schema.positions)
  .values({
    eventId: event.id,
    name: "Bar",
    slug: "bar",
    description: "Výčap a obsluha na hlavnej scéne.",
    hourlyRate: "8.50",
    capacity: 10,
    color: "#111111",
    requiredSkills: ["výčap"],
  })
  .onConflictDoNothing()
  .returning({ id: schema.positions.id });

const positionId =
  position?.id ??
  (
    await db
      .select({ id: schema.positions.id })
      .from(schema.positions)
      .where(eq(schema.positions.eventId, event.id))
      .limit(1)
  )[0].id;

const start = new Date();
start.setHours(start.getHours() + 3, 0, 0, 0);
const end = new Date(start.getTime() + 6 * 3_600_000);

const [shift] = await db
  .insert(schema.shifts)
  .values({
    eventId: event.id,
    positionId,
    startsAt: start,
    endsAt: end,
    location: "Nová Cvernovka, Bratislava",
    capacity: 4,
    status: "published",
    checkInMethod: "manual",
    qrSecret: "demo-secret",
    instructions:
      "Príchod 15 minút pred začiatkom pri bráne C, hlás sa Petrovi. Vodu a jedlo máš v crew zóne.",
    dressCode: "Čierne tričko, čierne nohavice, pohodlná obuv",
  })
  .returning({ id: schema.shifts.id });

for (const userId of [martinId, luciaId]) {
  await db
    .insert(schema.shiftAssignments)
    .values({
      shiftId: shift.id,
      userId,
      eventId: event.id,
      status: userId === martinId ? "pending_confirmation" : "confirmed",
    })
    .onConflictDoNothing();
}

await db.insert(schema.notifications).values({
  userId: martinId,
  eventId: event.id,
  type: "shift_assigned",
  title: "Máš novú smenu",
  body: "Bar · dnes večer",
  actionUrl: `/portal/shifts/${shift.id}`,
  entityType: "shift",
  entityId: shift.id,
  requiresAction: true,
});

console.log("✓ demo dáta (martin@crew.local / crew-staff-2026)");
await client.close();
