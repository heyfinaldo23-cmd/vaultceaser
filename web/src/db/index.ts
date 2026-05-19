import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import path from "path";
import * as schema from "./schema";

export type Db = ReturnType<typeof drizzle<typeof schema>>;

let db: Db | null = null;

export function getDb(): Db {
  if (db) return db;
  // Default: store db.sqlite in a `data/` folder next to the project root
  const dbPath =
    process.env.DATABASE_PATH ||
    path.join(process.cwd(), "..", "data", "db.sqlite");
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  db = drizzle(sqlite, { schema });
  return db;
}
