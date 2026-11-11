import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { Clock } from "../../application/ports/clock.port";
import { SQLITE_IN_MEMORY_PATH } from "../../common/constants/persistence.constants";
import { SQLITE_PRAGMAS } from "./sqlite.constants";
import { MIGRATIONS } from "./sqlite.migrations";
import { runMigrations } from "./sqlite.migrator";

/** Runs `setup` on a database just opened; closes the database if setup throws, so a failed start leaves no open handle. */
export function closeOnError<T>(db: Database.Database, setup: () => T): T {
  try {
    return setup();
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * Opens the database at `path` with the hub's connection settings, creating the file and its parent directory when
 * missing. SQLITE_IN_MEMORY_PATH keeps it in memory.
 */
export function openSqliteDatabase(path: string): Database.Database {
  if (path !== SQLITE_IN_MEMORY_PATH) mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  return closeOnError(db, () => {
    SQLITE_PRAGMAS.forEach((pragma) => db.pragma(pragma));
    return db;
  });
}

/**
 * Opens the hub's database at `path` and applies pending migrations: the one database every store of the hub shares
 * (swaps, channel opens, inbound opens). A failed migration closes it again.
 */
export function openHubDatabase(path: string, clock: Clock): Database.Database {
  const db = openSqliteDatabase(path);
  return closeOnError(db, () => {
    runMigrations(db, MIGRATIONS, clock);
    return db;
  });
}

/** The fields of better-sqlite3's SqliteError the hub reads. */
export interface SqliteErrorFields {
  readonly code: string;
  readonly message: string;
}

/**
 * True when `error` is SQLite's error with this result code (e.g. a constraint the schema enforces). Matches on its
 * fields, never `instanceof` (not `Database.SqliteError`, not even `Error`): better-sqlite3 binds its error class to the
 * native addon once per process, so a second copy of the module (another module registry, a bundle, a Jest test file)
 * receives errors whose class and Error prototype belong to another realm.
 */
export const isSqliteError = (error: unknown, code: string): error is SqliteErrorFields =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === code &&
  "message" in error &&
  typeof error.message === "string";
