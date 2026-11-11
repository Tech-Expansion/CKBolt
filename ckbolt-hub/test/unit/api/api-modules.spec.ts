import "reflect-metadata";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DynamicModule, INestApplication, ModuleMetadata } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import request from "supertest";
import { DEMO_WALLET, type DemoWallet } from "../../../src/application/demo/demo-wallet.contract";
import { DemoWalletService } from "../../../src/application/demo/demo-wallet.service";
import { DemoModule } from "../../../src/application/demo/demo.module";
import { HEALTH_SERVICE, type HealthService } from "../../../src/application/health/health.contract";
import { HealthModule } from "../../../src/application/health/health.module";
import { CLOCK, HUB_CONFIG } from "../../../src/application/ports/tokens";
import { PRICING_SERVICE } from "../../../src/application/pricing/pricing.contract";
import { SWAP_ENGINE } from "../../../src/application/swaps/swap-engine.contract";
import { API_ERROR_CODE } from "../../../src/common/constants/api.constants";
import { MSAT_PER_SAT } from "../../../src/common/constants/protocol.constants";
import { sha256Hex } from "../../../src/common/utils/hex.util";
import { HubConfigModule } from "../../../src/config/config.module";
import type { HubConfig } from "../../../src/config/hub.config";
import { FakeClock, FakeFiberNetwork, FakeLightningNetwork, type FakeFiberNode, type FakeLightningNode } from "../../fakes";
import {
  createApiApp,
  exportingModule,
  fakeNodesModule,
  makeSwap,
  spyOnLogger,
  StubPricingService,
  StubSwapEngine,
  SWAP_ID,
  testConfig,
  UNKNOWN_ID,
  type FakeNodes,
} from "./api.fixtures";

/**
 * Nest wiring of the api module's application services: DemoModule (DEMO_WALLET) and HealthModule (HEALTH_SERVICE),
 * resolved from the global node tokens like in production, then the REST API on top of them with fake nodes.
 */

const HUB_VERSION = (JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "package.json"), "utf8")) as { version: string }).version;

interface Network {
  clock: FakeClock;
  ln: FakeLightningNetwork;
  fiber: FakeFiberNetwork;
  hubLn: FakeLightningNode;
  hubFiber: FakeFiberNode;
  demoLn: FakeLightningNode;
  demoFiber: FakeFiberNode;
}

const fakeNetwork = (): Network => {
  const clock = new FakeClock();
  const ln = new FakeLightningNetwork("regtest", clock);
  const fiber = new FakeFiberNetwork("devnet", clock);
  return { clock, ln, fiber, hubLn: ln.node("hub"), hubFiber: fiber.node("hub"), demoLn: ln.node("demo"), demoFiber: fiber.node("demo") };
};

const nodesOf = (net: Network, demo: boolean): FakeNodes => ({
  lightning: net.hubLn,
  fiber: net.hubFiber,
  demoLightning: demo ? net.demoLn : null,
  demoFiber: demo ? net.demoFiber : null,
});

describe("api module wiring", () => {
  let net: Network;
  let config: HubConfig;
  let engine: StubSwapEngine;
  let engineModule: DynamicModule;
  let moduleRef: TestingModule | undefined;

  const compile = async (imports: NonNullable<ModuleMetadata["imports"]>, demoNodes = true): Promise<TestingModule> => {
    moduleRef = await Test.createTestingModule({ imports: [HubConfigModule, fakeNodesModule(nodesOf(net, demoNodes)), ...imports] })
      .overrideProvider(HUB_CONFIG)
      .useValue(config)
      .overrideProvider(CLOCK)
      .useValue(net.clock)
      .compile();
    return moduleRef;
  };

  beforeEach(() => {
    spyOnLogger();
    net = fakeNetwork();
    config = testConfig();
    engine = new StubSwapEngine();
    engineModule = exportingModule([{ provide: SWAP_ENGINE, useValue: engine }]);
    moduleRef = undefined;
  });

  afterEach(async () => {
    await moduleRef?.close();
    jest.restoreAllMocks();
  });

  describe("DemoModule", () => {
    it("provides DEMO_WALLET as a DemoWalletService, enabled when both demo nodes are bound", async () => {
      const ref = await compile([DemoModule.register({ imports: [engineModule] })]);
      const wallet = ref.get<DemoWallet>(DEMO_WALLET);
      expect(wallet).toBeInstanceOf(DemoWalletService);
      expect(wallet.enabled).toBe(true);
    });

    it("is disabled when the infrastructure binds the demo nodes to null", async () => {
      const ref = await compile([DemoModule.register({ imports: [engineModule] })], false);
      expect(ref.get<DemoWallet>(DEMO_WALLET).enabled).toBe(false);
    });

    it("is disabled, not broken, when no module binds the demo node tokens at all", async () => {
      moduleRef = await Test.createTestingModule({ imports: [HubConfigModule, DemoModule.register({ imports: [engineModule] })] })
        .overrideProvider(HUB_CONFIG)
        .useValue(config)
        .compile();
      expect(moduleRef.get<DemoWallet>(DEMO_WALLET).enabled).toBe(false);
    });

    it("uses the SWAP_ENGINE of the module it is given", async () => {
      const preimage = "05".repeat(32);
      const paymentHash = sha256Hex(preimage);
      const payout = await net.demoFiber.createInvoice({ preimage, amount: 1_000n, udtTypeScript: null, expirySeconds: 600, description: "payout" });
      const { paymentRequest } = await net.hubLn.createHoldInvoice({ paymentHash, amountSats: 1_000n, expirySeconds: 60, cltvExpiry: 100, memo: "hold" });
      engine.add(makeSwap({ paymentHash, holdInvoice: paymentRequest, payoutInvoice: payout.invoice }));
      const ref = await compile([DemoModule.register({ imports: [engineModule] })]);
      await ref.get<DemoWallet>(DEMO_WALLET).payHoldInvoice(SWAP_ID);
      expect(engine.getSwap).toHaveBeenCalledWith(SWAP_ID);
      expect((await net.hubLn.lookupInvoice(paymentHash))?.state).toBe("ACCEPTED");
    });
  });

  describe("HealthModule", () => {
    it("provides HEALTH_SERVICE over the hub's own nodes (LIGHTNING, FIBER), with the version from package.json", async () => {
      const ref = await compile([HealthModule]);
      const report = await ref.get<HealthService>(HEALTH_SERVICE).check();
      expect(report.status).toBe("ok");
      expect(report.version).toBe(HUB_VERSION);
      expect(net.hubLn.calls).toEqual(["getInfo"]);
      expect(net.hubFiber.calls).toEqual(["getInfo"]);
      expect(net.demoLn.calls).toEqual([]);
      expect(net.demoFiber.calls).toEqual([]);
    });
  });
});

describe("REST API v1 over the real demo and health modules (fake nodes)", () => {
  let net: Network;
  let app: INestApplication;
  let engine: StubSwapEngine;
  let config: HubConfig;

  const start = async (demo: boolean): Promise<void> => {
    engine = new StubSwapEngine();
    const engineModule = exportingModule([{ provide: SWAP_ENGINE, useValue: engine }]);
    const pricingModule = exportingModule([{ provide: PRICING_SERVICE, useValue: new StubPricingService() }]);
    app = await createApiApp({
      config,
      clock: net.clock,
      rootImports: [fakeNodesModule(nodesOf(net, demo))],
      apiImports: [engineModule, pricingModule, HealthModule, DemoModule.register({ imports: [engineModule] })],
    });
  };
  const http = () => request(app.getHttpServer());

  /** A pending ln_to_fiber swap paying out to a Fiber invoice of `payee`: the demo wallet's own unless a test says not. */
  const pendingLnToFiberSwap = async (overrides: Parameters<typeof makeSwap>[0] = {}, payee: FakeFiberNode = net.demoFiber) => {
    const preimage = "07".repeat(32);
    const paymentHash = sha256Hex(preimage);
    const payout = await payee.createInvoice({ preimage, amount: 2_000_000_000_000n, udtTypeScript: null, expirySeconds: 600, description: "payout" });
    const { paymentRequest } = await net.hubLn.createHoldInvoice({ paymentHash, amountSats: 50_000n, expirySeconds: 180, cltvExpiry: 150, memo: "hold" });
    return engine.add(makeSwap({ paymentHash, holdInvoice: paymentRequest, payoutInvoice: payout.invoice, ...overrides }));
  };

  beforeEach(() => {
    spyOnLogger();
    net = fakeNetwork();
    config = testConfig({ server: { rateLimitPerMinute: 1_000 }, demo: { maxActionsPerHour: 1_000 } });
  });

  afterEach(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  it("GET /v1/health: 200 ok with the nodes' details and the hub version", async () => {
    await start(true);
    const res = await http().get("/v1/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "ok",
      version: HUB_VERSION,
      lightning: { reachable: true, network: "regtest", synced: true, blockHeight: 100 },
      fiber: { reachable: true, network: "devnet", version: "fake-fnn" },
      demo: { enabled: config.demo.enabled },
      swaps: { paused: false },
    });
  });

  it("GET /v1/health: 503 degraded when the hub's LND is unreachable", async () => {
    await start(true);
    net.hubLn.failNext = "getInfo";
    const res = await http().get("/v1/health");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("degraded");
    expect(res.body.lightning.reachable).toBe(false);
  });

  it("POST /v1/demo/invoices (ln_to_fiber): 201 with a sha256 Fiber invoice the hub can parse", async () => {
    await start(true);
    const res = await http().post("/v1/demo/invoices").send({ direction: "ln_to_fiber", asset: "RUSD", amount: "300000000" });
    expect(res.status).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual(["invoice", "paymentHash"]);
    const parsed = await net.hubFiber.parseInvoice(res.body.invoice);
    expect(parsed).toMatchObject({ paymentHash: res.body.paymentHash, amount: 300_000_000n, hashAlgorithm: "sha256" });
    expect(parsed.udtTypeScript).not.toBeNull();
  });

  it("POST /v1/demo/invoices (fiber_to_ln): 201 with a BOLT11 invoice for the sats", async () => {
    await start(true);
    const res = await http().post("/v1/demo/invoices").send({ direction: "fiber_to_ln", asset: "CKB", amount: "25000" });
    expect(res.status).toBe(201);
    const decoded = await net.hubLn.decodeInvoice(res.body.invoice);
    expect(decoded.amountMsat).toBe(25_000n * MSAT_PER_SAT);
    expect(decoded.paymentHash).toBe(res.body.paymentHash);
  });

  it("POST /v1/demo/invoices for an asset the hub does not serve: 422", async () => {
    await start(true);
    const res = await http().post("/v1/demo/invoices").send({ direction: "ln_to_fiber", asset: "CWBTC", amount: "1000" });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: { code: expect.any(String), message: expect.stringContaining("CWBTC") } });
  });

  it("POST /v1/demo/payments: 202 and the hub's hold invoice is now held", async () => {
    await start(true);
    const swap = await pendingLnToFiberSwap();
    const res = await http().post("/v1/demo/payments").send({ swapId: swap.id });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ swapId: swap.id, status: "submitted" });
    expect((await net.hubLn.lookupInvoice(swap.paymentHash))?.state).toBe("ACCEPTED");
  });

  it("POST /v1/demo/payments for a swap that pays out to someone else's wallet: 409 conflict, and the demo pays nothing", async () => {
    await start(true);
    const swap = await pendingLnToFiberSwap({}, net.fiber.node("visitor"));
    const res = await http().post("/v1/demo/payments").send({ swapId: swap.id });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe(API_ERROR_CODE.CONFLICT);
    expect(res.body.error.message).toMatch(/demo wallet/i);
    expect(net.demoLn.calls).not.toContain("payInvoice");
    expect((await net.hubLn.lookupInvoice(swap.paymentHash))?.state).toBe("OPEN");
  });

  it("POST /v1/demo/payments for an unknown swap: 404 not_found", async () => {
    await start(true);
    const res = await http().post("/v1/demo/payments").send({ swapId: UNKNOWN_ID });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe(API_ERROR_CODE.NOT_FOUND);
  });

  it("POST /v1/demo/payments for a swap that is no longer pending: 409", async () => {
    await start(true);
    const swap = await pendingLnToFiberSwap({ state: "incoming_accepted" });
    const res = await http().post("/v1/demo/payments").send({ swapId: swap.id });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/no longer waiting/i);
    expect(net.demoLn.calls).toEqual([]);
  });

  it("POST /v1/demo/payments when the demo node is down: 503 upstream_unavailable without node details", async () => {
    await start(true);
    const swap = await pendingLnToFiberSwap();
    net.demoLn.failNext = "payInvoice";
    const res = await http().post("/v1/demo/payments").send({ swapId: swap.id });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe(API_ERROR_CODE.UPSTREAM_UNAVAILABLE);
    expect(JSON.stringify(res.body)).not.toContain("simulated transport error");
  });

  it.each(["/v1/demo/invoices", "/v1/demo/payments"])("POST %s without demo nodes: 404 demo_disabled", async (path) => {
    await start(false);
    const res = await http().post(path).send({ direction: "ln_to_fiber", asset: "CKB", amount: "1000", swapId: SWAP_ID });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe(API_ERROR_CODE.DEMO_DISABLED);
  });
});
