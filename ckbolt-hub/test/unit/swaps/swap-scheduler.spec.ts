import type { FiberPort } from "../../../src/application/ports/fiber.port";
import type { LightningPort } from "../../../src/application/ports/lightning.port";
import type { CreatedSwap, CreateSwapInput, SwapEngine } from "../../../src/application/swaps/swap-engine.contract";
import { SwapSchedulerService } from "../../../src/application/swaps/swap-scheduler.service";
import { createPendingSwap } from "../../../src/domain/swap";
import type { Swap, SwapEvent, SwapState } from "../../../src/domain/types";
import { FakeClock, FakeFiberNetwork, FakeLightningNetwork, FakeSwapStore, type FakeFiberNode, type FakeLightningNode } from "../../fakes";
import { deferred, HUB_PUBKEY, minutes, silenceLogs, swapConfig } from "./swaps.fixtures";

/**
 * SwapSchedulerService: on module init one recovery pass over every open swap, then a pass every
 * config.swaps.pollIntervalMs; node push hints (onUpdate) process the matching open swap early; on destroy no new work
 * starts and running work is awaited. The engine is a stub here, so only the scheduling is under test.
 */

const POLL_MS = 5_000;

/** Records calls; processSwap can be scripted per test. */
class StubEngine implements SwapEngine {
  readonly processOpenSwaps = jest.fn(async (): Promise<void> => undefined);
  readonly processSwap = jest.fn(async (_id: string): Promise<void> => undefined);

  constructor(private readonly store: FakeSwapStore) {}

  createSwap(_input: CreateSwapInput): Promise<CreatedSwap> {
    return Promise.reject(new Error("not used by the scheduler"));
  }

  cancelSwap(_id: string, _cancelToken: string | undefined): Promise<Swap> {
    return Promise.reject(new Error("not used by the scheduler"));
  }

  getSwap(id: string): Swap | null {
    return this.store.getSwap(id);
  }

  listEvents(swapId: string): SwapEvent[] {
    return this.store.listEvents(swapId);
  }
}

interface SchedulerHarness {
  clock: FakeClock;
  store: FakeSwapStore;
  engine: StubEngine;
  lightning: FakeLightningNode;
  fiber: FakeFiberNode;
  scheduler: SwapSchedulerService;
}

function makeScheduler(ports: { lightning?: LightningPort; fiber?: FiberPort } = {}): SchedulerHarness {
  const clock = new FakeClock();
  const store = new FakeSwapStore(clock);
  const engine = new StubEngine(store);
  const lightning = new FakeLightningNetwork("regtest", clock).node("hub");
  const fiber = new FakeFiberNetwork("devnet", clock).node("hub");
  const config = swapConfig({ swaps: { pollIntervalMs: POLL_MS } });
  const scheduler = new SwapSchedulerService(engine, store, ports.lightning ?? lightning, ports.fiber ?? fiber, config);
  return { clock, store, engine, lightning, fiber, scheduler };
}

let swapCounter = 0;

/** Saves a swap in `state` and returns it. */
function seedSwap(store: FakeSwapStore, state: SwapState, patch: Partial<Swap> = {}): Swap {
  swapCounter += 1;
  const now = Date.UTC(2026, 9, 23, 12) + swapCounter;
  const swap = createPendingSwap({
    id: `swap-${swapCounter}`,
    quote: {
      id: `quote-${swapCounter}`,
      direction: "ln_to_fiber",
      asset: "CKB",
      sats: 10_000n,
      fiberAmount: 396_000_000_000n,
      btcUsd: 80_000,
      assetUsd: 0.002,
      priceSource: "median:fake",
      priceAt: now,
      feeBps: 100,
      purpose: "swap",
      createdAt: now,
      expiresAt: now + minutes(3),
      signature: "00".repeat(64),
      hubPubkey: HUB_PUBKEY,
    },
    paymentHash: swapCounter.toString(16).padStart(64, "0"),
    payoutInvoice: "payout",
    holdInvoice: "hold",
    timing: { holdCltvExpiry: 847, holdFinalExpiryDeltaMs: null, payoutLockLimit: minutes(410) },
    cancelTokenHash: "ef".repeat(32),
    demo: false,
    now,
  });
  const saved = { ...swap, state, ...patch };
  store.createSwap(saved);
  return saved;
}

const ORDER: SwapState[] = ["pending", "incoming_accepted", "outgoing_in_flight", "outgoing_succeeded", "succeeded"];

describe("SwapSchedulerService", () => {
  let s: SchedulerHarness;

  beforeEach(() => {
    silenceLogs();
    jest.useFakeTimers({ doNotFake: ["nextTick", "queueMicrotask", "setImmediate"] });
    s = makeScheduler();
  });

  afterEach(async () => {
    await s.scheduler.onModuleDestroy();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe("polling", () => {
    it("runs one recovery pass over the open swaps during module init, before it resolves", async () => {
      await s.scheduler.onModuleInit();
      expect(s.engine.processOpenSwaps).toHaveBeenCalledTimes(1);
    });

    it("then runs a pass every config.swaps.pollIntervalMs", async () => {
      await s.scheduler.onModuleInit();
      await jest.advanceTimersByTimeAsync(POLL_MS - 1);
      expect(s.engine.processOpenSwaps).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(s.engine.processOpenSwaps).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(POLL_MS * 3);
      expect(s.engine.processOpenSwaps).toHaveBeenCalledTimes(5);
    });

    it("keeps polling after a pass fails", async () => {
      s.engine.processOpenSwaps.mockRejectedValueOnce(new Error("store locked")).mockRejectedValueOnce(new Error("store locked"));
      await expect(s.scheduler.onModuleInit()).resolves.toBeUndefined();
      await jest.advanceTimersByTimeAsync(POLL_MS);
      await jest.advanceTimersByTimeAsync(POLL_MS);
      expect(s.engine.processOpenSwaps).toHaveBeenCalledTimes(3);
    });

    it("works with nodes that offer no push updates", async () => {
      const lightning = { ...s.lightning, onUpdate: undefined } as unknown as LightningPort;
      const fiber = { ...s.fiber, onUpdate: undefined } as unknown as FiberPort;
      const bare = makeScheduler({ lightning, fiber });
      await bare.scheduler.onModuleInit();
      await jest.advanceTimersByTimeAsync(POLL_MS);
      expect(bare.engine.processOpenSwaps).toHaveBeenCalledTimes(2);
      await bare.scheduler.onModuleDestroy();
    });
  });

  describe("push updates", () => {
    it.each(["lightning", "fiber"] as const)("an update from the %s node processes the open swap with that hash at once", async (node) => {
      const swap = seedSwap(s.store, "pending");
      const other = seedSwap(s.store, "pending");
      await s.scheduler.onModuleInit();

      s[node].emit(swap.paymentHash);
      await jest.advanceTimersByTimeAsync(0);

      expect(s.engine.processSwap).toHaveBeenCalledWith(swap.id);
      expect(s.engine.processSwap).not.toHaveBeenCalledWith(other.id);
    });

    it("moves the swap as far as it can go on one update, not just one step", async () => {
      const swap = seedSwap(s.store, "pending");
      s.engine.processSwap.mockImplementation(async (id: string) => {
        const current = s.store.getSwap(id);
        const next = current ? ORDER[ORDER.indexOf(current.state) + 1] : undefined;
        if (current && next) s.store.transition(id, current.state, { state: next });
      });
      await s.scheduler.onModuleInit();

      s.lightning.emit(swap.paymentHash);
      await jest.advanceTimersByTimeAsync(0);

      expect(s.store.getSwap(swap.id)?.state).toBe("succeeded");
      expect(s.engine.processSwap.mock.calls.length).toBeGreaterThanOrEqual(4);
    });

    it("never loops forever on one update, even if every step reports progress", async () => {
      const swap = seedSwap(s.store, "failed", { refunded: false });
      s.engine.processSwap.mockImplementation(async (id: string) => {
        const current = s.store.getSwap(id);
        if (current) s.store.update(id, { refunded: !current.refunded });
      });
      await s.scheduler.onModuleInit();

      s.fiber.emit(swap.paymentHash);
      await jest.advanceTimersByTimeAsync(0);

      expect(s.engine.processSwap.mock.calls.length).toBeGreaterThan(0);
      expect(s.engine.processSwap.mock.calls.length).toBeLessThanOrEqual(10);
    });

    it("ignores updates for unknown hashes and for swaps that are finished", async () => {
      const succeeded = seedSwap(s.store, "succeeded");
      const refunded = seedSwap(s.store, "failed", { refunded: true });
      await s.scheduler.onModuleInit();

      s.lightning.emit("ff".repeat(32));
      s.lightning.emit(succeeded.paymentHash);
      s.fiber.emit(refunded.paymentHash);
      await jest.advanceTimersByTimeAsync(0);

      expect(s.engine.processSwap).not.toHaveBeenCalled();
    });

    it("processes a failed swap that still owes a refund", async () => {
      const owing = seedSwap(s.store, "failed", { refunded: false });
      await s.scheduler.onModuleInit();
      s.lightning.emit(owing.paymentHash);
      await jest.advanceTimersByTimeAsync(0);
      expect(s.engine.processSwap).toHaveBeenCalledWith(owing.id);
    });

    it("never throws back into the node adapter, even when processing fails", async () => {
      const swap = seedSwap(s.store, "pending");
      s.engine.processSwap.mockRejectedValue(new Error("boom"));
      await s.scheduler.onModuleInit();

      expect(() => s.lightning.emit(swap.paymentHash)).not.toThrow();
      await jest.advanceTimersByTimeAsync(0);
      expect(s.engine.processSwap).toHaveBeenCalled();
    });
  });

  describe("shutdown", () => {
    it("stops polling and leaves no timer behind", async () => {
      await s.scheduler.onModuleInit();
      await s.scheduler.onModuleDestroy();
      expect(jest.getTimerCount()).toBe(0);
      await jest.advanceTimersByTimeAsync(POLL_MS * 5);
      expect(s.engine.processOpenSwaps).toHaveBeenCalledTimes(1);
    });

    it("unsubscribes from the nodes: updates after shutdown do nothing", async () => {
      const swap = seedSwap(s.store, "pending");
      await s.scheduler.onModuleInit();
      await s.scheduler.onModuleDestroy();

      s.lightning.emit(swap.paymentHash);
      s.fiber.emit(swap.paymentHash);
      await jest.advanceTimersByTimeAsync(0);
      expect(s.engine.processSwap).not.toHaveBeenCalled();
    });

    it("waits for running work before it resolves", async () => {
      const swap = seedSwap(s.store, "pending");
      const gate = deferred();
      s.engine.processSwap.mockImplementation(() => gate.promise);
      await s.scheduler.onModuleInit();
      s.lightning.emit(swap.paymentHash);
      await jest.advanceTimersByTimeAsync(0);
      expect(s.engine.processSwap).toHaveBeenCalledTimes(1);

      let stopped = false;
      const stopping = s.scheduler.onModuleDestroy().then(() => (stopped = true));
      await jest.advanceTimersByTimeAsync(0);
      expect(stopped).toBe(false);

      gate.resolve();
      await stopping;
      expect(stopped).toBe(true);
    });

    it("a pass running at shutdown does not schedule another one", async () => {
      await s.scheduler.onModuleInit();
      const gate = deferred();
      s.engine.processOpenSwaps.mockImplementationOnce(() => gate.promise);
      await jest.advanceTimersByTimeAsync(POLL_MS);
      expect(s.engine.processOpenSwaps).toHaveBeenCalledTimes(2);

      const stopping = s.scheduler.onModuleDestroy();
      gate.resolve();
      await stopping;
      await jest.advanceTimersByTimeAsync(POLL_MS * 3);
      expect(s.engine.processOpenSwaps).toHaveBeenCalledTimes(2);
      expect(jest.getTimerCount()).toBe(0);
    });
  });
});
