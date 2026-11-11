import type { SwapStore } from "../../../src/application/ports/swap-store.port";
import { SQLITE_IN_MEMORY_PATH } from "../../../src/common/constants/persistence.constants";
import { OPEN_SWAP_STATES, SWAP_EVENT } from "../../../src/common/constants/swap.constants";
import { DuplicateHashError, NotFoundError, QuoteAlreadyUsedError } from "../../../src/common/errors/hub.error";
import type { SwapState } from "../../../src/domain/types";
import { openSqliteSwapStore } from "../../../src/infrastructure/persistence/sqlite-swap-store";
import { FakeClock, FakeSwapStore } from "../../fakes";
import { makeEvent, makeQuote, makeSwap } from "./persistence.fixtures";

/**
 * The port's documented semantics, run against both the SQLite store and the fake every other module's tests use. If
 * the two ever disagree here, tests written against the fake stop meaning anything for production.
 */
type StoreFactory = (clock: FakeClock) => SwapStore;

const implementations: [string, StoreFactory][] = [
  ["FakeSwapStore", (clock) => new FakeSwapStore(clock)],
  ["SqliteSwapStore", (clock) => openSqliteSwapStore(SQLITE_IN_MEMORY_PATH, clock)],
];

describe.each(implementations)("SwapStore port semantics: %s", (_name, createStore) => {
  let clock: FakeClock;
  let store: SwapStore;

  beforeEach(() => {
    clock = new FakeClock();
    store = createStore(clock);
  });

  afterEach(() => store.close());

  it("returns a saved quote as it was saved, and null for an unknown id", () => {
    const quote = makeQuote(clock);
    store.saveQuote(quote);
    expect(store.getQuote(quote.id)).toEqual(quote);
    expect(store.getQuote("missing")).toBeNull();
  });

  it("finds a created swap by id and by payment hash", () => {
    const swap = makeSwap(clock);
    store.createSwap(swap);
    expect(store.getSwap(swap.id)).toEqual(swap);
    expect(store.getSwapByHash(swap.paymentHash)).toEqual(swap);
    expect(store.getSwap("missing")).toBeNull();
    expect(store.getSwapByHash("0".repeat(64))).toBeNull();
  });

  it("rejects a second swap with the same payment hash with DuplicateHashError", () => {
    const first = makeSwap(clock);
    store.createSwap(first);
    const second = makeSwap(clock, { paymentHash: first.paymentHash });
    expect(() => store.createSwap(second)).toThrow(DuplicateHashError);
    expect(store.getSwap(second.id)).toBeNull();
    expect(store.getSwapByHash(first.paymentHash)).toEqual(first);
  });

  it("rejects a second swap on the same quote with QuoteAlreadyUsedError and finds a swap by its quote id", () => {
    const first = makeSwap(clock);
    store.createSwap(first);
    const second = makeSwap(clock, { quoteId: first.quoteId });
    expect(() => store.createSwap(second)).toThrow(QuoteAlreadyUsedError);
    expect(store.getSwap(second.id)).toBeNull();
    expect(store.getSwapByQuoteId(first.quoteId)).toEqual(first);
    expect(store.getSwapByQuoteId("missing")).toBeNull();
  });

  it("leaves a field unchanged when a patch gives it as undefined, in transition and in update", () => {
    const swap = makeSwap(clock, { failureReason: "kept" });
    store.createSwap(swap);
    clock.advance(1_000);
    const moved = store.transition(swap.id, "pending", { state: "failed", failureReason: undefined, preimage: undefined });
    expect(moved).toMatchObject({ state: "failed", failureReason: "kept", preimage: null });
    const updated = store.update(swap.id, { refunded: true, failureReason: undefined });
    expect(updated).toMatchObject({ refunded: true, failureReason: "kept" });
    expect(store.getSwap(swap.id)).toEqual(updated);
  });

  it("clears a nullable field given as null", () => {
    const swap = makeSwap(clock, { failureReason: "old" });
    store.createSwap(swap);
    expect(store.update(swap.id, { failureReason: null })).toMatchObject({ failureReason: null });
  });

  it("throws NotFoundError for an update or an event of an unknown swap", () => {
    expect(() => store.update("missing", { refunded: true })).toThrow(NotFoundError);
    expect(() => store.addEvent(makeEvent("missing", clock.now()))).toThrow(NotFoundError);
  });

  it("transition applies the patch and bumps updatedAt from the clock when the state matches", () => {
    const swap = makeSwap(clock);
    store.createSwap(swap);
    clock.advance(5_000);
    const next = store.transition(swap.id, "pending", { state: "incoming_accepted" });
    expect(next).toEqual({ ...swap, state: "incoming_accepted", updatedAt: clock.now() });
    expect(store.getSwap(swap.id)).toEqual(next);
  });

  it("transition returns null and changes nothing when the state already moved on", () => {
    const swap = makeSwap(clock);
    store.createSwap(swap);
    store.transition(swap.id, "pending", { state: "incoming_accepted" });
    const before = store.getSwap(swap.id);
    clock.advance(1_000);
    expect(store.transition(swap.id, "pending", { state: "failed", failureReason: "late" })).toBeNull();
    expect(store.getSwap(swap.id)).toEqual(before);
  });

  it("transition returns null for an unknown swap", () => {
    expect(store.transition("missing", "pending", { state: "failed" })).toBeNull();
  });

  it("update changes fields, bumps updatedAt and returns the stored swap", () => {
    const swap = makeSwap(clock, { state: "failed", failureReason: "payout failed" });
    store.createSwap(swap);
    clock.advance(2_000);
    const updated = store.update(swap.id, { refunded: true });
    expect(updated).toEqual({ ...swap, refunded: true, updatedAt: clock.now() });
    expect(store.getSwap(swap.id)).toEqual(updated);
  });

  it("update throws for an unknown swap", () => {
    expect(() => store.update("missing", { refunded: true })).toThrow();
  });

  it("lists open swaps (open states plus failed-not-refunded), oldest first", () => {
    const start = clock.now();
    const byState = (state: SwapState, ageMs: number, refunded = false) =>
      makeSwap(clock, { state, refunded, createdAt: start - ageMs, updatedAt: start - ageMs });
    const open = OPEN_SWAP_STATES.map((state, index) => byState(state, (index + 1) * 1_000));
    const failedNotRefunded = byState("failed", 500);
    const closed = [byState("succeeded", 10_000), byState("failed", 20_000, true)];
    [...closed, failedNotRefunded, ...open].forEach((swap) => store.createSwap(swap));

    const expected = [...open, failedNotRefunded].sort((a, b) => a.createdAt - b.createdAt);
    expect(store.listOpenSwaps()).toEqual(expected);
  });

  it("lists a swap's events in insertion order, only for that swap", () => {
    const a = makeSwap(clock);
    const b = makeSwap(clock);
    store.createSwap(a);
    store.createSwap(b);
    const t = clock.now();
    const aEvents = [makeEvent(a.id, t + 30, SWAP_EVENT.CREATED), makeEvent(a.id, t + 10, SWAP_EVENT.INCOMING_ACCEPTED), makeEvent(a.id, t + 20, SWAP_EVENT.PAYOUT_STARTED)];
    store.addEvent(aEvents[0]!);
    store.addEvent(makeEvent(b.id, t, SWAP_EVENT.CREATED));
    store.addEvent(aEvents[1]!);
    store.addEvent(aEvents[2]!);
    expect(store.listEvents(a.id)).toEqual(aEvents);
    expect(store.listEvents("missing")).toEqual([]);
  });

  it("hands out copies: changing a returned or saved object does not change the store", () => {
    const swap = makeSwap(clock);
    store.createSwap(swap);
    swap.state = "succeeded";
    const read = store.getSwap(swap.id)!;
    read.refunded = true;
    expect(store.getSwap(swap.id)).toMatchObject({ state: "pending", refunded: false });
  });
});
