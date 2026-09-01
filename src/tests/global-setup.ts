import { rm } from "node:fs/promises";

/** Každý beh testov začína na čistej databáze. */
export default async function setup() {
  process.env.PGLITE_DATA_DIR = ".pglite-test";
  await rm(".pglite-test", { recursive: true, force: true });

  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");

  const client = await PGlite.create(".pglite-test");
  await migrate(drizzle(client), { migrationsFolder: "drizzle" });
  await client.close();

  return async () => {
    await rm(".pglite-test", { recursive: true, force: true });
  };
}
