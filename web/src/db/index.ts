import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Db = PostgresJsDatabase<typeof schema>;

let client: ReturnType<typeof postgres> | null = null;
let db: Db | null = null;

/** Returns null when ``DATABASE_URL`` is not set (Vercel preview without DB). */
export function getDb(): Db | null {
  if (db) return db;
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  client = postgres(url, { max: 1, prepare: false });
  db = drizzle(client, { schema });
  return db;
}
