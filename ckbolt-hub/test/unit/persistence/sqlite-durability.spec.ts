import { existsSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SQLITE_IN_MEMORY_PATH } from "../../../src/common/constants/persistence.constants";
import { SWAP_EVENT } from "../../../src/common/constants/swap.constants";
import { openSqliteDatabase } from "../../../src/infrastructure/persistence/sqlite.database";
import { openSqliteSwapStore, type SqliteSwapStore } from "../../../src/infrastructure/persistence/sqlite-swap-store";
import { FakeClock } from "../../fakes";
import { BEYOND_U64, makeEvent, makeQuote, makeSwap, makeTempDir, newPreimage, removeTempDir } from "./persistence.fixtures";

/** SQLite's own names, read back through PRAGMAs and typeof(); the tests compare against them. */
const SQLITE_TYPE = { TEXT: "text", INTEGER: "integer", REAL: "real", NULL: "null" } as const;
const JOURNAL_MODE_WAL = "wal";
const SYNCHRONOUS_FULL = 2;
const FOREIGN_KEYS_ON = 1;

describe("SQLite persistence on disk", () => {
  let dir: string;
  let dbPath: string;
  let clock: FakeClock;
  const opened: { close(): void }[] = [];

  const openStore = (): SqliteSwapStore => {
    const store = openSqliteSwapStore(dbPath, clock);
    opened.push(store);
    return store;
  };

  /** A plain connection, as an operator or a second process would open the file. */
  const openRaw = (options?: Database.Options): Database.Database => {
    const db = new Database(dbPath, options);
    opened.push(db);
    return db;
  };

  beforeEach(() => {
    dir = makeTempDir();
    dbPath = join(dir, "hub.sqlite");
    clock = new FakeClock();
  });

  afterEach(() => {
    opened.splice(0).forEach((handle) => {
      try {
        handle.close();
      } catch {
        // already closed
      }
    });
    removeTempDir(dir);
  });

  describe("restart safety", () => {
    it("keeps quotes, swaps and events across a restart", () => {
      const first = openStore();
      const quote = makeQuote(clock, { fiberAmount: BEYOND_U64 });
      const swap = makeSwap(clock, { quoteId: quote.id });
      const event = makeEvent(swap.id, clock.now(), SWAP_EVENT.CREATED, "hold invoice issued");
      first.saveQuote(quote);
      first.createSwap(swap);
      first.addEvent(event);
      first.close();

      const second = openStore();
      expect(second.getQuote(quote.id)).toEqual(quote);
      expect(second.getSwap(swap.id)).toEqual(swap);
      expect(second.listEvents(swap.id)).toEqual([event]);
    });

    it("resumes every open swap after a restart, including a saved preimage and an unrefunded failure", () => {
      const first = openStore();
      const preimage = newPreimage();
      const inFlight = makeSwap(clock, { state: "outgoing_in_flight" });
      const toSettle = makeSwap(clock, { state: "outgoing_in_flight" });
      const toRefund = makeSwap(clock, { state: "incoming_accepted" });
      const done = makeSwap(clock, { state: "outgoing_succeeded", preimage: newPreimage() });
      [inFlight, toSettle, toRefund, done].forEach((swap) => first.createSwap(swap));
      clock.advance(1_000);
      first.transition(toSettle.id, "outgoing_in_flight", { state: "outgoing_succeeded", preimage });
      first.transition(toRefund.id, "incoming_accepted", { state: "failed", failureReason: "payout failed" });
      first.transition(done.id, "outgoing_succeeded", { state: "succeeded" });
      // No close(): a crash leaves the connection open; committed writes must already be on disk.

      const second = openStore();
      const open = second.listOpenSwaps();
      expect(open.map((s) => s.id)).toEqual([inFlight.id, toSettle.id, toRefund.id]);
      expect(open.find((s) => s.id === toSettle.id)).toMatchObject({ state: "outgoing_succeeded", preimage });
      expect(open.find((s) => s.id === toRefund.id)).toMatchObject({ state: "failed", refunded: false });
    });

    it("rejects a hash reused after a restart", () => {
      const first = openStore();
      const swap = makeSwap(clock, { state: "failed", refunded: true });
      first.createSwap(swap);
      first.close();
      expect(() => openStore().createSwap(makeSwap(clock, { paymentHash: swap.paymentHash }))).toThrow();
    });

    it("makes every write visible to another connection as soon as the call returns", () => {
      const store = openStore();
      const reader = openRaw({ readonly: true });
      const swap = makeSwap(clock);
      store.createSwap(swap);
      store.transition(swap.id, "pending", { state: "incoming_accepted" });
      const row = reader.prepare("SELECT state FROM swaps WHERE id = ?").get(swap.id) as { state: string } | undefined;
      expect(row?.state).toBe("incoming_accepted");
    });
  });

  describe("compare-and-set across connections", () => {
    it("a second store on the same file loses the race once the first has moved the state", () => {
      const a = openStore();
      const b = openStore();
      const swap = makeSwap(clock);
      a.createSwap(swap);
      expect(a.transition(swap.id, "pending", { state: "incoming_accepted" })).not.toBeNull();
      expect(b.transition(swap.id, "pending", { state: "failed", failureReason: "late cancel" })).toBeNull();
      expect(a.getSwap(swap.id)).toMatchObject({ state: "incoming_accepted", failureReason: null });
    });

    it("a second store sees a duplicate hash created by the first", () => {
      const a = openStore();
      const b = openStore();
      const swap = makeSwap(clock);
      a.createSwap(swap);
      expect(() => b.createSwap(makeSwap(clock, { paymentHash: swap.paymentHash }))).toThrow();
    });
  });

  describe("storage format", () => {
    it("stores amounts as decimal TEXT, times as INTEGER ms and booleans as INTEGER 0 or 1", () => {
      const store = openStore();
      const swap = makeSwap(clock, { sats: 21n, fiberAmount: BEYOND_U64, demo: true });
      store.createSwap(swap);
      const row = openRaw({ readonly: true })
        .prepare(
          `SELECT typeof(sats) AS sats_type, sats, typeof(fiber_amount) AS fiber_type, fiber_amount,
                  typeof(created_at) AS created_type, created_at, typeof(updated_at) AS updated_type,
                  typeof(quote_expires_at) AS expires_type, typeof(refunded) AS refunded_type, refunded,
                  typeof(demo) AS demo_type, demo, typeof(preimage) AS preimage_type
           FROM swaps WHERE id = ?`,
        )
        .get(swap.id);
      expect(row).toEqual({
        sats_type: SQLITE_TYPE.TEXT,
        sats: "21",
        fiber_type: SQLITE_TYPE.TEXT,
        fiber_amount: BEYOND_U64.toString(10),
        created_type: SQLITE_TYPE.INTEGER,
        created_at: swap.createdAt,
        updated_type: SQLITE_TYPE.INTEGER,
        expires_type: SQLITE_TYPE.INTEGER,
        refunded_type: SQLITE_TYPE.INTEGER,
        refunded: 0,
        demo_type: SQLITE_TYPE.INTEGER,
        demo: 1,
        preimage_type: SQLITE_TYPE.NULL,
      });
    });

    it("stores quote amounts as TEXT and quote times as INTEGER", () => {
      const store = openStore();
      const quote = makeQuote(clock);
      store.saveQuote(quote);
      const row = openRaw({ readonly: true })
        .prepare("SELECT typeof(sats) AS s, typeof(fiber_amount) AS f, typeof(created_at) AS c, typeof(expires_at) AS e, typeof(price_at) AS p FROM quotes WHERE id = ?")
        .get(quote.id);
      expect(row).toEqual({ s: SQLITE_TYPE.TEXT, f: SQLITE_TYPE.TEXT, c: SQLITE_TYPE.INTEGER, e: SQLITE_TYPE.INTEGER, p: SQLITE_TYPE.INTEGER });
    });

    it("stores event times as INTEGER ms", () => {
      const store = openStore();
      const swap = makeSwap(clock);
      store.createSwap(swap);
      store.addEvent(makeEvent(swap.id, clock.now()));
      const row = openRaw({ readonly: true }).prepare("SELECT typeof(at) AS t, at FROM swap_events").get();
      expect(row).toEqual({ t: SQLITE_TYPE.INTEGER, at: clock.now() });
    });
  });

  describe("schema", () => {
    const tableSql = (db: Database.Database, name: string): string =>
      (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as { sql: string } | undefined)?.sql ?? "";

    it("creates the quotes, swaps and swap_events tables", () => {
      openStore().close();
      const db = openRaw({ readonly: true });
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
      expect(tables).toEqual(expect.arrayContaining(["quotes", "swaps", "swap_events", "schema_version"]));
    });

    it("makes payment_hash UNIQUE and indexes swaps by state", () => {
      openStore().close();
      const db = openRaw({ readonly: true });
      const indexes = db.pragma("index_list(swaps)") as { name: string; unique: number }[];
      const uniqueColumns = indexes
        .filter((index) => index.unique === 1)
        .flatMap((index) => (db.pragma(`index_info(${index.name})`) as { name: string }[]).map((c) => c.name));
      expect(uniqueColumns).toContain("payment_hash");
      const indexedColumns = indexes.flatMap((index) => (db.pragma(`index_info(${index.name})`) as { name: string }[]).map((c) => c.name));
      expect(indexedColumns).toContain("state");
    });

    it("links swap_events to swaps with a foreign key", () => {
      openStore().close();
      const keys = openRaw({ readonly: true }).pragma("foreign_key_list(swap_events)") as { table: string; from: string; to: string }[];
      expect(keys).toEqual([expect.objectContaining({ table: "swaps", from: "swap_id", to: "id" })]);
    });

    it("declares strict tables, so a wrong type cannot slip in", () => {
      openStore().close();
      const db = openRaw({ readonly: true });
      ["quotes", "swaps", "swap_events"].forEach((table) => expect(tableSql(db, table)).toMatch(/\)\s*STRICT\s*$/i));
    });
  });

  describe("connection settings", () => {
    it("turns on WAL, foreign keys and synchronous FULL for a file database", () => {
      const db = openSqliteDatabase(dbPath);
      opened.push(db);
      expect(db.pragma("journal_mode", { simple: true })).toBe(JOURNAL_MODE_WAL);
      expect(db.pragma("foreign_keys", { simple: true })).toBe(FOREIGN_KEYS_ON);
      expect(db.pragma("synchronous", { simple: true })).toBe(SYNCHRONOUS_FULL);
    });

    it("keeps foreign keys and synchronous FULL for an in-memory database", () => {
      const db = openSqliteDatabase(SQLITE_IN_MEMORY_PATH);
      opened.push(db);
      expect(db.memory).toBe(true);
      expect(db.pragma("foreign_keys", { simple: true })).toBe(FOREIGN_KEYS_ON);
      expect(db.pragma("synchronous", { simple: true })).toBe(SYNCHRONOUS_FULL);
    });

    it("leaves the file in WAL mode for the next connection", () => {
      openStore().close();
      expect(openRaw().pragma("journal_mode", { simple: true })).toBe(JOURNAL_MODE_WAL);
    });

    it("creates missing parent directories for a file path", () => {
      dbPath = join(dir, "nested", "deeper", "hub.sqlite");
      const store = openStore();
      store.createSwap(makeSwap(clock));
      expect(existsSync(dbPath)).toBe(true);
    });

    it("opens a file in an existing directory", () => {
      openStore().close();
      expect(existsSync(dbPath)).toBe(true);
    });
  });
});
