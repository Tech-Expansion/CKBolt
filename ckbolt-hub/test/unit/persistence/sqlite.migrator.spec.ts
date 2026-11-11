import { join } from "node:path";
import Database from "better-sqlite3";
import { SQLITE_IN_MEMORY_PATH } from "../../../src/common/constants/persistence.constants";
import { closeOnError, openSqliteDatabase } from "../../../src/infrastructure/persistence/sqlite.database";
import { MIGRATIONS, type Migration } from "../../../src/infrastructure/persistence/sqlite.migrations";
import { runMigrations } from "../../../src/infrastructure/persistence/sqlite.migrator";
import { openSqliteSwapStore } from "../../../src/infrastructure/persistence/sqlite-swap-store";
import { FakeClock } from "../../fakes";
import { makeSwap, makeTempDir, removeTempDir } from "./persistence.fixtures";

interface SchemaVersionRow {
  version: number;
  description: string;
  applied_at: number;
}

const schemaVersions = (db: Database.Database): SchemaVersionRow[] =>
  db.prepare("SELECT version, description, applied_at FROM schema_version ORDER BY version").all() as SchemaVersionRow[];

const tableExists = (db: Database.Database, name: string): boolean =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;

const migration = (version: number, sql: string, description = `step ${version}`): Migration => ({ version, description, sql });

describe("SQLite migrations", () => {
  let clock: FakeClock;
  let db: Database.Database;

  beforeEach(() => {
    clock = new FakeClock();
    db = openSqliteDatabase(SQLITE_IN_MEMORY_PATH);
  });

  afterEach(() => {
    if (db.open) db.close();
  });

  describe("shipped migrations", () => {
    it("start at version 1 and increase", () => {
      const versions = MIGRATIONS.map((m) => m.version);
      expect(versions[0]).toBe(1);
      versions.slice(1).forEach((version, index) => expect(version).toBeGreaterThan(versions[index]!));
      MIGRATIONS.forEach((m) => expect(m.description.trim()).not.toBe(""));
    });

    it("record every applied version with its description and the clock's time", () => {
      const version = runMigrations(db, MIGRATIONS, clock);
      expect(version).toBe(MIGRATIONS.at(-1)!.version);
      expect(schemaVersions(db)).toEqual(MIGRATIONS.map((m) => ({ version: m.version, description: m.description, applied_at: clock.now() })));
    });

    it("are idempotent: running them again applies nothing and keeps the original record", () => {
      runMigrations(db, MIGRATIONS, clock);
      const before = schemaVersions(db);
      clock.advance(60_000);
      expect(runMigrations(db, MIGRATIONS, clock)).toBe(MIGRATIONS.at(-1)!.version);
      expect(schemaVersions(db)).toEqual(before);
    });
  });

  describe("runMigrations", () => {
    it("applies only the pending steps on an older database", () => {
      const v1 = migration(1, "CREATE TABLE a (x INTEGER) STRICT;");
      const v2 = migration(2, "CREATE TABLE b (y INTEGER) STRICT;");
      expect(runMigrations(db, [v1], clock)).toBe(1);
      db.prepare("INSERT INTO a (x) VALUES (7)").run();
      clock.advance(1_000);

      expect(runMigrations(db, [v1, v2], clock)).toBe(2);
      expect(tableExists(db, "b")).toBe(true);
      expect(db.prepare("SELECT x FROM a").get()).toEqual({ x: 7 });
      expect(schemaVersions(db)).toEqual([
        { version: 1, description: v1.description, applied_at: clock.now() - 1_000 },
        { version: 2, description: v2.description, applied_at: clock.now() },
      ]);
    });

    it("rolls back every step of a run when one fails, leaving the previous version", () => {
      const ok = migration(1, "CREATE TABLE a (x INTEGER) STRICT;");
      const broken = migration(2, "CREATE TABLE b (y INTEGER) STRICT; THIS IS NOT SQL;");
      expect(() => runMigrations(db, [ok, broken], clock)).toThrow();
      expect(tableExists(db, "a")).toBe(false);
      expect(tableExists(db, "b")).toBe(false);
      const recorded = tableExists(db, "schema_version") ? schemaVersions(db) : [];
      expect(recorded).toEqual([]);
    });

    it("keeps an applied version when a later run fails", () => {
      runMigrations(db, [migration(1, "CREATE TABLE a (x INTEGER) STRICT;")], clock);
      expect(() => runMigrations(db, [migration(1, "CREATE TABLE a (x INTEGER) STRICT;"), migration(2, "NOT SQL")], clock)).toThrow();
      expect(schemaVersions(db).map((r) => r.version)).toEqual([1]);
      expect(tableExists(db, "a")).toBe(true);
    });

    it.each([
      ["a duplicate version", [migration(1, "SELECT 1"), migration(1, "SELECT 1")]],
      ["a decreasing version", [migration(2, "SELECT 1"), migration(1, "SELECT 1")]],
      ["version zero", [migration(0, "SELECT 1")]],
      ["a negative version", [migration(-1, "SELECT 1")]],
      ["a fractional version", [migration(1.5, "SELECT 1")]],
    ])("refuses %s before touching the database", (_case, migrations) => {
      expect(() => runMigrations(db, migrations, clock)).toThrow();
      expect(tableExists(db, "schema_version")).toBe(false);
    });

    it("refuses a database written by a newer hub and changes nothing", () => {
      runMigrations(db, [migration(1, "CREATE TABLE a (x INTEGER) STRICT;"), migration(2, "CREATE TABLE b (y INTEGER) STRICT;")], clock);
      const before = schemaVersions(db);
      expect(() => runMigrations(db, [migration(1, "CREATE TABLE a (x INTEGER) STRICT;")], clock)).toThrow();
      expect(schemaVersions(db)).toEqual(before);
    });

    it("accepts an empty migration list on an empty database", () => {
      expect(runMigrations(db, [], clock)).toBe(0);
    });
  });

  describe("opening a store", () => {
    let dir: string;

    beforeEach(() => {
      dir = makeTempDir();
    });

    afterEach(() => removeTempDir(dir));

    it("does not re-apply migrations on restart (one record per version)", () => {
      const path = join(dir, "hub.sqlite");
      openSqliteSwapStore(path, clock).close();
      clock.advance(3_600_000);
      openSqliteSwapStore(path, clock).close();
      const raw = new Database(path, { readonly: true });
      try {
        expect(schemaVersions(raw)).toEqual(MIGRATIONS.map((m) => ({ version: m.version, description: m.description, applied_at: clock.now() - 3_600_000 })));
      } finally {
        raw.close();
      }
    });

    it("refuses a database from a newer hub and releases the file", () => {
      const path = join(dir, "hub.sqlite");
      openSqliteSwapStore(path, clock).close();
      const raw = new Database(path);
      const newer = MIGRATIONS.at(-1)!.version + 1;
      raw.prepare("INSERT INTO schema_version (version, description, applied_at) VALUES (?, ?, ?)").run(newer, "from the future", clock.now());
      raw.close();

      expect(() => openSqliteSwapStore(path, clock)).toThrow(new RegExp(String(newer)));
      // The failed open closed its handle: the folder can be removed (Windows refuses while a file is open).
      expect(() => removeTempDir(dir)).not.toThrow();
    });

    it("an opened store works on a migrated database", () => {
      const store = openSqliteSwapStore(join(dir, "hub.sqlite"), clock);
      try {
        const swap = makeSwap(clock);
        store.createSwap(swap);
        expect(store.getSwap(swap.id)).toEqual(swap);
      } finally {
        store.close();
      }
    });
  });

  describe("closeOnError", () => {
    it("returns the setup's result and leaves the database open", () => {
      expect(closeOnError(db, () => 42)).toBe(42);
      expect(db.open).toBe(true);
    });

    it("closes the database and rethrows when setup throws", () => {
      const failure = new Error("setup failed");
      expect(() =>
        closeOnError(db, () => {
          throw failure;
        }),
      ).toThrow(failure);
      expect(db.open).toBe(false);
    });
  });
});
