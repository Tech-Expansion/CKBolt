import { createServer as createNetServer, type AddressInfo, type Socket } from "node:net";
import request from "supertest";
import { WebSocketServer } from "ws";
import { CLOCK, LIGHTNING, PRICE_SOURCES } from "../../../src/application/ports/tokens";
import { MS_PER_MINUTE, MS_PER_SECOND } from "../../../src/common/constants/protocol.constants";
import { TIMING_PROFILES, type TimingProfileName } from "../../../src/common/constants/timing.constants";
import { loadHubConfig, type HubConfig } from "../../../src/config/hub.config";
import { FakeClock, FakeLightningNetwork, FakePriceSource } from "../../fakes";
import { readEnvExample } from "../../support/env-example";
import {
  API_PATH,
  createSwap,
  integrationConfig,
  lightningQuote,
  LOOPBACK_HOST,
  postDemoInvoice,
  postQuote,
  startFakeHub,
  startHubApp,
  SWAP_SATS,
  userLnInvoice,
  useHubLifecycle,
  type FakeHub,
} from "./integration.fixtures";

/**
 * The tunables the integration step moved from constants into HubConfig (env vars in .env.example): their defaults,
 * their validation, that .env.example documents the defaults the code uses, and that each one reaches the code that
 * uses it in the running app.
 */

interface Tunable {
  env: string;
  read: (config: HubConfig) => number;
  /** 0 is a valid value (it turns the feature off or adds nothing). */
  zeroAllowed: boolean;
}

const TUNABLES: readonly Tunable[] = [
  { env: "PRICE_CACHE_MS", read: (c) => c.pricing.priceCacheMs, zeroAllowed: true },
  { env: "FIBER_RPC_TIMEOUT_MS", read: (c) => c.fiber.rpcTimeoutMs, zeroAllowed: false },
  { env: "FIBER_PUBSUB_RECONNECT_MS", read: (c) => c.fiber.pubsubReconnectMs, zeroAllowed: false },
  { env: "HEALTH_CHECK_TIMEOUT_MS", read: (c) => c.health.timeoutMs, zeroAllowed: false },
  { env: "DEMO_PAYOUT_INVOICE_EXTRA_SECONDS", read: (c) => c.demo.payoutInvoiceExtraSeconds, zeroAllowed: true },
  { env: "LN_MAX_PAYMENT_PARTS", read: (c) => c.swaps.lnMaxPaymentParts, zeroAllowed: false },
  { env: "LN_ROUTE_BUDGET_BLOCKS", read: (c) => c.timing.lnRouteBudgetBlocks, zeroAllowed: true },
  { env: "HOLD_INVOICE_EXPIRY_TOLERANCE_SECONDS", read: (c) => c.swaps.holdInvoiceExpiryToleranceMs / MS_PER_SECOND, zeroAllowed: true },
  { env: "MAX_PAYOUT_LOCK_MINUTES", read: (c) => c.timing.maxPayoutLockMs / MS_PER_MINUTE, zeroAllowed: false },
  { env: "FIBER_PEER_CHANNEL_COMMITMENT_DELAY_EPOCHS", read: (c) => c.swaps.fiberPeerChannelCommitmentDelayEpochs, zeroAllowed: false },
  { env: "FIBER_PEER_CHANNELS_MAX_OPEN", read: (c) => c.fiberPeers.peerChannels.maxOpen, zeroAllowed: true },
];

describe("HubConfig tunables of the integration step", () => {
  describe.each(TUNABLES)("$env", ({ env, read, zeroAllowed }) => {
    it("is documented in .env.example with the default the code uses", () => {
      const documented = readEnvExample()[env];
      expect(documented).toBeDefined();
      expect(read(loadHubConfig({}))).toBe(Number(documented));
    });

    it("is read from its env var", () => {
      expect(read(loadHubConfig({ [env]: "7" }))).toBe(7);
    });

    it.each(["abc", "-1", "1.5", "1e400"])("refuses %p with an error naming the variable", (value) => {
      expect(() => loadHubConfig({ [env]: value })).toThrow(/^Invalid hub configuration: .*/);
      expect(() => loadHubConfig({ [env]: value })).toThrow(env);
    });

    it(zeroAllowed ? "accepts 0" : "refuses 0", () => {
      if (zeroAllowed) expect(read(loadHubConfig({ [env]: "0" }))).toBe(0);
      else expect(() => loadHubConfig({ [env]: "0" })).toThrow(env);
    });
  });

  it("lists every bad variable in one error", () => {
    expect(() => loadHubConfig({ LN_MAX_PAYMENT_PARTS: "0", HEALTH_CHECK_TIMEOUT_MS: "soon" })).toThrow(
      /(?=.*LN_MAX_PAYMENT_PARTS)(?=.*HEALTH_CHECK_TIMEOUT_MS)/,
    );
  });

  it.each(Object.keys(TIMING_PROFILES) as TimingProfileName[])(
    "LN_ROUTE_BUDGET_BLOCKS defaults to the %s profile's budget and overrides it when set",
    (profile) => {
      expect(loadHubConfig({ TIMING_PROFILE: profile }).timing.lnRouteBudgetBlocks).toBe(TIMING_PROFILES[profile].lnRouteBudgetBlocks);
      expect(loadHubConfig({ TIMING_PROFILE: profile, LN_ROUTE_BUDGET_BLOCKS: "123" }).timing.lnRouteBudgetBlocks).toBe(123);
    },
  );

  it("gives the demo wallet's Fiber node the same client timings as the hub's, without pubsub", () => {
    const config = integrationConfig({ FIBER_RPC_TIMEOUT_MS: "2500", FIBER_PUBSUB_RECONNECT_MS: "750", FIBER_PUBSUB: "true" });
    expect(config.fiber).toMatchObject({ rpcTimeoutMs: 2_500, pubsubReconnectMs: 750, pubsub: true });
    expect(config.demo.fiber).toMatchObject({ rpcTimeoutMs: 2_500, pubsubReconnectMs: 750, pubsub: false });
  });
});

describe("HubConfig tunables in the running app", () => {
  const lifecycle = useHubLifecycle();
  const start = async (env: Record<string, string>): Promise<FakeHub> => lifecycle.track(await startFakeHub({ env }));

  it("HEALTH_CHECK_TIMEOUT_MS: a Lightning node that never answers is reported unreachable after the timeout (503)", async () => {
    const hub = await start({ HEALTH_CHECK_TIMEOUT_MS: "50" });
    jest.spyOn(hub.hubLn, "getInfo").mockReturnValue(new Promise(() => undefined));

    const started = Date.now();
    const res = await hub.http().get(API_PATH.HEALTH);

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: "degraded", lightning: { reachable: false }, fiber: { reachable: true } });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("PRICE_CACHE_MS: quotes inside the window share one fetch per source; after it, prices are fetched again", async () => {
    const hub = await start({ PRICE_CACHE_MS: "15000" });
    const fetches = hub.prices.map((source) => jest.spyOn(source, "fetch"));
    // The scheduler and earlier requests fetched nothing yet; start counting from here.
    for (const fetch of fetches) fetch.mockClear();

    await postQuote(hub, lightningQuote("ln_to_fiber", "CKB"));
    await postQuote(hub, lightningQuote("fiber_to_ln", "RUSD"));
    expect(fetches.map((fetch) => fetch.mock.calls.length)).toEqual(hub.prices.map(() => 1));

    hub.clock.advance(hub.config.pricing.priceCacheMs);
    await postQuote(hub, lightningQuote("ln_to_fiber", "CKB"));
    expect(fetches.map((fetch) => fetch.mock.calls.length)).toEqual(hub.prices.map(() => 2));
  });

  it("PRICE_CACHE_MS=0: every quote fetches fresh prices", async () => {
    const hub = await start({ PRICE_CACHE_MS: "0" });
    const fetches = hub.prices.map((source) => jest.spyOn(source, "fetch"));

    await postQuote(hub, lightningQuote("ln_to_fiber", "CKB"));
    await postQuote(hub, lightningQuote("ln_to_fiber", "CKB"));

    expect(fetches.map((fetch) => fetch.mock.calls.length)).toEqual(hub.prices.map(() => 2));
  });

  it("DEMO_PAYOUT_INVOICE_EXTRA_SECONDS: demo payout invoices live the longest quote validity plus the extra, in both directions", async () => {
    // A demo invoice may be for a swap quote or a request quote: it outlives the longer of the two, here a request's.
    const hub = await start({ DEMO_PAYOUT_INVOICE_EXTRA_SECONDS: "600", QUOTE_TTL_SECONDS: "120", REQUEST_QUOTE_TTL_SECONDS: "300" });
    const lifetimeMs = (300 + 600) * MS_PER_SECOND;

    const lnPayout = await postDemoInvoice(hub, await postQuote(hub, lightningQuote("fiber_to_ln", "CKB")));
    const decoded = await hub.userLn.decodeInvoice(lnPayout.invoice);
    expect(decoded.expiresAt - decoded.createdAt).toBe(lifetimeMs);

    const fiberPayout = await postDemoInvoice(hub, await postQuote(hub, lightningQuote("ln_to_fiber", "RUSD")));
    const parsed = await hub.userFiber.parseInvoice(fiberPayout.invoice);
    expect((parsed.expiresAt ?? 0) - parsed.createdAt).toBe(lifetimeMs);
  });

  it("LN_ROUTE_BUDGET_BLOCKS: each extra block of route budget widens the fiber_to_ln hold invoice by one slow block", async () => {
    const [smallBudget, largeBudget] = [80, 240];
    const holdDeltaMs = async (budget: number): Promise<number> => {
      // The payout lock cap is lifted so the larger budget still fits under it.
      const hub = await start({ LN_ROUTE_BUDGET_BLOCKS: String(budget), MAX_PAYOUT_LOCK_MINUTES: String(7 * 24 * 60) });
      const quote = await postQuote(hub, lightningQuote("fiber_to_ln", "CKB"));
      const swap = await createSwap(hub, quote.id, userLnInvoice(hub, SWAP_SATS).invoice);
      return (await hub.hubFiber.parseInvoice(swap.pay.invoice)).finalExpiryDeltaMs ?? Number.NaN;
    };
    const small = await holdDeltaMs(smallBudget);
    const large = await holdDeltaMs(largeBudget);

    expect(large - small).toBe((largeBudget - smallBudget) * TIMING_PROFILES.regtest.btcSlowBlockSeconds * MS_PER_SECOND);
  });
});

describe("Fiber client tunables against a real socket", () => {
  const lifecycle = useHubLifecycle();

  /** The real AppModule with the real FiberModule (FIBER from config); Lightning, prices and the clock are fakes. */
  async function startWithRealFiber(env: Record<string, string>) {
    const config = integrationConfig({ DEMO_ENABLED: "false", ...env });
    const clock = new FakeClock();
    return startHubApp(config, [
      [CLOCK, clock],
      [LIGHTNING, new FakeLightningNetwork(config.bitcoin.network, clock).node("hub")],
      [PRICE_SOURCES, [new FakePriceSource("coingecko", clock)]],
    ]);
  }

  it("FIBER_RPC_TIMEOUT_MS: a node that accepts the connection but never answers is unreachable after the RPC timeout", async () => {
    const accepted: Socket[] = [];
    const silent = createNetServer((socket) => accepted.push(socket));
    await new Promise<void>((resolve) => silent.listen(0, LOOPBACK_HOST, resolve));
    const { port } = silent.address() as AddressInfo;
    try {
      const { app } = lifecycle.track({
        app: await startWithRealFiber({
          FIBER_RPC_URL: `http://${LOOPBACK_HOST}:${port}`,
          FIBER_RPC_TIMEOUT_MS: "100",
          HEALTH_CHECK_TIMEOUT_MS: "8000",
        }),
      });
      const started = Date.now();
      const res = await request(app.getHttpServer()).get(API_PATH.HEALTH);

      expect(res.status).toBe(503);
      expect(res.body.fiber).toEqual({ reachable: false, network: null, version: null });
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(accepted.length).toBeGreaterThan(0);
    } finally {
      for (const socket of accepted) socket.destroy();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  });

  it.each([
    ["25", (count: number) => expect(count).toBeGreaterThanOrEqual(3)],
    ["10000", (count: number) => expect(count).toBe(1)],
  ])("FIBER_PUBSUB_RECONNECT_MS=%s: the store-changes socket is reopened after that delay", async (delay, check) => {
    const wss = new WebSocketServer({ host: LOOPBACK_HOST, port: 0 });
    await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
    let connections = 0;
    wss.on("connection", (socket) => {
      connections += 1;
      socket.close();
    });
    const { port } = wss.address() as AddressInfo;
    try {
      const app = await startWithRealFiber({ FIBER_RPC_URL: `http://${LOOPBACK_HOST}:${port}`, FIBER_PUBSUB: "true", FIBER_PUBSUB_RECONNECT_MS: delay });
      await new Promise((resolve) => setTimeout(resolve, 600));
      await app.close();
      check(connections);
    } finally {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });
});
