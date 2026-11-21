import { Logger } from "@nestjs/common";
import { HubMonitorService } from "../../../src/application/monitoring/hub-monitor.service";
import { OperatorEvents } from "../../../src/application/monitoring/operator-events";
import type { HubConfig } from "../../../src/config/hub.config";
import { FakeClock, FakeSwapStore } from "../../fakes";
import { makeSwap } from "../persistence/persistence.fixtures";
import {
  ALERT_REPEAT_MS,
  availability,
  DEGRADED_REASON,
  degradedReport,
  FAILED_PASSES_ALERT,
  healthReport,
  MIN_SATS,
  minutes,
  monitorConfig,
  MONITOR_INTERVAL_MS,
  RecordingAlertSink,
  StubHealthService,
  StubPricingService,
  SWAP_LIMITS,
} from "./monitoring.fixtures";

/**
 * HubMonitorService (docs/monitoring.md): each round reads health, open swaps, liquidity and the passes it heard of,
 * alerts a condition when it starts, reminds every repeatMs ("Still: "), sends a resolved alert when it clears, and
 * sends the payout guard's one-shot events once on the next round. It never throws into the hub. The clock is a
 * FakeClock; rounds are run by calling check() unless a spec is about the timer.
 */

const SWAP_PASS_ERROR = "database is locked";
const GUARD_SWAP_ID = "swap-guarded";
const GUARD_CHANNEL_ID = `0x${"a1".repeat(32)}`;
const MINUTE_MS = minutes(1);

interface MonitorHarness {
  clock: FakeClock;
  health: StubHealthService;
  pricing: StubPricingService;
  store: FakeSwapStore;
  sink: RecordingAlertSink;
  events: OperatorEvents;
  monitor: HubMonitorService;
}

function makeMonitor(config: HubConfig = monitorConfig()): MonitorHarness {
  const clock = new FakeClock();
  const health = new StubHealthService();
  const pricing = new StubPricingService();
  const store = new FakeSwapStore(clock);
  const sink = new RecordingAlertSink();
  const events = new OperatorEvents();
  const monitor = new HubMonitorService(health, pricing, store, clock, config, sink, events);
  return { clock, health, pricing, store, sink, events, monitor };
}

describe("HubMonitorService", () => {
  let m: MonitorHarness;
  let loggedErrors: jest.SpyInstance;

  beforeEach(() => {
    loggedErrors = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    m = makeMonitor();
    m.monitor.onModuleInit();
  });

  afterEach(() => {
    m.monitor.onModuleDestroy();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const degrade = () => m.health.check.mockResolvedValue(degradedReport());
  const recover = () => m.health.check.mockResolvedValue(healthReport());
  const failPasses = (count: number) => {
    for (let pass = 0; pass < count; pass += 1) m.events.emit({ kind: "swap-pass-failed", detail: SWAP_PASS_ERROR });
  };

  describe("a condition: alerted once, reminded, resolved", () => {
    it("is alerted once when it starts, and not again on the next rounds within the repeat interval", async () => {
      degrade();
      await m.monitor.check();
      expect(m.sink.takeSent()).toEqual([{ key: "health", level: "critical", title: "Hub degraded", detail: DEGRADED_REASON }]);

      m.clock.advance(ALERT_REPEAT_MS - 1);
      await m.monitor.check();
      await m.monitor.check();
      expect(m.sink.sent).toEqual([]);
    });

    it("is reminded with the \"Still: \" title prefix once the repeat interval has passed, then every interval after it", async () => {
      degrade();
      await m.monitor.check();
      m.sink.takeSent();

      m.clock.advance(ALERT_REPEAT_MS);
      await m.monitor.check();
      expect(m.sink.takeSent()).toEqual([{ key: "health", level: "critical", title: "Still: Hub degraded", detail: DEGRADED_REASON }]);

      m.clock.advance(ALERT_REPEAT_MS - 1);
      await m.monitor.check();
      expect(m.sink.takeSent()).toEqual([]);
      m.clock.advance(1);
      await m.monitor.check();
      expect(m.sink.takeSent().map((alert) => alert.title)).toEqual(["Still: Hub degraded"]);
    });

    it("is followed by a resolved alert when it clears: same key and title, detail \"cleared. It was: …\"", async () => {
      degrade();
      await m.monitor.check();
      m.sink.takeSent();

      recover();
      await m.monitor.check();
      expect(m.sink.takeSent()).toEqual([{ key: "health", level: "resolved", title: "Hub degraded", detail: `cleared. It was: ${DEGRADED_REASON}` }]);

      await m.monitor.check();
      expect(m.sink.sent).toEqual([]);
    });

    it("resolves under its plain title after a reminder, not the \"Still: \" one", async () => {
      degrade();
      await m.monitor.check();
      m.clock.advance(ALERT_REPEAT_MS);
      await m.monitor.check();
      m.sink.takeSent();

      recover();
      await m.monitor.check();
      expect(m.sink.takeSent()).toEqual([expect.objectContaining({ level: "resolved", title: "Hub degraded" })]);
    });

    it("is alerted again as new when it comes back after clearing", async () => {
      degrade();
      await m.monitor.check();
      recover();
      await m.monitor.check();
      m.sink.takeSent();

      degrade();
      await m.monitor.check();
      expect(m.sink.takeSent()).toEqual([expect.objectContaining({ level: "critical", title: "Hub degraded" })]);
    });

    it("sends nothing while the hub is healthy and quiet", async () => {
      await m.monitor.check();
      await m.monitor.check();
      expect(m.sink.sent).toEqual([]);
    });

    describe("a held condition that changes level or title (changedSince)", () => {
      const lowLightning = () => m.pricing.listAssets.mockResolvedValue([availability("CKB", { lightningSats: MIN_SATS })]);
      const noLightning = () => m.pricing.listAssets.mockResolvedValue([availability("CKB", { lightningSats: 0n })]);

      it("alerts at once when it gets worse (low Lightning liquidity becomes none), without the reminder prefix", async () => {
        lowLightning();
        await m.monitor.check();
        expect(m.sink.takeSent()).toEqual([expect.objectContaining({ key: "liquidity:lightning", level: "warning" })]);

        noLightning();
        await m.monitor.check();
        expect(m.sink.takeSent()).toEqual([
          expect.objectContaining({ key: "liquidity:lightning", level: "critical", title: "No Lightning payout liquidity" }),
        ]);
      });

      it("alerts at once when it gets better (no Lightning liquidity becomes low)", async () => {
        noLightning();
        await m.monitor.check();
        m.sink.takeSent();

        lowLightning();
        await m.monitor.check();
        expect(m.sink.takeSent()).toEqual([
          expect.objectContaining({ key: "liquidity:lightning", level: "warning", title: "Low Lightning payout liquidity" }),
        ]);
      });

      it("alerts at once when only its title changes (the health check failing, then answering degraded)", async () => {
        m.health.check.mockRejectedValue(new Error("connect ECONNREFUSED"));
        await m.monitor.check();
        expect(m.sink.takeSent()).toEqual([expect.objectContaining({ key: "health", level: "critical", title: "Health check failed" })]);

        degrade();
        await m.monitor.check();
        expect(m.sink.takeSent()).toEqual([{ key: "health", level: "critical", title: "Hub degraded", detail: DEGRADED_REASON }]);
      });

      it("waits for the reminder when only its detail changes (a late swap's minutes grow)", async () => {
        const swap = makeSwap(m.clock, { state: "outgoing_in_flight" });
        m.store.createSwap(swap);
        m.clock.advance(SWAP_LIMITS.payoutInFlightMs + 1);
        await m.monitor.check();
        const [first] = m.sink.takeSent();

        m.clock.advance(MINUTE_MS);
        await m.monitor.check();
        expect(m.sink.sent).toEqual([]);

        m.clock.advance(ALERT_REPEAT_MS);
        await m.monitor.check();
        const [reminder] = m.sink.takeSent();
        expect(reminder?.title).toBe(`Still: ${first?.title}`);
        expect(reminder?.detail).not.toBe(first?.detail);
      });

      it("counts the next reminder from the change", async () => {
        lowLightning();
        await m.monitor.check();
        m.clock.advance(ALERT_REPEAT_MS - 1);
        noLightning();
        await m.monitor.check();
        m.sink.takeSent();

        m.clock.advance(1);
        await m.monitor.check();
        expect(m.sink.takeSent()).toEqual([]);

        m.clock.advance(ALERT_REPEAT_MS - 1);
        await m.monitor.check();
        expect(m.sink.takeSent().map((alert) => alert.title)).toEqual(["Still: No Lightning payout liquidity"]);
      });

      it("resolves under the title it had last", async () => {
        lowLightning();
        await m.monitor.check();
        noLightning();
        await m.monitor.check();
        m.sink.takeSent();

        m.pricing.listAssets.mockResolvedValue([availability("CKB")]);
        await m.monitor.check();
        expect(m.sink.takeSent()).toEqual([expect.objectContaining({ key: "liquidity:lightning", level: "resolved", title: "No Lightning payout liquidity" })]);
      });
    });
  });

  describe("what each round reads", () => {
    it("alerts a swap that stays too long in a step, from the store's open swaps and the clock, and resolves it once it moves on", async () => {
      const swap = makeSwap(m.clock, { state: "outgoing_succeeded" });
      m.store.createSwap(swap);

      m.clock.advance(SWAP_LIMITS.settleMs);
      await m.monitor.check();
      expect(m.sink.takeSent()).toEqual([]);

      m.clock.advance(1);
      await m.monitor.check();
      expect(m.sink.takeSent()).toEqual([
        expect.objectContaining({ key: `swap:${swap.id}:settle`, level: "critical", title: "Payout sent, incoming payment not collected" }),
      ]);

      m.store.transition(swap.id, "outgoing_succeeded", { state: "succeeded" });
      await m.monitor.check();
      expect(m.sink.takeSent()).toEqual([expect.objectContaining({ key: `swap:${swap.id}:settle`, level: "resolved" })]);
    });

    it("alerts low payout liquidity from the pricing service's asset list", async () => {
      m.pricing.listAssets.mockResolvedValue([availability("CKB"), availability("RUSD", { fiberAmount: 0n })]);
      await m.monitor.check();
      expect(m.sink.takeSent()).toEqual([expect.objectContaining({ key: "liquidity:fiber:RUSD", level: "critical", title: "No RUSD payout liquidity" })]);
    });
  });

  describe("the payout guard's one-shot events", () => {
    it("sends payout-guard-closed once, on the next round, as a warning naming the swap and the channel", async () => {
      m.events.emit({ kind: "payout-guard-closed", swapId: GUARD_SWAP_ID, channelId: GUARD_CHANNEL_ID });
      expect(m.sink.sent).toEqual([]);

      await m.monitor.check();
      const [alert, ...rest] = m.sink.takeSent();
      expect(rest).toEqual([]);
      expect(alert).toMatchObject({ key: `guard:${GUARD_SWAP_ID}:${GUARD_CHANNEL_ID}`, level: "warning", title: "Payout guard force-closed a channel" });
      expect(alert?.detail).toContain(GUARD_SWAP_ID);
      expect(alert?.detail).toContain(GUARD_CHANNEL_ID);

      await m.monitor.check();
      expect(m.sink.sent).toEqual([]);
    });

    it("sends payout-guard-failed once, on the next round, with the failure and the retry", async () => {
      const FAILURE = "offeredTlcs: simulated transport error";
      m.events.emit({ kind: "payout-guard-failed", swapId: GUARD_SWAP_ID, detail: FAILURE });

      await m.monitor.check();
      expect(m.sink.takeSent()).toEqual([
        {
          key: `guard-failed:${GUARD_SWAP_ID}`,
          level: "warning",
          title: "Payout guard could not check a payout",
          detail: `Swap ${GUARD_SWAP_ID}: ${FAILURE}. It retries on the next pass.`,
        },
      ]);

      await m.monitor.check();
      expect(m.sink.sent).toEqual([]);
    });

    it("sends every event heard between two rounds, in order, and never a resolved alert for them", async () => {
      m.events.emit({ kind: "payout-guard-closed", swapId: GUARD_SWAP_ID, channelId: GUARD_CHANNEL_ID });
      m.events.emit({ kind: "payout-guard-failed", swapId: GUARD_SWAP_ID, detail: "offline" });

      await m.monitor.check();
      expect(m.sink.takeSent().map((alert) => alert.key)).toEqual([`guard:${GUARD_SWAP_ID}:${GUARD_CHANNEL_ID}`, `guard-failed:${GUARD_SWAP_ID}`]);
      await m.monitor.check();
      expect(m.sink.sent).toEqual([]);
    });
  });

  describe("swap passes (swap-pass-failed, swap-pass-ok)", () => {
    it("alerts nothing below MONITOR_FAILED_PASSES failures in a row", async () => {
      failPasses(FAILED_PASSES_ALERT - 1);
      await m.monitor.check();
      expect(m.sink.sent).toEqual([]);
    });

    it("counts failures across rounds and alerts at the threshold, with the last error", async () => {
      failPasses(FAILED_PASSES_ALERT - 1);
      await m.monitor.check();
      failPasses(1);
      await m.monitor.check();
      expect(m.sink.takeSent()).toEqual([
        {
          key: "swap-pass",
          level: "critical",
          title: "Swap processing failing",
          detail: `The last ${FAILED_PASSES_ALERT} passes over open swaps failed: ${SWAP_PASS_ERROR}.`,
        },
      ]);
    });

    it("resolves the alert after a pass succeeds", async () => {
      failPasses(FAILED_PASSES_ALERT);
      await m.monitor.check();
      m.sink.takeSent();

      m.events.emit({ kind: "swap-pass-ok" });
      await m.monitor.check();
      expect(m.sink.takeSent()).toEqual([expect.objectContaining({ key: "swap-pass", level: "resolved", title: "Swap processing failing" })]);
    });

    it("starts the count over after a successful pass", async () => {
      failPasses(FAILED_PASSES_ALERT - 1);
      m.events.emit({ kind: "swap-pass-ok" });
      failPasses(1);
      await m.monitor.check();
      expect(m.sink.sent).toEqual([]);
    });
  });

  describe("never throws into the hub", () => {
    it("turns a health check that throws into a critical \"Health check failed\" with the error", async () => {
      m.health.check.mockRejectedValue(new Error("connect ECONNREFUSED"));

      await expect(m.monitor.check()).resolves.toBeUndefined();
      expect(m.sink.takeSent()).toEqual([{ key: "health", level: "critical", title: "Health check failed", detail: "connect ECONNREFUSED" }]);
    });

    it("raises no liquidity condition when the pricing service cannot list the assets", async () => {
      m.pricing.listAssets.mockRejectedValue(new Error("lnd unreachable"));

      await expect(m.monitor.check()).resolves.toBeUndefined();
      expect(m.sink.sent).toEqual([]);
    });

    it("resolves an open liquidity alert when the assets cannot be read: the health condition speaks for unreadable nodes", async () => {
      m.pricing.listAssets.mockResolvedValue([availability("RUSD", { fiberAmount: 0n })]);
      await m.monitor.check();
      m.sink.takeSent();

      m.pricing.listAssets.mockRejectedValue(new Error("lnd unreachable"));
      await m.monitor.check();
      expect(m.sink.takeSent()).toEqual([expect.objectContaining({ key: "liquidity:fiber:RUSD", level: "resolved" })]);
    });

    it("logs a round that fails anywhere else (the store), resolves, and runs the next round", async () => {
      const listOpenSwaps = jest.spyOn(m.store, "listOpenSwaps").mockImplementationOnce(() => {
        throw new Error("database is locked");
      });

      await expect(m.monitor.check()).resolves.toBeUndefined();
      expect(loggedErrors).toHaveBeenCalledWith(expect.stringContaining("Monitor round failed: database is locked"));

      degrade();
      await m.monitor.check();
      expect(listOpenSwaps).toHaveBeenCalledTimes(2);
      expect(m.sink.takeSent()).toEqual([expect.objectContaining({ key: "health" })]);
    });
  });

  describe("the running guard", () => {
    it("skips a round that starts while another is still running, and runs the next one once it is done", async () => {
      let finishHealth: () => void = () => undefined;
      m.health.check.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishHealth = () => resolve(degradedReport());
          }),
      );

      const first = m.monitor.check();
      await m.monitor.check();
      expect(m.health.check).toHaveBeenCalledTimes(1);

      finishHealth();
      await first;
      expect(m.sink.takeSent()).toHaveLength(1);

      await m.monitor.check();
      expect(m.health.check).toHaveBeenCalledTimes(2);
    });
  });
});

describe("HubMonitorService: timer and subscription", () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "queueMicrotask", "setImmediate"] });
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("runs a round every MONITOR_INTERVAL_SECONDS once started", async () => {
    const m = makeMonitor();
    m.monitor.onModuleInit();
    expect(jest.getTimerCount()).toBe(1);

    await jest.advanceTimersByTimeAsync(MONITOR_INTERVAL_MS - 1);
    expect(m.health.check).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(m.health.check).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(MONITOR_INTERVAL_MS);
    expect(m.health.check).toHaveBeenCalledTimes(2);

    m.monitor.onModuleDestroy();
  });

  it("hears the swap machinery's events once started", async () => {
    const m = makeMonitor();
    m.monitor.onModuleInit();
    m.events.emit({ kind: "payout-guard-closed", swapId: GUARD_SWAP_ID, channelId: GUARD_CHANNEL_ID });

    await m.monitor.check();
    expect(m.sink.sent).toHaveLength(1);
    m.monitor.onModuleDestroy();
  });

  it("with MONITOR_ENABLED=false, starts no timer and subscribes to nothing", async () => {
    const m = makeMonitor(monitorConfig({ enabled: false }));
    const subscribe = jest.spyOn(m.events, "on");

    m.monitor.onModuleInit();

    expect(jest.getTimerCount()).toBe(0);
    expect(subscribe).not.toHaveBeenCalled();
    m.events.emit({ kind: "payout-guard-closed", swapId: GUARD_SWAP_ID, channelId: GUARD_CHANNEL_ID });
    await jest.advanceTimersByTimeAsync(MONITOR_INTERVAL_MS * 3);
    expect(m.health.check).not.toHaveBeenCalled();
    m.monitor.onModuleDestroy();
  });

  it("stops the timer and unsubscribes on module destroy", async () => {
    const m = makeMonitor();
    m.monitor.onModuleInit();
    m.monitor.onModuleDestroy();

    expect(jest.getTimerCount()).toBe(0);
    m.events.emit({ kind: "payout-guard-closed", swapId: GUARD_SWAP_ID, channelId: GUARD_CHANNEL_ID });
    await m.monitor.check();
    expect(m.sink.sent).toEqual([]);
  });
});
