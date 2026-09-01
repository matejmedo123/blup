/**
 * Aplikuje migrácie na cieľovú databázu.
 * `DATABASE_URL=postgres://…` → node-postgres, inak PGlite (`PGLITE_DATA_DIR`).
 */
import { drizzle as drizzleNode } from "drizzle-orm/node-postgres";
import { migrate as migrateNode } from "drizzle-orm/node-postgres/migrator";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";

async function main() {
  const url = process.env.DATABASE_URL;
  const folder = "drizzle";

  if (url && /^postgres(ql)?:\/\//.test(url)) {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: url });
    await migrateNode(drizzleNode(pool), { migrationsFolder: folder });
    await pool.end();
    console.log("✓ migrácie aplikované na PostgreSQL");
    return;
  }

  const { PGlite } = await import("@electric-sql/pglite");
  const dir = process.env.PGLITE_DATA_DIR ?? ".pglite";
  const client = await PGlite.create(dir);
  await migratePglite(drizzlePglite(client), { migrationsFolder: folder });
  await client.close();
  console.log(`✓ migrácie aplikované na PGlite (${dir})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
