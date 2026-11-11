import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../../../src/app.module";
import { DEMO_WALLET } from "../../../src/application/demo/demo-wallet.contract";
import { HEALTH_SERVICE } from "../../../src/application/health/health.contract";
import type { SwapStore } from "../../../src/application/ports/swap-store.port";
import { CLOCK, DEMO_FIBER, DEMO_LIGHTNING, FIBER, HUB_CONFIG, LIGHTNING, PRICE_SOURCES, SWAP_STORE } from "../../../src/application/ports/tokens";
import { PRICING_SERVICE } from "../../../src/application/pricing/pricing.contract";
import { SWAP_ENGINE, type SwapEngine } from "../../../src/application/swaps/swap-engine.contract";
import { SwapSchedulerService } from "../../../src/application/swaps/swap-scheduler.service";
import { SQLITE_IN_MEMORY_PATH } from "../../../src/common/constants/persistence.constants";
import { loadHubConfig, type HubConfig } from "../../../src/config/hub.config";
import { FakeClock, FakeFiberNetwork, FakeLightningNetwork, FakePriceSource, type FakeLightningNode } from "../../fakes";
import { DEVNET_RUSD_SCRIPT, spyOnLogger } from "../api/api.fixtures";
import { makeSwap } from "../persistence/persistence.fixtures";

/**
 * The composition root (AppModule) with every real module; only the node adapters, the price sources and the clock are
 * replaced by fakes, and the database lives in memory. Proves dependency injection resolves end to end, the API answers,
 * and the shutdown order keeps the database open until the swap scheduler has stopped.
 */

const CKB = 100_000_000n;

/** The devnet settings (demo on, RUSD stand-in) with an in-memory database. */
const appConfig = (): HubConfig =>
  loadHubConfig({
    HUB_DB_PATH: SQLITE_IN_MEMORY_PATH,
    UDT_RUSD_SCRIPT: JSON.stringify(DEVNET_RUSD_SCRIPT),
    DEMO_ENABLED: "true",
    DEMO_LND_GRPC_HOST: "127.0.0.1:10010",
    DEMO_FIBER_RPC_URL: "http://127.0.0.1:8237",
  });

interface TestApp {
  app: INestApplication;
  hubLn: FakeLightningNode;
}

async function createApp(): Promise<TestApp> {
  const clock = new FakeClock();
  const ln = new FakeLightningNetwork("regtest", clock);
  const hubLn = ln.node("hub");
  const fiber = new FakeFiberNetwork("devnet", clock);
  const hubFiber = fiber.node("hub");
  hubFiber.setChannels([
    { channelId: "0x01", peer: "user", udtTypeScript: null, ready: true, localBalance: 100_000n * CKB, remoteBalance: 0n },
    { channelId: "0x02", peer: "user", udtTypeScript: DEVNET_RUSD_SCRIPT, ready: true, localBalance: 50_000n * CKB, remoteBalance: 0n },
  ]);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(HUB_CONFIG)
    .useValue(appConfig())
    .overrideProvider(CLOCK)
    .useValue(clock)
    .overrideProvider(LIGHTNING)
    .useValue(hubLn)
    .overrideProvider(DEMO_LIGHTNING)
    .useValue(ln.node("demo"))
    .overrideProvider(FIBER)
    .useValue(hubFiber)
    .overrideProvider(DEMO_FIBER)
    .useValue(fiber.node("demo"))
    .overrideProvider(PRICE_SOURCES)
    .useValue([new FakePriceSource("coingecko", clock), new FakePriceSource("binance", clock)])
    .compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  return { app, hubLn };
}

describe("AppModule", () => {
  let app: INestApplication | undefined;

  beforeEach(() => spyOnLogger());

  afterEach(async () => {
    await app?.close();
    app = undefined;
    jest.restoreAllMocks();
  });

  it("resolves every service behind its contract token", async () => {
    ({ app } = await createApp());
    for (const token of [PRICING_SERVICE, SWAP_ENGINE, DEMO_WALLET, HEALTH_SERVICE, SWAP_STORE]) expect(app.get(token)).toBeDefined();
    expect(app.get<{ enabled: boolean }>(DEMO_WALLET).enabled).toBe(true);
  });

  it("serves the API: health, assets, a quote in each direction and a demo invoice", async () => {
    ({ app } = await createApp());
    const http = request(app.getHttpServer());

    expect((await http.get("/v1/health").expect(200)).body.status).toBe("ok");
    const assets = await http.get("/v1/assets").expect(200);
    expect(assets.body.data.map((asset: { id: string }) => asset.id)).toEqual(["CKB", "RUSD"]);
    // 10,000 sats on the Lightning side: what the user pays (ln_to_fiber) or receives (fiber_to_ln).
    for (const [direction, side] of [["ln_to_fiber", "pay"], ["fiber_to_ln", "receive"]]) {
      const res = await http.post("/v1/quotes").send({ direction, asset: "RUSD", side, amount: "10000" }).expect(201);
      expect(res.headers.location).toBe(`/v1/quotes/${res.body.id}`);
    }
    await http.post("/v1/demo/invoices").send({ direction: "fiber_to_ln", asset: "CKB", amount: "10000" }).expect(201);
  });

  it("lets the scheduler finish its running swap work and stop before the database closes", async () => {
    const created = await createApp();
    app = created.app;
    const order: string[] = [];
    const store = app.get<SwapStore>(SWAP_STORE);
    const closeStore = store.close.bind(store);
    jest.spyOn(store, "close").mockImplementation(() => {
      order.push("database closed");
      closeStore();
    });
    const stopScheduler = SwapSchedulerService.prototype.onModuleDestroy;
    jest.spyOn(SwapSchedulerService.prototype, "onModuleDestroy").mockImplementation(async function (this: SwapSchedulerService) {
      await stopScheduler.call(this);
      order.push("scheduler stopped");
    });
    // A node update for an open swap starts work that is still running when shutdown begins; it reads the database.
    const swap = makeSwap(new FakeClock());
    jest.spyOn(store, "getSwapByHash").mockReturnValue(swap);
    const engine = app.get<SwapEngine>(SWAP_ENGINE);
    jest.spyOn(engine, "getSwap").mockReturnValue(swap);
    let finishWork: () => void = () => undefined;
    const workRunning = new Promise<void>((resolve) => (finishWork = resolve));
    jest.spyOn(engine, "processSwap").mockImplementation(async () => {
      await workRunning;
      store.listOpenSwaps();
      order.push("swap work finished");
    });
    created.hubLn.emit(swap.paymentHash);

    const closing = app.close();
    app = undefined;
    finishWork();
    await closing;

    expect(order).toEqual(["swap work finished", "scheduler stopped", "database closed"]);
  });
});
