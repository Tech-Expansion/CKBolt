import type { HealthReport } from "../../../src/application/health/health.contract";
import { HealthServiceImpl } from "../../../src/application/health/health.service";
import type { HubConfig } from "../../../src/config/hub.config";
import type { BtcNetwork, CkbNetwork } from "../../../src/domain/types";
import { FakeClock, FakeFiberNetwork, FakeLightningNetwork, type FakeFiberNode, type FakeLightningNode } from "../../fakes";
import { spyOnLogger } from "../api/api.fixtures";
import { FIBER_PATH, inboundConfig, startFiberAccessHub, type FiberAccessHub } from "./fiber-access.fixtures";

/**
 * GET /v1/health reads each node's REAL network (LND's chains, fnn's chain_hash) and reports `degraded` (503) with a
 * plain reason when it differs from the configured BTC_NETWORK / CKB_NETWORK. A hub must never quote or swap on a
 * network other than the one it is set up for (a testnet hub talking to a mainnet node would move real money).
 */

const VERSION = "0.0.0-test";

describe("HealthServiceImpl: each node's own network", () => {
  let hubLn: FakeLightningNode;
  let hubFiber: FakeFiberNode;
  let config: HubConfig;

  /** A hub configured for regtest + devnet whose nodes really run on `ln` and `ckb`. */
  function service(ln: BtcNetwork, ckb: CkbNetwork, env: Record<string, string> = {}): HealthServiceImpl {
    const clock = new FakeClock();
    config = inboundConfig(env);
    hubLn = new FakeLightningNetwork(ln, clock).node("hub");
    hubFiber = new FakeFiberNetwork(ckb, clock).node("hub");
    return new HealthServiceImpl(hubLn, hubFiber, config, VERSION);
  }

  beforeEach(() => spyOnLogger());
  afterEach(() => jest.restoreAllMocks());

  it("is ok, with no reason at all, when both nodes run on the configured networks", async () => {
    const report = await service("regtest", "devnet").check();
    expect(report).toEqual<HealthReport>({
      status: "ok",
      version: VERSION,
      lightning: { reachable: true, network: "regtest", synced: true, blockHeight: expect.any(Number) as unknown as number },
      fiber: { reachable: true, network: "devnet", version: "fake-fnn" },
      demo: { enabled: false },
      swaps: { paused: false },
    });
    expect(Object.keys(report)).not.toContain("reason");
  });

  it("is ok on the public demo's networks when the nodes run there: signet (Mutinynet) and CKB testnet", async () => {
    const report = await service("signet", "testnet", { BTC_NETWORK: "signet", TIMING_PROFILE: "mutinynet", CKB_NETWORK: "testnet" }).check();
    expect(report.status).toBe("ok");
  });

  it("is degraded when the Fiber node runs on another CKB network, and says which", async () => {
    const report = await service("regtest", "testnet").check();
    expect(report.status).toBe("degraded");
    expect(report.fiber).toEqual({ reachable: true, network: "testnet", version: "fake-fnn" });
    expect(report.reason).toBe("The hub's Fiber node runs on CKB testnet, but the hub is set up for CKB devnet.");
  });

  it("is degraded when a testnet hub's Fiber node is on mainnet (real money)", async () => {
    const report = await service("signet", "mainnet", { BTC_NETWORK: "signet", TIMING_PROFILE: "mutinynet", CKB_NETWORK: "testnet" }).check();
    expect(report.status).toBe("degraded");
    expect(report.reason).toBe("The hub's Fiber node runs on CKB mainnet, but the hub is set up for CKB testnet.");
  });

  it("is degraded when the Lightning node runs on another Bitcoin network, and says which", async () => {
    const report = await service("mainnet", "devnet").check();
    expect(report.status).toBe("degraded");
    expect(report.lightning.network).toBe("mainnet");
    expect(report.reason).toBe("The hub's Lightning node runs on mainnet, but the hub is set up for regtest.");
  });

  it("is degraded when the Lightning node names a chain the hub does not know", async () => {
    const svc = service("regtest", "devnet");
    hubLn.reportedNetwork = null;
    const report = await svc.check();
    expect(report.status).toBe("degraded");
    expect(report.lightning).toMatchObject({ reachable: true, network: null });
    expect(report.reason).toBe("The hub's Lightning node runs on a chain the hub does not know, but the hub is set up for regtest.");
  });

  it("gives one plain sentence per problem, Lightning first, joined by a space", async () => {
    const svc = service("signet", "testnet");
    hubLn.synced = false;
    const report = await svc.check();
    expect(report.reason).toBe(
      "The hub's Lightning node runs on signet, but the hub is set up for regtest. " +
        "The hub's Lightning node is not synced to the chain yet. " +
        "The hub's Fiber node runs on CKB testnet, but the hub is set up for CKB devnet.",
    );
  });

  it("says a node does not answer instead of naming a network for it", async () => {
    const svc = service("regtest", "devnet");
    hubFiber.failNext = "getInfo";
    const report = await svc.check();
    expect(report.fiber).toEqual({ reachable: false, network: null, version: null });
    expect(report.reason).toBe("The hub's Fiber node does not answer.");
  });

  it("reports an unreachable Lightning node only as unreachable (no network or sync sentence)", async () => {
    const svc = service("mainnet", "devnet");
    hubLn.failNext = "getInfo";
    const report = await svc.check();
    expect(report.reason).toBe("The hub's Lightning node does not answer.");
  });

  it("keeps every reason a plain sentence with no stack or secret in it", async () => {
    const svc = service("mainnet", "testnet", { FIBER_RPC_TOKEN: "EoQKCAoGCAESAhgBEgYIARICGAEaIK-secret-biscuit" });
    hubLn.synced = false;
    const report = await svc.check();
    for (const sentence of (report.reason ?? "").split(/(?<=\.) /)) expect(sentence).toMatch(/^The hub's (Lightning|Fiber) node [^\n]*\.$/);
    expect(report.reason).not.toMatch(/secret|biscuit|127\.0\.0\.1|8227/);
  });
});

describe("GET /v1/health over HTTP (real AppModule, fake nodes)", () => {
  let hub: FiberAccessHub | null = null;

  beforeEach(() => spyOnLogger());
  afterEach(async () => {
    await hub?.app.close();
    hub = null;
    jest.restoreAllMocks();
  });

  it("answers 200 ok without a reason when both nodes are on the configured networks", async () => {
    hub = await startFiberAccessHub();
    const res = await hub.http().get(FIBER_PATH.HEALTH).expect(200);
    expect(res.body).toMatchObject({ status: "ok", lightning: { network: "regtest" }, fiber: { network: "devnet" } });
    expect(Object.keys(res.body)).not.toContain("reason");
  });

  it("answers 503 degraded with the reason when the Fiber node is on another network", async () => {
    hub = await startFiberAccessHub({ fiberNetwork: "testnet" });
    const res = await hub.http().get(FIBER_PATH.HEALTH).expect(503);
    expect(res.body).toMatchObject({
      status: "degraded",
      reason: "The hub's Fiber node runs on CKB testnet, but the hub is set up for CKB devnet.",
      fiber: { reachable: true, network: "testnet" },
    });
  });

  it("answers 503 degraded with the reason when the Lightning node is on another network", async () => {
    hub = await startFiberAccessHub({ lightningNetwork: "testnet" });
    const res = await hub.http().get(FIBER_PATH.HEALTH).expect(503);
    expect(res.body).toMatchObject({ status: "degraded", lightning: { network: "testnet" } });
    expect(res.body.reason).toBe("The hub's Lightning node runs on testnet, but the hub is set up for regtest.");
  });
});
