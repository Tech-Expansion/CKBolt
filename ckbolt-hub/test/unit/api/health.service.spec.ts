import "reflect-metadata";
import type { HealthReport } from "../../../src/application/health/health.contract";
import { HealthServiceImpl } from "../../../src/application/health/health.service";
import type { LnNodeInfo } from "../../../src/application/ports/lightning.port";
import type { HubConfig } from "../../../src/config/hub.config";
import { FakeClock, FakeFiberNetwork, FakeLightningNetwork, type FakeFiberNode, type FakeLightningNode } from "../../fakes";
import { spyOnLogger, testConfig } from "./api.fixtures";

/**
 * HealthServiceImpl: asks the hub's own LND and fnn for getInfo, each within config.health.timeoutMs. `ok` only when
 * both answer and Lightning is synced; otherwise `degraded` (GET /v1/health then answers 503).
 */

const VERSION = "1.2.3-test";
/** HEALTH_CHECK_TIMEOUT_MS in these specs: not the default, so the service must read it from the config. */
const TIMEOUT_MS = 1_234;
const UNREACHABLE_LIGHTNING = { reachable: false, network: null, synced: false, blockHeight: null };
const UNREACHABLE_FIBER = { reachable: false, network: null, version: null };

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
const after = <T>(ms: number, value: T): Promise<T> => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

describe("HealthServiceImpl", () => {
  let ln: FakeLightningNetwork;
  let fiber: FakeFiberNetwork;
  let hubLn: FakeLightningNode;
  let hubFiber: FakeFiberNode;
  let config: HubConfig;
  let logs: ReturnType<typeof spyOnLogger>;

  const service = (): HealthServiceImpl => new HealthServiceImpl(hubLn, hubFiber, config, VERSION);

  beforeEach(() => {
    logs = spyOnLogger();
    const clock = new FakeClock();
    ln = new FakeLightningNetwork("signet", clock, 2_500);
    fiber = new FakeFiberNetwork("testnet", clock);
    hubLn = ln.node("hub");
    hubFiber = fiber.node("hub");
    // The hub is configured for the networks its nodes run on: a node on another network makes it degraded.
    const base = testConfig({ health: { timeoutMs: TIMEOUT_MS } });
    config = { ...base, bitcoin: { network: "signet" }, ckb: { ...base.ckb, network: "testnet" } };
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("is ok with both nodes' details when both answer and Lightning is synced", async () => {
    const report = await service().check();
    expect(report).toEqual<HealthReport>({
      status: "ok",
      version: VERSION,
      lightning: { reachable: true, network: "signet", synced: true, blockHeight: 2_500 },
      fiber: { reachable: true, network: "testnet", version: "fake-fnn" },
      demo: { enabled: false },
      swaps: { paused: false },
    });
    expect(hubLn.calls).toEqual(["getInfo"]);
    expect(hubFiber.calls).toEqual(["getInfo"]);
  });

  it("reports demo.enabled from the config", async () => {
    config = { ...config, demo: { ...config.demo, enabled: true } };
    expect((await service().check()).demo).toEqual({ enabled: true });
  });

  it("reports swaps.paused from the config (SWAPS_PAUSED), and a paused hub is still ok", async () => {
    config = { ...config, swaps: { ...config.swaps, paused: true } };
    const report = await service().check();
    expect(report.swaps).toEqual({ paused: true });
    expect(report.status).toBe("ok");
  });

  it("is degraded when Lightning does not answer, and still reports Fiber", async () => {
    hubLn.failNext = "getInfo";
    const report = await service().check();
    expect(report.status).toBe("degraded");
    expect(report.lightning).toEqual(UNREACHABLE_LIGHTNING);
    expect(report.fiber.reachable).toBe(true);
    expect(logs.warn.mock.calls.flat().join(" ")).toContain("simulated transport error");
  });

  it("is degraded when Fiber does not answer, and still reports Lightning", async () => {
    hubFiber.failNext = "getInfo";
    const report = await service().check();
    expect(report.status).toBe("degraded");
    expect(report.fiber).toEqual(UNREACHABLE_FIBER);
    expect(report.lightning.reachable).toBe(true);
  });

  it("is degraded when neither node answers", async () => {
    hubLn.failNext = "getInfo";
    hubFiber.failNext = "getInfo";
    const report = await service().check();
    expect(report).toMatchObject({ status: "degraded", lightning: UNREACHABLE_LIGHTNING, fiber: UNREACHABLE_FIBER, version: VERSION });
  });

  it("is degraded when Lightning answers but is not synced to the chain", async () => {
    const info: LnNodeInfo = { pubkey: hubLn.pubkey, network: "signet", blockHeight: 2_400, synced: false, version: "fake-lnd", uris: [] };
    jest.spyOn(hubLn, "getInfo").mockResolvedValue(info);
    const report = await service().check();
    expect(report.status).toBe("degraded");
    expect(report.lightning).toEqual({ reachable: true, network: "signet", synced: false, blockHeight: 2_400 });
  });

  it("each check is independent: a fresh call recovers once the node answers again", async () => {
    hubLn.failNext = "getInfo";
    const svc = service();
    expect((await svc.check()).status).toBe("degraded");
    expect((await svc.check()).status).toBe("ok");
  });

  describe("timeouts", () => {
    beforeEach(() => jest.useFakeTimers());

    it("reports a node that never answers as unreachable after config.health.timeoutMs, not before", async () => {
      jest.spyOn(hubLn, "getInfo").mockReturnValue(never());
      let report: HealthReport | undefined;
      const pending = service()
        .check()
        .then((r) => (report = r));

      await jest.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
      expect(report).toBeUndefined();
      await jest.advanceTimersByTimeAsync(1);
      await pending;
      expect(report?.status).toBe("degraded");
      expect(report?.lightning).toEqual(UNREACHABLE_LIGHTNING);
      expect(report?.fiber.reachable).toBe(true);
    });

    it("checks both nodes in parallel: two hung nodes cost one timeout, not two", async () => {
      jest.spyOn(hubLn, "getInfo").mockReturnValue(never());
      jest.spyOn(hubFiber, "getInfo").mockReturnValue(never());
      let report: HealthReport | undefined;
      const pending = service()
        .check()
        .then((r) => (report = r));
      await jest.advanceTimersByTimeAsync(TIMEOUT_MS);
      await pending;
      expect(report).toMatchObject({ status: "degraded", lightning: UNREACHABLE_LIGHTNING, fiber: UNREACHABLE_FIBER });
    });

    it("a slow answer within the timeout counts as reachable", async () => {
      const info = await hubFiber.getInfo();
      jest.spyOn(hubFiber, "getInfo").mockReturnValue(after(TIMEOUT_MS - 1, info));
      const pending = service().check();
      await jest.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
      const report = await pending;
      expect(report.status).toBe("ok");
      expect(report.fiber).toEqual({ reachable: true, network: "testnet", version: "fake-fnn" });
    });

    it("leaves no timer behind once the nodes have answered", async () => {
      await service().check();
      expect(jest.getTimerCount()).toBe(0);
    });
  });
});
