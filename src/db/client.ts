import "server-only";

import { drizzle as drizzleNode, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePglite, type PgliteDatabase } from "drizzle-orm/pglite";

import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema> | PgliteDatabase<typeof schema>;

type Global = typeof globalThis & {
  __crewDb?: Database;
  __crewDbReady?: Promise<Database>;
};

const g = globalThis as Global;

const MIGRATIONS_FOLDER = "drizzle";

function isPostgresUrl(url: string | undefined): url is string {
  return !!url && /^postgres(ql)?:\/\//.test(url);
}

async function createDatabase(): Promise<Database> {
  const url = process.env.DATABASE_URL;

  if (isPostgresUrl(url)) {
    const { Pool } = await import("pg");
    const pool = new Pool({
      connectionString: url,
      max: Number(process.env.DATABASE_POOL_MAX ?? 10),
      ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
    });
    return drizzleNode(pool, { schema, casing: "snake_case" });
  }

  // Vývoj a testy: reálny Postgres vo WASM, bez externej služby.
  const { PGlite } = await import("@electric-sql/pglite");
  const dataDir = process.env.PGLITE_DATA_DIR ?? ".pglite";
  const client = await PGlite.create(dataDir === "memory://" ? undefined : dataDir);
  const db = drizzlePglite(client, { schema, casing: "snake_case" });

  if (process.env.CREW_SKIP_AUTO_MIGRATE !== "true") {
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  }
  return db;
}

/** Lazy singleton — prežije HMR v dev režime. */
export async function getDb(): Promise<Database> {
  if (g.__crewDb) return g.__crewDb;
  if (!g.__crewDbReady) {
    g.__crewDbReady = createDatabase().then((db) => {
      g.__crewDb = db;
      return db;
    });
  }
  return g.__crewDbReady;
}

export { schema };
