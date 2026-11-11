import "reflect-metadata";
import { randomBytes } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import type { FiberChannelBalance } from "../../../src/application/ports/fiber.port";
import type { LnBalances } from "../../../src/application/ports/lightning.port";
import type { SwapStore } from "../../../src/application/ports/swap-store.port";
import { CLOCK, DEMO_FIBER, DEMO_LIGHTNING, FIBER, LIGHTNING, PRICE_SOURCES, SWAP_STORE } from "../../../src/application/ports/tokens";
import { SWAP_ENGINE, type SwapEngine } from "../../../src/application/swaps/swap-engine.contract";
import { SQLITE_IN_MEMORY_PATH } from "../../../src/common/constants/persistence.constants";
import { MS_PER_HOUR } from "../../../src/common/constants/protocol.constants";
import { sha256Hex } from "../../../src/common/utils/hex.util";
import { loadHubConfig, type HubConfig } from "../../../src/config/hub.config";
import type { BtcNetwork, Direction, FiberAssetId, Hex32, Script } from "../../../src/domain/types";
import type { DemoInvoiceDto, SwapDto } from "../../../src/interfaces/http/contract/responses";
import { FakeClock, FakeFiberNetwork, FakeLightningNetwork, FakePriceSource, type FakeFiberNode, type FakeLightningNode } from "../../fakes";
import {
  createSwap,
  getSwap,
  isFinished,
  lightningSideQuote,
  postDemoInvoice,
  postDemoPayment,
  postQuote,
  startHubApp,
  type HttpClient,
  type ProviderOverride,
  type QuoteBody,
} from "../../support/hub-http";
import { DEVNET_RUSD_SCRIPT, spyOnLogger } from "../api/api.fixtures";

export {
  API_PATH,
  createSwap,
  expectApiError,
  getEvents,
  getSwap,
  isFinished,
  LOOPBACK_HOST,
  postDemoInvoice,
  postDemoPayment,
  postQuote,
  postSwap,
  startHubApp,
  waitForSwap,
  type HttpClient,
  type ProviderOverride,
  type QuoteBody,
} from "../../support/hub-http";

/**
 * Integration fixtures: the real composition root (AppModule) with every real module, where only the node adapters,
 * the price sources and the clock are fakes (test/fakes) and the database lives in memory. The app listens on the
 * loopback interface and is driven over HTTP with supertest, as the web app drives it.
 */

/* ----------------------------------------------------------------------------------------------- test values */

export const CKB_SHANNONS = 100_000_000n;
export const RUSD_SCRIPT: Script = DEVNET_RUSD_SCRIPT;
/** A Lightning amount well inside the default caps (1,000 to 100,000 sats). */
export const SWAP_SATS = 10_000n;

/** Hub channels: generous CKB and RUSD payout balances, unless a test sets its own. */
export const HUB_FIBER_CHANNELS: FiberChannelBalance[] = [
  { channelId: `0x${"a1".repeat(32)}`, peer: "user", udtTypeScript: null, ready: true, localBalance: 100_000n * CKB_SHANNONS, remoteBalance: 0n },
  { channelId: `0x${"a2".repeat(32)}`, peer: "user", udtTypeScript: RUSD_SCRIPT, ready: true, localBalance: 50_000n * CKB_SHANNONS, remoteBalance: 0n },
];

/**
 * The devnet-like settings every integration app starts from: in-memory database, demo wallet on, RUSD configured.
 * The swap timer is an hour, so swaps move only on explicit engine passes and node push hints unless a test shortens it.
 */
export const INTEGRATION_ENV: Readonly<Record<string, string>> = {
  HUB_DB_PATH: SQLITE_IN_MEMORY_PATH,
  UDT_RUSD_SCRIPT: JSON.stringify(RUSD_SCRIPT),
  DEMO_ENABLED: "true",
  DEMO_LND_GRPC_HOST: "127.0.0.1:10010",
  DEMO_FIBER_RPC_URL: "http://127.0.0.1:8237",
  SWAP_POLL_INTERVAL_MS: String(MS_PER_HOUR),
};

export const integrationConfig = (env: Record<string, string> = {}): HubConfig => loadHubConfig({ ...INTEGRATION_ENV, ...env });

/* ---------------------------------------------------------------------------------------------- app builders */

export interface FakeHubOptions {
  /** Env vars on top of INTEGRATION_ENV. */
  env?: Record<string, string>;
  /** The network the fake Lightning nodes (and their invoices) are on. Default: the hub's own BTC_NETWORK. */
  lightningNetwork?: BtcNetwork;
  hubLnBalances?: Partial<LnBalances>;
  hubFiberChannels?: FiberChannelBalance[];
  /** False hides onUpdate on the hub's nodes, so only the scheduler's timer and explicit passes move swaps. */
  pushHints?: boolean;
}

/** Everything a test needs to drive and inspect a running hub on fake nodes. "user" nodes are the demo wallet's. */
export interface FakeHub {
  app: INestApplication;
  config: HubConfig;
  clock: FakeClock;
  ln: FakeLightningNetwork;
  fiber: FakeFiberNetwork;
  hubLn: FakeLightningNode;
  userLn: FakeLightningNode;
  hubFiber: FakeFiberNode;
  userFiber: FakeFiberNode;
  prices: FakePriceSource[];
  engine: SwapEngine;
  store: SwapStore;
  http(): HttpClient;
}

/** Hides a fake node's push hints (a prototype method) behind an own property, like an adapter without onUpdate. */
const withoutPushHints = <T extends object>(node: T): T => Object.defineProperty(node, "onUpdate", { value: undefined });

export async function startFakeHub(options: FakeHubOptions = {}): Promise<FakeHub> {
  const config = integrationConfig(options.env);
  const clock = new FakeClock();
  const ln = new FakeLightningNetwork(options.lightningNetwork ?? config.bitcoin.network, clock);
  const fiber = new FakeFiberNetwork(config.ckb.network, clock);
  const hubLn = ln.node("hub", options.hubLnBalances);
  const userLn = ln.node("user");
  const hubFiber = fiber.node("hub");
  const userFiber = fiber.node("user");
  hubFiber.setChannels(options.hubFiberChannels ?? HUB_FIBER_CHANNELS);
  if (options.pushHints === false) [hubLn, hubFiber].forEach(withoutPushHints);
  const prices = [new FakePriceSource("coingecko", clock), new FakePriceSource("binance", clock), new FakePriceSource("kucoin", clock)];

  const overrides: ProviderOverride[] = [
    [CLOCK, clock],
    [LIGHTNING, hubLn],
    [FIBER, hubFiber],
    [PRICE_SOURCES, prices],
  ];
  if (config.demo.enabled) overrides.push([DEMO_LIGHTNING, userLn], [DEMO_FIBER, userFiber]);
  const app = await startHubApp(config, overrides);
  return {
    app,
    config,
    clock,
    ln,
    fiber,
    hubLn,
    userLn,
    hubFiber,
    userFiber,
    prices,
    engine: app.get<SwapEngine>(SWAP_ENGINE),
    store: app.get<SwapStore>(SWAP_STORE),
    http: () => request(app.getHttpServer()),
  };
}

/** Silences Nest's loggers for every test of the calling file and closes the hub each test started. */
export function useHubLifecycle(): { track<T extends { app: INestApplication }>(hub: T): T } {
  const started: INestApplication[] = [];
  beforeEach(() => spyOnLogger());
  afterEach(async () => {
    for (const app of started.splice(0)) await app.close();
    jest.restoreAllMocks();
  });
  return {
    track: (hub) => {
      started.push(hub.app);
      return hub;
    },
  };
}

/* ----------------------------------------------------------------------------------------- HTTP conversations */

/** The Lightning side fixed at `sats` (default SWAP_SATS): what the user pays (ln_to_fiber) or receives (fiber_to_ln). */
export const lightningQuote = (direction: Direction, asset: FiberAssetId, sats: bigint = SWAP_SATS): QuoteBody =>
  lightningSideQuote(direction, asset, sats);

/** Runs engine passes (as the scheduler does) until `done` holds, then returns the swap as the API shows it. */
export async function processUntil(hub: FakeHub, swapId: string, done: (swap: SwapDto) => boolean = isFinished, maxPasses = 12): Promise<SwapDto> {
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const swap = await getSwap(hub, swapId);
    if (done(swap)) return swap;
    await hub.engine.processOpenSwaps();
  }
  return getSwap(hub, swapId);
}

/** The whole happy path up to a paid hold invoice: quote, demo payout invoice, swap, demo payment. */
export async function startPaidDemoSwap(hub: FakeHub, direction: Direction, asset: FiberAssetId, beforePayment?: (invoice: DemoInvoiceDto) => void) {
  const quote = await postQuote(hub, lightningQuote(direction, asset));
  const payout = await postDemoInvoice(hub, quote);
  beforePayment?.(payout);
  const swap = await createSwap(hub, quote.id, payout.invoice, true);
  await postDemoPayment(hub, swap.id);
  return { quote, payout, swap };
}

/* ------------------------------------------------------------------------------------------ user's own wallet */

export interface UserInvoice {
  invoice: string;
  preimage: Hex32;
  paymentHash: Hex32;
}

const newPreimage = (): Hex32 => randomBytes(32).toString("hex");

/** A BOLT11 invoice from the user's own Lightning wallet; `sats` null leaves the amount to the payer. */
export function userLnInvoice(hub: FakeHub, sats: bigint | null, opts: { expirySeconds?: number; cltvExpiry?: number } = {}): UserInvoice {
  const preimage = newPreimage();
  return { invoice: hub.userLn.createInvoiceWithPreimage(preimage, sats, opts), preimage, paymentHash: sha256Hex(preimage) };
}

/** A sha256 Fiber invoice from the user's own node; `amount` null leaves the amount to the payer. */
export function userFiberInvoice(hub: FakeHub, amount: bigint | null, udt: Script | null = null): UserInvoice {
  const preimage = newPreimage();
  return { invoice: hub.userFiber.createInvoiceWithOptions(preimage, { amount, udt }), preimage, paymentHash: sha256Hex(preimage) };
}
