import "server-only";

import type { ExtractTablesWithRelations } from "drizzle-orm";
import { drizzle as drizzleNode } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";

import * as schema from "./schema";

type Relations = ExtractTablesWithRelations<typeof schema>;

/**
 * Spoločný typ pre oba drivery (node-postgres v produkcii, PGlite v dev/testoch).
 * Rovnaký dialekt znamená, že testy overujú presne tú SQL, ktorá pobeží v produkcii.
 */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema, Relations>;

/** Typ transakcie — funkcie, ktoré musia byť atomické, ho prijímajú ako parameter. */
export type Transaction = PgTransaction<PgQueryResultHKT, typeof schema, Relations>;

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
