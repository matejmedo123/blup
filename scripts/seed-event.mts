/** Minimálny event pre lokálne overenie verejných formulárov. */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

import * as schema from "../src/db/schema";

const client = await PGlite.create(process.env.PGLITE_DATA_DIR ?? ".pglite");
const db = drizzle(client, { schema, casing: "snake_case" });

const existing = await db.select().from(schema.events).limit(1);
if (existing.length === 0) {
  await db.insert(schema.events).values({
    name: "Grape Festival 2026",
    slug: "grape-2026",
    description: "Dvojdňový festival v areáli letiska Piešťany.",
    location: "Letisko Piešťany",
    startDate: "2026-09-11",
    endDate: "2026-09-13",
    timezone: "Europe/Bratislava",
    status: "active",
    settings: { currency: "EUR", rounding: "5min" },
  });
  console.log("✓ event vytvorený");
} else {
  console.log("event už existuje");
}
await client.close();
