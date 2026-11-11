import type Database from "better-sqlite3";
import type { Clock } from "../../application/ports/clock.port";
import { EMPTY_SCHEMA_VERSION, TABLE } from "./sqlite.constants";
import type { Migration } from "./sqlite.migrations";

interface SchemaVersionRow {
  version: number;
  description: string;
  applied_at: number;
}

const CREATE_SCHEMA_VERSION_TABLE = `
  CREATE TABLE IF NOT EXISTS ${TABLE.SCHEMA_VERSION} (
    version     INTEGER PRIMARY KEY,
    description TEXT    NOT NULL,
    applied_at  INTEGER NOT NULL
  ) STRICT`;
const SELECT_SCHEMA_VERSION = `SELECT COALESCE(MAX(version), ${EMPTY_SCHEMA_VERSION}) AS version FROM ${TABLE.SCHEMA_VERSION}`;
const INSERT_SCHEMA_VERSION = `INSERT INTO ${TABLE.SCHEMA_VERSION} (version, description, applied_at) VALUES (@version, @description, @applied_at)`;

function assertIncreasingVersions(migrations: readonly Migration[]): void {
  let previous = EMPTY_SCHEMA_VERSION;
  for (const { version } of migrations) {
    if (!Number.isInteger(version) || version <= previous) {
      throw new Error(`Migration versions must be increasing integers above ${EMPTY_SCHEMA_VERSION}: ${version} follows ${previous}.`);
    }
    previous = version;
  }
}

const latestVersion = (migrations: readonly Migration[]): number => migrations.at(-1)?.version ?? EMPTY_SCHEMA_VERSION;

const readSchemaVersion = (db: Database.Database): number =>
  db.prepare<[], Pick<SchemaVersionRow, "version">>(SELECT_SCHEMA_VERSION).get()?.version ?? EMPTY_SCHEMA_VERSION;

/**
 * Brings the schema up to the newest migration in one write transaction: a crash part-way leaves the previous version,
 * and a restart (or a second process) finds the work done and applies nothing. Refuses a database written by a newer hub.
 * Returns the schema version now in place.
 */
export function runMigrations(db: Database.Database, migrations: readonly Migration[], clock: Clock): number {
  assertIncreasingVersions(migrations);
  const target = latestVersion(migrations);

  const migrate = db.transaction((): number => {
    db.exec(CREATE_SCHEMA_VERSION_TABLE);
    const current = readSchemaVersion(db);
    if (current > target) {
      throw new Error(`The database is at schema version ${current}, newer than this hub knows (${target}). Run a newer hub.`);
    }
    const recordVersion = db.prepare<SchemaVersionRow>(INSERT_SCHEMA_VERSION);
    for (const migration of migrations.filter(({ version }) => version > current)) {
      db.exec(migration.sql);
      recordVersion.run({ version: migration.version, description: migration.description, applied_at: clock.now() });
    }
    return target;
  });

  return migrate.immediate();
}
