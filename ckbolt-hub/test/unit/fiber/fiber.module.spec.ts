import "reflect-metadata";
import { createServer as createNetServer, type AddressInfo, type Socket } from "node:net";
import { Inject, Injectable, Module, type Type } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import type { FiberPort } from "../../../src/application/ports/fiber.port";
import { CLOCK, DEMO_FIBER, FIBER, HUB_CONFIG } from "../../../src/application/ports/tokens";
import { HubConfigModule } from "../../../src/config/config.module";
import { loadHubConfig, type FiberConnection, type HubConfig } from "../../../src/config/hub.config";
import type { CkbNetwork } from "../../../src/domain/types";
import { FiberRpcAdapter } from "../../../src/infrastructure/fiber/fiber-rpc.adapter";
import { FiberStoreChangesSubscriber } from "../../../src/infrastructure/fiber/fiber-store-changes.subscriber";
import { createDemoFiber, createFiberRpcAdapter, createHubFiber } from "../../../src/infrastructure/fiber/fiber.factory";
import { FiberModule } from "../../../src/infrastructure/fiber/fiber.module";
import { FakeClock } from "../../fakes";
import { PAYMENT_HASH } from "./fiber.fixtures";
import { eventually, FnnSimulator, startFakeFnnServer, type FakeFnnServer } from "./fnn-simulator";

const HUB_PUBKEY = `02${"a1".repeat(32)}`;
const DEMO_PUBKEY = `03${"d3".repeat(32)}`;
const HUB_TOKEN = "hub-biscuit";
const DEMO_TOKEN = "demo-biscuit";
/** Client timings every connection in these specs uses (HubConfig fills them from FIBER_RPC_TIMEOUT_MS and FIBER_PUBSUB_RECONNECT_MS). */
const TIMINGS = { rpcTimeoutMs: 10_000, pubsubReconnectMs: 5_000 } as const;

/** A feature module that injects the Fiber ports without importing FiberModule, as application modules do. */
@Injectable()
class FiberUser {
  constructor(
    @Inject(FIBER) readonly fiber: FiberPort,
    @Inject(DEMO_FIBER) readonly demoFiber: FiberPort | null,
  ) {}
}

@Module({ providers: [FiberUser], exports: [FiberUser] })
class FeatureModule {}

interface ConfigOptions {
  network?: CkbNetwork;
  fiber: FiberConnection;
  demoFiber?: FiberConnection | null;
  demoEnabled?: boolean;
}

/** The validated defaults with the Fiber connections and the demo switch replaced. */
function hubConfig(options: ConfigOptions): HubConfig {
  const defaults = loadHubConfig({});
  return {
    ...defaults,
    ckb: { ...defaults.ckb, network: options.network ?? "testnet" },
    fiber: options.fiber,
    demo: { ...defaults.demo, enabled: options.demoEnabled ?? false, fiber: options.demoFiber ?? null },
  };
}

describe("FiberModule", () => {
  let hubServer: FakeFnnServer;
  let demoServer: FakeFnnServer;
  let moduleRef: TestingModule | undefined;

  const hubConnection = (overrides: Partial<FiberConnection> = {}): FiberConnection => ({
    rpcUrl: hubServer.rpcUrl,
    authToken: HUB_TOKEN,
    pubsub: false,
    ...TIMINGS,
    ...overrides,
  });
  const demoConnection = (): FiberConnection => ({ rpcUrl: demoServer.rpcUrl, authToken: DEMO_TOKEN, pubsub: false, ...TIMINGS });

  const compile = async (config: HubConfig, extraImports: Type<unknown>[] = []): Promise<TestingModule> => {
    moduleRef = await Test.createTestingModule({ imports: [HubConfigModule, FiberModule, ...extraImports] })
      .overrideProvider(HUB_CONFIG)
      .useValue(config)
      .overrideProvider(CLOCK)
      .useValue(new FakeClock())
      .compile();
    await moduleRef.init();
    return moduleRef;
  };

  beforeEach(async () => {
    moduleRef = undefined;
    hubServer = await startFakeFnnServer(new FnnSimulator("Fibt", new FakeClock(), HUB_PUBKEY));
    demoServer = await startFakeFnnServer(new FnnSimulator("Fibt", new FakeClock(), DEMO_PUBKEY));
  });

  afterEach(async () => {
    await moduleRef?.close();
    await hubServer.close();
    await demoServer.close();
    jest.restoreAllMocks();
  });

  describe("FIBER (the hub's node, config.fiber)", () => {
    it("is a FiberRpcAdapter", async () => {
      const app = await compile(hubConfig({ fiber: hubConnection() }));
      expect(app.get(FIBER)).toBeInstanceOf(FiberRpcAdapter);
    });

    it("talks JSON-RPC to config.fiber.rpcUrl with its Biscuit token and reports the configured network", async () => {
      const app = await compile(hubConfig({ network: "testnet", fiber: hubConnection() }));
      await expect(app.get<FiberPort>(FIBER).getInfo()).resolves.toEqual({ nodeId: HUB_PUBKEY, network: "testnet", version: "0.9.1" });
      expect(hubServer.httpHeaders[0]?.authorization).toBe(`Bearer ${HUB_TOKEN}`);
      expect(hubServer.httpHeaders[0]?.["content-type"]).toBe("application/json");
      expect(demoServer.httpHeaders).toHaveLength(0);
    });

    it("sends no Authorization header when no token is configured", async () => {
      const app = await compile(hubConfig({ fiber: hubConnection({ authToken: undefined }) }));
      await app.get<FiberPort>(FIBER).getInfo();
      expect(hubServer.httpHeaders[0]?.authorization).toBeUndefined();
    });

    it("creates invoices in the configured network's currency", async () => {
      const app = await compile(hubConfig({ network: "testnet", fiber: hubConnection() }));
      const { invoice } = await app.get<FiberPort>(FIBER).createHoldInvoice({
        paymentHash: PAYMENT_HASH,
        amount: 100n,
        udtTypeScript: null,
        expirySeconds: 60,
        finalExpiryDeltaMs: 6 * 60 * 60 * 1_000,
        description: "module test",
      });
      expect(invoice).toMatch(/^fibt1/);
    });

    it("has no onUpdate when pubsub is off, so the engine polls", async () => {
      const app = await compile(hubConfig({ fiber: hubConnection({ pubsub: false }) }));
      expect(app.get<FiberPort>(FIBER).onUpdate).toBeUndefined();
    });

    it("pushes store changes over ws:// on the RPC host and port when pubsub is on", async () => {
      const app = await compile(hubConfig({ fiber: hubConnection({ pubsub: true }) }));
      const fiber = app.get<FiberPort>(FIBER);
      expect(fiber.onUpdate).toEqual(expect.any(Function));
      expect(hubServer.wsHeaders).toHaveLength(0);

      const seen: string[] = [];
      fiber.onUpdate?.((hash) => seen.push(hash));
      await hubServer.waitForSubscribers(1);
      expect(hubServer.wsHeaders[0]?.authorization).toBe(`Bearer ${HUB_TOKEN}`);

      hubServer.push({ PutPreimage: { payment_hash: `0x${PAYMENT_HASH}`, payment_preimage: `0x${"00".repeat(32)}` } });
      await eventually(() => seen.length === 1);
      expect(seen).toEqual([PAYMENT_HASH]);
    });

    it("closes the store-changes socket when the application shuts down", async () => {
      const close = jest.spyOn(FiberStoreChangesSubscriber.prototype, "close");
      const app = await compile(hubConfig({ fiber: hubConnection({ pubsub: true }) }));
      app.get<FiberPort>(FIBER).onUpdate?.(() => undefined);
      await hubServer.waitForSubscribers(1);

      await app.close();
      moduleRef = undefined;

      expect(close).toHaveBeenCalledTimes(1);
      await eventually(() => hubServer.subscribers() === 0);
    });
  });

  describe("DEMO_FIBER (the demo wallet's node, config.demo.fiber)", () => {
    it("is null when the demo is disabled, even with a demo connection configured", async () => {
      const app = await compile(hubConfig({ fiber: hubConnection(), demoEnabled: false, demoFiber: demoConnection() }));
      expect(app.get(DEMO_FIBER)).toBeNull();
    });

    it("is null when the demo is enabled without a demo Fiber connection", async () => {
      const app = await compile(hubConfig({ fiber: hubConnection(), demoEnabled: true, demoFiber: null }));
      expect(app.get(DEMO_FIBER)).toBeNull();
    });

    it("talks to config.demo.fiber with its own token when the demo is enabled", async () => {
      const app = await compile(hubConfig({ network: "testnet", fiber: hubConnection(), demoEnabled: true, demoFiber: demoConnection() }));
      const demo = app.get<FiberPort | null>(DEMO_FIBER);
      expect(demo).toBeInstanceOf(FiberRpcAdapter);
      expect(demo).not.toBe(app.get(FIBER));

      await expect(demo?.getInfo()).resolves.toEqual({ nodeId: DEMO_PUBKEY, network: "testnet", version: "0.9.1" });
      expect(demoServer.httpHeaders[0]?.authorization).toBe(`Bearer ${DEMO_TOKEN}`);
      expect(hubServer.httpHeaders).toHaveLength(0);
    });
  });

  it("is global: a feature module injects FIBER and DEMO_FIBER without importing FiberModule", async () => {
    const app = await compile(hubConfig({ fiber: hubConnection(), demoEnabled: true, demoFiber: demoConnection() }), [FeatureModule]);
    const user = app.get(FiberUser);
    expect(user.fiber).toBe(app.get(FIBER));
    expect(user.demoFiber).toBe(app.get(DEMO_FIBER));
  });
});

describe("fiber.factory", () => {
  const connection: FiberConnection = { rpcUrl: "http://127.0.0.1:1", pubsub: false, ...TIMINGS };

  it("reads the client timings from HubConfig, the same for the hub's and the demo wallet's node", () => {
    const config = loadHubConfig({
      FIBER_RPC_TIMEOUT_MS: "1234",
      FIBER_PUBSUB_RECONNECT_MS: "567",
      DEMO_ENABLED: "true",
      DEMO_LND_GRPC_HOST: "127.0.0.1:10010",
      DEMO_FIBER_RPC_URL: "http://127.0.0.1:8237",
    });
    expect(config.fiber).toMatchObject({ rpcTimeoutMs: 1234, pubsubReconnectMs: 567 });
    expect(config.demo.fiber).toMatchObject({ rpcTimeoutMs: 1234, pubsubReconnectMs: 567 });
    expect(loadHubConfig({}).fiber).toMatchObject({ rpcTimeoutMs: 10_000, pubsubReconnectMs: 5_000 });
  });

  it("builds the hub adapter from config.fiber and config.ckb.network", async () => {
    const server = await startFakeFnnServer(new FnnSimulator("Fibd", new FakeClock(), HUB_PUBKEY));
    try {
      const config = hubConfig({ network: "devnet", fiber: { rpcUrl: server.rpcUrl, pubsub: false, ...TIMINGS } });
      await expect(createHubFiber(config).getInfo()).resolves.toMatchObject({ nodeId: HUB_PUBKEY, network: "devnet" });
    } finally {
      await server.close();
    }
  });

  it("returns no demo adapter when the demo is off", () => {
    expect(createDemoFiber(hubConfig({ fiber: connection, demoEnabled: false, demoFiber: connection }))).toBeNull();
  });

  it("times out a node that accepts the connection but never answers, using the connection's timeout", async () => {
    const accepted: Socket[] = [];
    const silent = createNetServer((socket) => accepted.push(socket));
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const { port } = silent.address() as AddressInfo;
    try {
      const adapter = createFiberRpcAdapter({ rpcUrl: `http://127.0.0.1:${port}`, pubsub: false, rpcTimeoutMs: 100, pubsubReconnectMs: 50 }, "testnet");
      const started = Date.now();
      await expect(adapter.getInfo()).rejects.toMatchObject({ name: "FiberRpcTransportError", failure: "timeout" });
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      for (const socket of accepted) socket.destroy();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  });
});
