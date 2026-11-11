import { API_ERROR_CODE } from "../../../src/common/constants/api.constants";
import { SQLITE_IN_MEMORY_PATH } from "../../../src/common/constants/persistence.constants";
import { OPEN_SWAP_STATES, SWAP_EVENT, TERMINAL_SWAP_STATES } from "../../../src/common/constants/swap.constants";
import { DuplicateHashError, HubError, NotFoundError, QuoteAlreadyUsedError } from "../../../src/common/errors/hub.error";
import type { Swap, SwapState } from "../../../src/domain/types";
import { openSqliteSwapStore, SqliteSwapStore } from "../../../src/infrastructure/persistence/sqlite-swap-store";
import { openSqliteDatabase } from "../../../src/infrastructure/persistence/sqlite.database";
import { MIGRATIONS } from "../../../src/infrastructure/persistence/sqlite.migrations";
import { runMigrations } from "../../../src/infrastructure/persistence/sqlite.migrator";
import { TABLE } from "../../../src/infrastructure/persistence/sqlite.constants";
import { toQuoteRow, toSwapRow } from "../../../src/infrastructure/persistence/swap-store.rows";
import { FakeClock } from "../../fakes";
import { BEYOND_U64, MAX_U128, makeEvent, makeFiberToLnSwap, makeQuote, makeSwap, newPreimage } from "./persistence.fixtures";

const HTTP_CONFLICT = 409;
const HTTP_NOT_FOUND = 404;

describe("SqliteSwapStore", () => {
  let clock: FakeClock;
  let store: SqliteSwapStore;

  beforeEach(() => {
    clock = new FakeClock();
    store = openSqliteSwapStore(SQLITE_IN_MEMORY_PATH, clock);
  });

  afterEach(() => store.close());

  describe("quotes", () => {
    it("round-trips every field exactly, including u128 amounts and fractional prices", () => {
      const quote = makeQuote(clock, { direction: "fiber_to_ln", asset: "RUSD", sats: MAX_U128, fiberAmount: BEYOND_U64, btcUsd: 0.1 + 0.2, assetUsd: 1e-12 });
      store.saveQuote(quote);
      const read = store.getQuote(quote.id);
      expect(read).toEqual(quote);
      expect(typeof read?.sats).toBe("bigint");
      expect(read?.fiberAmount).toBe(BEYOND_U64);
    });

    it("stores zero amounts", () => {
      const quote = makeQuote(clock, { sats: 0n, fiberAmount: 0n });
      store.saveQuote(quote);
      expect(store.getQuote(quote.id)).toEqual(quote);
    });

    it("saving a quote with an existing id replaces it, like the fake's Map.set", () => {
      const quote = makeQuote(clock);
      store.saveQuote(quote);
      const replacement = { ...makeQuote(clock, { sats: 1n, expiresAt: quote.expiresAt + 1 }), id: quote.id };
      store.saveQuote(replacement);
      expect(store.getQuote(quote.id)).toEqual(replacement);
    });

    it("keeps quotes independent of each other", () => {
      const a = makeQuote(clock);
      const b = makeQuote(clock, { asset: "CWBTC" });
      store.saveQuote(a);
      store.saveQuote(b);
      expect(store.getQuote(a.id)).toEqual(a);
      expect(store.getQuote(b.id)).toEqual(b);
    });

    it("returns null for an unknown quote id", () => {
      expect(store.getQuote("no-such-quote")).toBeNull();
    });
  });

  describe("createSwap and reads", () => {
    it("round-trips an ln_to_fiber swap with every nullable field null", () => {
      const swap = makeSwap(clock, { holdCltvExpiry: null, payoutLockLimit: null });
      store.createSwap(swap);
      expect(store.getSwap(swap.id)).toEqual(swap);
    });

    it("round-trips a fiber_to_ln demo swap with every nullable field set", () => {
      const preimage = newPreimage();
      const swap = makeFiberToLnSwap(clock, { state: "failed", preimage, failureReason: "Route not found", refunded: true, sats: MAX_U128, fiberAmount: BEYOND_U64 });
      store.createSwap(swap);
      const read = store.getSwap(swap.id);
      expect(read).toEqual(swap);
      expect(read?.demo).toBe(true);
      expect(read?.refunded).toBe(true);
    });

    it("returns booleans as booleans and amounts as bigints, never numbers or strings", () => {
      const swap = makeSwap(clock);
      store.createSwap(swap);
      const read = store.getSwapByHash(swap.paymentHash)!;
      expect(read.refunded).toBe(false);
      expect(read.demo).toBe(false);
      expect(typeof read.sats).toBe("bigint");
      expect(typeof read.fiberAmount).toBe("bigint");
      expect(typeof read.createdAt).toBe("number");
    });

    it("throws DuplicateHashError (409, duplicate_hash) for a reused payment hash", () => {
      const first = makeSwap(clock);
      store.createSwap(first);
      let thrown: unknown;
      try {
        store.createSwap(makeSwap(clock, { paymentHash: first.paymentHash }));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(DuplicateHashError);
      expect(thrown).toBeInstanceOf(HubError);
      expect(thrown).toMatchObject({ status: HTTP_CONFLICT, code: API_ERROR_CODE.DUPLICATE_HASH });
    });

    it.each(TERMINAL_SWAP_STATES)("never reuses the hash of a swap that ended %s", (state) => {
      const old = makeSwap(clock, { state, refunded: state === "failed" });
      store.createSwap(old);
      expect(() => store.createSwap(makeSwap(clock, { paymentHash: old.paymentHash, direction: "fiber_to_ln" }))).toThrow(DuplicateHashError);
    });

    it("never overwrites a stored swap when a new one reuses its id", () => {
      const original = makeSwap(clock);
      store.createSwap(original);
      const sameId = makeSwap(clock, { id: original.id, state: "succeeded" });
      expect(() => store.createSwap(sameId)).toThrow();
      expect(store.getSwap(original.id)).toEqual(original);
      expect(store.getSwapByHash(sameId.paymentHash)).toBeNull();
    });

    it("throws QuoteAlreadyUsedError (409, conflict) for a second swap on the same quote, whatever its hash", () => {
      const first = makeSwap(clock);
      store.createSwap(first);
      let thrown: unknown;
      try {
        store.createSwap(makeSwap(clock, { quoteId: first.quoteId }));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(QuoteAlreadyUsedError);
      expect(thrown).toMatchObject({ status: HTTP_CONFLICT, code: API_ERROR_CODE.CONFLICT });
      expect(store.listOpenSwaps()).toEqual([first]);
    });

    it("finds a swap by its quote id, and null for a quote without a swap", () => {
      const swap = makeSwap(clock);
      store.createSwap(swap);
      expect(store.getSwapByQuoteId(swap.quoteId)).toEqual(swap);
      expect(store.getSwapByQuoteId("no-such-quote")).toBeNull();
    });

    it("a failed insert leaves the store usable", () => {
      const first = makeSwap(clock);
      store.createSwap(first);
      expect(() => store.createSwap(makeSwap(clock, { paymentHash: first.paymentHash }))).toThrow(DuplicateHashError);
      const next = makeSwap(clock);
      store.createSwap(next);
      expect(store.getSwap(next.id)).toEqual(next);
    });
  });

  describe("transition (compare-and-set)", () => {
    const createPending = (): Swap => {
      const swap = makeSwap(clock);
      store.createSwap(swap);
      return swap;
    };

    it("saves a preimage together with the state change", () => {
      const swap = createPending();
      store.transition(swap.id, "pending", { state: "incoming_accepted" });
      store.transition(swap.id, "incoming_accepted", { state: "outgoing_in_flight" });
      const preimage = newPreimage();
      clock.advance(60_000);
      const next = store.transition(swap.id, "outgoing_in_flight", { state: "outgoing_succeeded", preimage });
      expect(next).toMatchObject({ state: "outgoing_succeeded", preimage, updatedAt: clock.now() });
      expect(store.getSwap(swap.id)).toEqual(next);
    });

    it("lets exactly one of two racing transitions from the same state win", () => {
      const swap = createPending();
      const winner = store.transition(swap.id, "pending", { state: "incoming_accepted" });
      const loser = store.transition(swap.id, "pending", { state: "failed", failureReason: "quote expired" });
      expect(winner?.state).toBe("incoming_accepted");
      expect(loser).toBeNull();
      expect(store.getSwap(swap.id)?.state).toBe("incoming_accepted");
    });

    it("leaves updatedAt alone when it loses", () => {
      const swap = createPending();
      clock.advance(10_000);
      expect(store.transition(swap.id, "outgoing_in_flight", { state: "failed" })).toBeNull();
      expect(store.getSwap(swap.id)?.updatedAt).toBe(swap.updatedAt);
    });

    it("can change fields without changing the state (from = current state)", () => {
      const swap = createPending();
      clock.advance(1_000);
      const next = store.transition(swap.id, "pending", { payoutLockLimit: 42 });
      expect(next).toEqual({ ...swap, payoutLockLimit: 42, updatedAt: clock.now() });
    });

    it("can set nullable fields back to null", () => {
      const swap = makeSwap(clock, { failureReason: "transient", holdCltvExpiry: 99 });
      store.createSwap(swap);
      const next = store.transition(swap.id, "pending", { failureReason: null, holdCltvExpiry: null });
      expect(next).toMatchObject({ failureReason: null, holdCltvExpiry: null });
      expect(store.getSwap(swap.id)).toMatchObject({ failureReason: null, holdCltvExpiry: null });
    });

    it("uses the clock for updatedAt even when the patch carries one", () => {
      const swap = createPending();
      clock.advance(7_000);
      const next = store.transition(swap.id, "pending", { state: "incoming_accepted", updatedAt: 1 });
      expect(next?.updatedAt).toBe(clock.now());
    });

    it("never changes id or createdAt, even if a patch smuggles them in", () => {
      const swap = createPending();
      const smuggled = { state: "incoming_accepted", id: "other-id", createdAt: 1 } as unknown as Partial<Swap>;
      const next = store.transition(swap.id, "pending", smuggled);
      expect(next).toMatchObject({ id: swap.id, createdAt: swap.createdAt, state: "incoming_accepted" });
      expect(store.getSwap("other-id")).toBeNull();
      expect(store.getSwap(swap.id)?.createdAt).toBe(swap.createdAt);
    });

    it("ignores patch fields given as undefined", () => {
      const swap = makeSwap(clock, { failureReason: "kept" });
      store.createSwap(swap);
      const next = store.transition(swap.id, "pending", { state: "incoming_accepted", failureReason: undefined });
      expect(next?.failureReason).toBe("kept");
      expect(store.getSwap(swap.id)?.failureReason).toBe("kept");
    });

    it("returns null for an unknown swap and creates nothing", () => {
      expect(store.transition("no-such-swap", "pending", { state: "incoming_accepted" })).toBeNull();
      expect(store.getSwap("no-such-swap")).toBeNull();
    });

    it("rejects moving the payment hash onto another swap's hash and keeps the row", () => {
      const a = createPending();
      const b = createPending();
      expect(() => store.transition(b.id, "pending", { paymentHash: a.paymentHash })).toThrow();
      expect(store.getSwap(b.id)).toEqual(b);
    });

    it("walks the full happy path, one compare-and-set per step", () => {
      const swap = createPending();
      const path: [SwapState, SwapState][] = [
        ["pending", "incoming_accepted"],
        ["incoming_accepted", "outgoing_in_flight"],
        ["outgoing_in_flight", "outgoing_succeeded"],
        ["outgoing_succeeded", "succeeded"],
      ];
      for (const [from, to] of path) {
        clock.advance(1_000);
        expect(store.transition(swap.id, from, { state: to })?.state).toBe(to);
      }
      expect(store.getSwap(swap.id)).toMatchObject({ state: "succeeded", updatedAt: clock.now(), createdAt: swap.createdAt });
    });
  });

  describe("update", () => {
    it("marks a failed swap refunded and bumps updatedAt", () => {
      const swap = makeSwap(clock, { state: "failed", failureReason: "Fiber payment failed" });
      store.createSwap(swap);
      clock.advance(3_000);
      const updated = store.update(swap.id, { refunded: true });
      expect(updated).toEqual({ ...swap, refunded: true, updatedAt: clock.now() });
      expect(store.getSwap(swap.id)).toEqual(updated);
    });

    it("throws NotFoundError (404, not_found) for an unknown swap", () => {
      let thrown: unknown;
      try {
        store.update("no-such-swap", { refunded: true });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(NotFoundError);
      expect(thrown).toMatchObject({ status: HTTP_NOT_FOUND, code: API_ERROR_CODE.NOT_FOUND });
      expect(store.getSwap("no-such-swap")).toBeNull();
    });

    it("never changes the state, even when the patch carries one", () => {
      const swap = makeSwap(clock, { state: "outgoing_in_flight" });
      store.createSwap(swap);
      const patch = { state: "failed", failureReason: "should not fail an in-flight swap" } as unknown as Partial<Swap>;
      const updated = store.update(swap.id, patch);
      expect(updated.state).toBe("outgoing_in_flight");
      expect(store.getSwap(swap.id)?.state).toBe("outgoing_in_flight");
      expect(store.getSwap(swap.id)?.failureReason).toBe("should not fail an in-flight swap");
    });

    it("never changes id or createdAt", () => {
      const swap = makeSwap(clock);
      store.createSwap(swap);
      const patch = { id: "hijack", createdAt: 0, demo: true } as unknown as Partial<Swap>;
      const updated = store.update(swap.id, patch);
      expect(updated).toMatchObject({ id: swap.id, createdAt: swap.createdAt, demo: true });
      expect(store.getSwap("hijack")).toBeNull();
    });

    it("ignores patch fields given as undefined", () => {
      const swap = makeSwap(clock, { failureReason: "kept" });
      store.createSwap(swap);
      expect(store.update(swap.id, { failureReason: undefined, refunded: true }).failureReason).toBe("kept");
    });

    it("does not need a state match: works on a terminal swap", () => {
      const swap = makeSwap(clock, { state: "succeeded" });
      store.createSwap(swap);
      expect(store.update(swap.id, { failureReason: "note" })).toMatchObject({ state: "succeeded", failureReason: "note" });
    });
  });

  describe("listOpenSwaps", () => {
    it("is empty for an empty store", () => {
      expect(store.listOpenSwaps()).toEqual([]);
    });

    it.each(OPEN_SWAP_STATES)("includes a swap in the open state %s", (state) => {
      const swap = makeSwap(clock, { state });
      store.createSwap(swap);
      expect(store.listOpenSwaps()).toEqual([swap]);
    });

    it("includes outgoing_succeeded even when marked refunded: a known preimage still has to be settled", () => {
      const swap = makeSwap(clock, { state: "outgoing_succeeded", preimage: newPreimage(), refunded: true });
      store.createSwap(swap);
      expect(store.listOpenSwaps()).toEqual([swap]);
    });

    it("includes a failed swap until its refund is recorded, then drops it", () => {
      const swap = makeSwap(clock, { state: "failed", failureReason: "Route not found" });
      store.createSwap(swap);
      expect(store.listOpenSwaps().map((s) => s.id)).toEqual([swap.id]);
      store.update(swap.id, { refunded: true });
      expect(store.listOpenSwaps()).toEqual([]);
    });

    it("excludes succeeded swaps and failed swaps already refunded", () => {
      store.createSwap(makeSwap(clock, { state: "succeeded", preimage: newPreimage() }));
      store.createSwap(makeSwap(clock, { state: "failed", refunded: true }));
      expect(store.listOpenSwaps()).toEqual([]);
    });

    it("drops a swap once a transition makes it succeed", () => {
      const swap = makeSwap(clock, { state: "outgoing_succeeded", preimage: newPreimage() });
      store.createSwap(swap);
      store.transition(swap.id, "outgoing_succeeded", { state: "succeeded" });
      expect(store.listOpenSwaps()).toEqual([]);
    });

    it("orders by createdAt, not by insertion or update time", () => {
      const t = clock.now();
      const newest = makeSwap(clock, { createdAt: t + 3_000 });
      const oldest = makeSwap(clock, { createdAt: t - 3_000, state: "outgoing_in_flight" });
      const middle = makeSwap(clock, { createdAt: t, state: "failed" });
      [newest, oldest, middle].forEach((swap) => store.createSwap(swap));
      clock.advance(10_000);
      store.update(oldest.id, { failureReason: "touched last" });
      expect(store.listOpenSwaps().map((s) => s.id)).toEqual([oldest.id, middle.id, newest.id]);
    });

    it("breaks createdAt ties by insertion order", () => {
      const swaps = Array.from({ length: 5 }, () => makeSwap(clock));
      swaps.forEach((swap) => store.createSwap(swap));
      expect(store.listOpenSwaps().map((s) => s.id)).toEqual(swaps.map((s) => s.id));
    });
  });

  describe("events", () => {
    it("keeps insertion order even when timestamps go backwards or repeat", () => {
      const swap = makeSwap(clock);
      store.createSwap(swap);
      const t = clock.now();
      const events = [
        makeEvent(swap.id, t, SWAP_EVENT.CREATED, "first"),
        makeEvent(swap.id, t - 5_000, SWAP_EVENT.INCOMING_ACCEPTED, "second"),
        makeEvent(swap.id, t - 5_000, SWAP_EVENT.PAYOUT_STARTED, "third"),
        makeEvent(swap.id, t + 1, SWAP_EVENT.ERROR, "fourth"),
      ];
      events.forEach((event) => store.addEvent(event));
      expect(store.listEvents(swap.id)).toEqual(events);
    });

    it("stores duplicate events as separate entries", () => {
      const swap = makeSwap(clock);
      store.createSwap(swap);
      const event = makeEvent(swap.id, clock.now(), SWAP_EVENT.ERROR, "retrying settle");
      store.addEvent(event);
      store.addEvent(event);
      expect(store.listEvents(swap.id)).toEqual([event, event]);
    });

    it("round-trips empty, multi-line and non-ASCII details", () => {
      const swap = makeSwap(clock);
      store.createSwap(swap);
      const details = ["", "line one\nline two", "Thanh toán thất bại: không tìm thấy đường 🚫", "'; DROP TABLE swaps; --"];
      details.forEach((detail) => store.addEvent(makeEvent(swap.id, clock.now(), SWAP_EVENT.ERROR, detail)));
      expect(store.listEvents(swap.id).map((e) => e.detail)).toEqual(details);
      expect(store.getSwap(swap.id)).toEqual(swap);
    });

    it("returns an empty list for a swap with no events or no swap at all", () => {
      const swap = makeSwap(clock);
      store.createSwap(swap);
      expect(store.listEvents(swap.id)).toEqual([]);
      expect(store.listEvents("no-such-swap")).toEqual([]);
    });

    it("rejects an event for a swap that does not exist with NotFoundError, leaving no orphan", () => {
      expect(() => store.addEvent(makeEvent("no-such-swap", clock.now()))).toThrow(NotFoundError);
      expect(store.listEvents("no-such-swap")).toEqual([]);
    });
  });

  describe("upgrading a version-1 database (migration 2: one swap per quote; 4: quote purpose; 5: cancel token hash)", () => {
    /** The columns a version-1 hub wrote: today's, less those later migrations added. */
    const LATER_QUOTE_COLUMNS: readonly string[] = ["purpose"];
    const LATER_SWAP_COLUMNS: readonly string[] = ["cancel_token_hash"];

    /** Writes `row` with only the columns a version-1 database has, as a hub of that version did. */
    function insertV1(db: ReturnType<typeof openSqliteDatabase>, table: string, row: object, later: readonly string[]): void {
      const entries = Object.entries(row).filter(([column]) => !later.includes(column));
      const columns = entries.map(([column]) => column);
      db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...entries.map(([, value]) => value));
    }

    it("keeps its swaps (no cancel token, so they cannot be cancelled) and quotes (all swap quotes), and refuses a second swap on one of their quotes", () => {
      const db = openSqliteDatabase(SQLITE_IN_MEMORY_PATH);
      runMigrations(db, MIGRATIONS.slice(0, 1), clock);
      const quote = makeQuote(clock);
      const swaps = [makeSwap(clock, { quoteId: quote.id, cancelTokenHash: null }), makeFiberToLnSwap(clock, { cancelTokenHash: null })];
      insertV1(db, TABLE.QUOTES, toQuoteRow(quote), LATER_QUOTE_COLUMNS);
      swaps.forEach((swap) => insertV1(db, TABLE.SWAPS, toSwapRow(swap), LATER_SWAP_COLUMNS));

      expect(runMigrations(db, MIGRATIONS, clock)).toBe(MIGRATIONS[MIGRATIONS.length - 1]?.version);
      const upgraded = new SqliteSwapStore(db, clock);
      expect(upgraded.getSwap(swaps[0]!.id)).toEqual(swaps[0]);
      expect(upgraded.getSwapByQuoteId(swaps[1]!.quoteId)).toEqual(swaps[1]);
      expect(upgraded.getQuote(quote.id)).toEqual({ ...quote, purpose: "swap" });
      expect(() => upgraded.createSwap(makeSwap(clock, { quoteId: swaps[0]!.quoteId }))).toThrow(QuoteAlreadyUsedError);
      upgraded.close();
    });
  });

  describe("close", () => {
    it("can be called twice", () => {
      store.close();
      expect(() => store.close()).not.toThrow();
    });

    it("refuses reads and writes after close instead of silently dropping them", () => {
      const swap = makeSwap(clock);
      store.createSwap(swap);
      store.close();
      expect(() => store.getSwap(swap.id)).toThrow();
      expect(() => store.createSwap(makeSwap(clock))).toThrow();
      expect(() => store.transition(swap.id, "pending", { state: "incoming_accepted" })).toThrow();
    });
  });

  /**
   * better-sqlite3 caches its native addon per process and registers its SqliteError class only once, so every error is
   * an instance of the first loaded copy's class. A second module registry (another Jest test file in the same worker,
   * jest.isolateModules, a bundler) must still map constraint errors to domain errors: match by error code, not class.
   */
  describe("constraint mapping with a second copy of the module loaded", () => {
    type StoreModule = typeof import("../../../src/infrastructure/persistence/sqlite-swap-store");

    const loadIsolatedStoreModule = (): StoreModule => {
      let loaded: StoreModule | undefined;
      jest.isolateModules(() => {
        loaded = require("../../../src/infrastructure/persistence/sqlite-swap-store") as StoreModule;
      });
      return loaded!;
    };

    let isolated: SqliteSwapStore;

    beforeEach(() => {
      isolated = loadIsolatedStoreModule().openSqliteSwapStore(SQLITE_IN_MEMORY_PATH, clock);
    });

    afterEach(() => isolated.close());

    it("still throws the duplicate-hash domain error", () => {
      const swap = makeSwap(clock);
      isolated.createSwap(swap);
      expect(() => isolated.createSwap(makeSwap(clock, { paymentHash: swap.paymentHash }))).toThrow(
        expect.objectContaining({ name: "DuplicateHashError", status: HTTP_CONFLICT, code: API_ERROR_CODE.DUPLICATE_HASH }),
      );
    });

    it("still throws the not-found domain error for an event on an unknown swap", () => {
      expect(() => isolated.addEvent(makeEvent("no-such-swap", clock.now()))).toThrow(
        expect.objectContaining({ name: "NotFoundError", status: HTTP_NOT_FOUND, code: API_ERROR_CODE.NOT_FOUND }),
      );
    });
  });

  it("keeps two in-memory stores private to each other", () => {
    const other = openSqliteSwapStore(SQLITE_IN_MEMORY_PATH, clock);
    try {
      const swap = makeSwap(clock);
      store.createSwap(swap);
      expect(other.getSwap(swap.id)).toBeNull();
      expect(() => other.createSwap(makeSwap(clock, { paymentHash: swap.paymentHash }))).not.toThrow();
    } finally {
      other.close();
    }
  });
});
