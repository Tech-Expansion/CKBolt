import "reflect-metadata";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Test, type TestingModule } from "@nestjs/testing";
import type Database from "better-sqlite3";
import type { InboundOpen, InboundOpenStore } from "../../../src/application/ports/inbound-open-store.port";
import { CLOCK, HUB_CONFIG, INBOUND_OPEN_STORE } from "../../../src/application/ports/tokens";
import { SQLITE_IN_MEMORY_PATH } from "../../../src/common/constants/persistence.constants";
import { HubConfigModule } from "../../../src/config/config.module";
import { loadHubConfig, type HubConfig } from "../../../src/config/hub.config";
import { PersistenceModule } from "../../../src/infrastructure/persistence/persistence.module";
import { SqliteInboundOpenStore } from "../../../src/infrastructure/persistence/sqlite-inbound-open-store";
import { openHubDatabase, openSqliteDatabase } from "../../../src/infrastructure/persistence/sqlite.database";
import { MIGRATIONS } from "../../../src/infrastructure/persistence/sqlite.migrations";
import { runMigrations } from "../../../src/infrastructure/persistence/sqlite.migrator";
import { FakeClock, FakeInboundOpenStore } from "../../fakes";

/**
 * The inbound opens the hub may abandon unaccepted (InboundOpenStore), in the hub's SQLite database so they survive a
 * restart. The port's semantics run against the SQLite store and the fake the service tests use; then what only the
 * SQLite store has: its table, the migration of a database written by an older hub, a file reopened, the module wiring.
 */

const NODE_A = `02${"a1".repeat(32)}`;
const NODE_B = `03${"b2".repeat(32)}`;
const T0 = 1_762_000_000_000;

const open = (id: string, peer = NODE_A, askedAt = T0): InboundOpen => ({ temporaryChannelId: id.repeat(32), peer, askedAt });

interface Opened {
  store: InboundOpenStore;
  close: () => void;
}

const implementations: [string, () => Opened][] = [
  ["FakeInboundOpenStore", () => ({ store: new FakeInboundOpenStore(), close: () => undefined })],
  [
    "SqliteInboundOpenStore",
    () => {
      const db = openHubDatabase(SQLITE_IN_MEMORY_PATH, new FakeClock());
      return { store: new SqliteInboundOpenStore(db), close: () => db.close() };
    },
  ],
];

describe.each(implementations)("InboundOpenStore port semantics: %s", (_name, openStore) => {
  let store: InboundOpenStore;
  let close: () => void;

  beforeEach(() => ({ store, close } = openStore()));
  afterEach(() => close());

  it("lists nothing when nothing is on record", () => {
    expect(store.listAskedBy(Number.MAX_SAFE_INTEGER)).toEqual([]);
  });

  it("returns an open as it was recorded, once asked at or before the time given (not after it)", () => {
    const recorded = open("aa");
    store.record(recorded);
    expect(store.listAskedBy(T0 - 1)).toEqual([]);
    expect(store.listAskedBy(T0)).toEqual([recorded]);
    expect(store.listAskedBy(T0 + 1)).toEqual([recorded]);
  });

  it("lists the oldest first, and by id between opens of one instant", () => {
    const late = open("03", NODE_A, T0 + 2);
    const tieB = open("02", NODE_B, T0);
    const tieA = open("01", NODE_A, T0);
    [late, tieB, tieA].forEach((o) => store.record(o));
    expect(store.listAskedBy(T0 + 2)).toEqual([tieA, tieB, late]);
  });

  it("lists the opens to one peer, or to every peer when none is given", () => {
    const toA = open("aa", NODE_A);
    const toB = open("bb", NODE_B);
    store.record(toA);
    store.record(toB);
    expect(store.listAskedBy(T0, NODE_A)).toEqual([toA]);
    expect(store.listAskedBy(T0, NODE_B)).toEqual([toB]);
    expect(store.listAskedBy(T0, `02${"cc".repeat(32)}`)).toEqual([]);
    expect(store.listAskedBy(T0)).toEqual([toA, toB]);
  });

  it("recording an id again replaces its peer and time: one open per temporary channel id", () => {
    store.record(open("aa", NODE_A, T0));
    const again = open("aa", NODE_B, T0 + 5);
    store.record(again);
    expect(store.listAskedBy(T0 + 4)).toEqual([]);
    expect(store.listAskedBy(T0 + 5)).toEqual([again]);
  });

  it("forgets one open by its id, leaves the others, and ignores an id it does not have", () => {
    const kept = open("aa");
    store.record(kept);
    store.record(open("bb"));
    store.forget("bb".repeat(32));
    store.forget("ff".repeat(32));
    expect(store.listAskedBy(T0)).toEqual([kept]);
  });

  it("matches ids exactly as recorded (the caller keeps them canonical)", () => {
    store.record(open("aa"));
    store.forget(`0x${"AA".repeat(32)}`);
    expect(store.listAskedBy(T0)).toHaveLength(1);
  });

  it("hands out copies: changing a listed open changes nothing on record", () => {
    store.record(open("aa"));
    const [listed] = store.listAskedBy(T0);
    listed!.askedAt = T0 + 1_000;
    listed!.peer = NODE_B;
    expect(store.listAskedBy(T0)).toEqual([open("aa")]);
  });
});

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

describe("SqliteInboundOpenStore", () => {
  let dir: string;
  let clock: FakeClock;
  const opened: Database.Database[] = [];

  const openFile = (path: string): Database.Database => {
    const db = openHubDatabase(path, clock);
    opened.push(db);
    return db;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ckbolt-inbound-opens-"));
    clock = new FakeClock();
  });

  afterEach(() => {
    for (const db of opened.splice(0)) if (db.open) db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("the migrations create inbound_opens: temporary_channel_id the key, every column required, STRICT", () => {
    const db = openFile(SQLITE_IN_MEMORY_PATH);
    const columns = db.prepare("PRAGMA table_info(inbound_opens)").all() as ColumnInfo[];
    expect(columns.map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk }))).toEqual([
      // A STRICT table's primary key is NOT NULL even without saying so.
      { name: "temporary_channel_id", type: "TEXT", notnull: 1, pk: 1 },
      { name: "peer", type: "TEXT", notnull: 1, pk: 0 },
      { name: "asked_at", type: "INTEGER", notnull: 1, pk: 0 },
    ]);
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'inbound_opens'").get() as { sql: string }).sql;
    expect(sql).toMatch(/\)\s*STRICT$/);
    // STRICT: a time that is not an integer is refused rather than stored as text, and so is a missing key.
    expect(() => db.prepare("INSERT INTO inbound_opens VALUES ('x', 'y', 'soon')").run()).toThrow();
    expect(() => db.prepare("INSERT INTO inbound_opens VALUES (NULL, 'y', 1)").run()).toThrow();
  });

  it("brings a database written by the previous hub (schema 5, with data) up to date, keeping its data", () => {
    const path = join(dir, "hub.sqlite");
    const old = openSqliteDatabase(path);
    opened.push(old);
    const previous = MIGRATIONS.filter((m) => m.version <= 5);
    expect(runMigrations(old, previous, clock)).toBe(5);
    old.prepare("INSERT INTO channel_opens (kind, client_key, peer, pushed_sats, opened_at) VALUES ('fiber', 'c', ?, '0', ?)").run(NODE_A, T0);
    old.close();

    clock.advance(60_000);
    const db = openFile(path);
    const versions = db.prepare("SELECT version, applied_at FROM schema_version ORDER BY version").all() as { version: number; applied_at: number }[];
    expect(versions.at(-1)).toEqual({ version: MIGRATIONS.at(-1)!.version, applied_at: clock.now() });
    expect(versions.map((v) => v.version)).toEqual(MIGRATIONS.map((m) => m.version));
    expect(db.prepare("SELECT COUNT(*) AS n FROM channel_opens").get()).toEqual({ n: 1 });
    const store = new SqliteInboundOpenStore(db);
    expect(store.listAskedBy(Number.MAX_SAFE_INTEGER)).toEqual([]);
    store.record(open("aa"));
    expect(store.listAskedBy(T0)).toEqual([open("aa")]);
  });

  it("keeps what it recorded, and what it forgot, across a restart on the same file", () => {
    const path = join(dir, "hub.sqlite");
    const first = openFile(path);
    const before = new SqliteInboundOpenStore(first);
    before.record(open("aa", NODE_A, T0));
    before.record(open("bb", NODE_B, T0 + 1));
    before.record(open("cc", NODE_A, T0 + 2));
    before.forget("bb".repeat(32));
    first.close();

    const after = new SqliteInboundOpenStore(openFile(path));
    expect(after.listAskedBy(Number.MAX_SAFE_INTEGER)).toEqual([open("aa", NODE_A, T0), open("cc", NODE_A, T0 + 2)]);
  });

  it("shares the hub's one database with the other stores: PersistenceModule provides INBOUND_OPEN_STORE", async () => {
    const path = join(dir, "data", "hub.sqlite");
    const config: HubConfig = { ...loadHubConfig({}), database: { path } };
    const compile = async (): Promise<TestingModule> => {
      const app = await Test.createTestingModule({ imports: [HubConfigModule, PersistenceModule] })
        .overrideProvider(HUB_CONFIG)
        .useValue(config)
        .overrideProvider(CLOCK)
        .useValue(clock)
        .compile();
      await app.init();
      return app;
    };

    const app = await compile();
    const store = app.get<InboundOpenStore>(INBOUND_OPEN_STORE);
    expect(store).toBeInstanceOf(SqliteInboundOpenStore);
    store.record(open("aa"));
    await app.close();
    // Closed with the module (the swap store owns the connection).
    expect(() => store.listAskedBy(T0)).toThrow();

    const restarted = await compile();
    try {
      expect(restarted.get<InboundOpenStore>(INBOUND_OPEN_STORE).listAskedBy(T0)).toEqual([open("aa")]);
    } finally {
      await restarted.close();
    }
  });
});
