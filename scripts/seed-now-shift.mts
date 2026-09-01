/** Posunie demo smenu na „práve prebieha“, aby sa dal overiť check-in. */
import { PGlite } from "@electric-sql/pglite";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import * as schema from "../src/db/schema";

const client = await PGlite.create(process.env.PGLITE_DATA_DIR ?? ".pglite");
const db = drizzle(client, { schema, casing: "snake_case" });

const [shift] = await db
  .select()
  .from(schema.shifts)
  .orderBy(asc(schema.shifts.startsAt))
  .limit(1);
if (!shift) throw new Error("Žiadna smena.");

const start = new Date(Date.now() - 10 * 60_000);
const end = new Date(start.getTime() + 6 * 3_600_000);
await db
  .update(schema.shifts)
  .set({ startsAt: start, endsAt: end, status: "in_progress" })
  .where(eq(schema.shifts.id, shift.id));

console.log(`✓ smena ${shift.id} beží od ${start.toISOString()}`);
await client.close();
