/** Dočasný admin účet na overenie admin rozhrania v devi. */
import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import * as schema from "../src/db/schema";
import { hashPassword } from "../src/lib/auth/password";

const client = await PGlite.create(process.env.PGLITE_DATA_DIR ?? ".pglite");
const db = drizzle(client, { schema, casing: "snake_case" });

const [event] = await db.select().from(schema.events).limit(1);
if (!event) throw new Error("Najprv spusti seed-event.");

const email = "admin@crew.local";
const [existing] = await db
  .select()
  .from(schema.users)
  .where(sql`lower(${schema.users.email}) = ${email}`)
  .limit(1);

const passwordHash = await hashPassword("crew-admin-2026");
let userId = existing?.id;

if (userId) {
  await db.update(schema.users).set({ passwordHash }).where(eq(schema.users.id, userId));
} else {
  const [created] = await db
    .insert(schema.users)
    .values({
      email,
      passwordHash,
      firstName: "Eva",
      lastName: "Krajčírová",
      globalRole: "admin",
      status: "active",
      city: "Bratislava",
      emailVerifiedAt: new Date(),
    })
    .returning({ id: schema.users.id });
  userId = created.id;
}

const [membership] = await db
  .select()
  .from(schema.eventMembers)
  .where(eq(schema.eventMembers.userId, userId))
  .limit(1);
if (!membership) {
  await db
    .insert(schema.eventMembers)
    .values({ userId, eventId: event.id, role: "admin", permissions: {} });
}

console.log(`✓ admin ${email} / crew-admin-2026`);
await client.close();
