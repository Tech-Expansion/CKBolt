import "reflect-metadata";
import { Logger, type INestApplication } from "@nestjs/common";
import request from "supertest";
import type { FiberChannelBalance } from "../../../src/application/ports/fiber.port";
import type { SwapStore } from "../../../src/application/ports/swap-store.port";
import { CLOCK, DEMO_FIBER, DEMO_LIGHTNING, FIBER, LIGHTNING, PRICE_SOURCES, SWAP_STORE } from "../../../src/application/ports/tokens";
import { SWAP_ENGINE, type SwapEngine } from "../../../src/application/swaps/swap-engine.contract";
import { SQLITE_IN_MEMORY_PATH } from "../../../src/common/constants/persistence.constants";
import { MS_PER_HOUR } from "../../../src/common/constants/protocol.constants";
import { loadHubConfig, type HubConfig } from "../../../src/config/hub.config";
import type { CellDep, Script } from "../../../src/domain/types";
import type { SwapDto } from "../../../src/interfaces/http/contract/responses";
import { FakeClock, FakeFiberNetwork, FakeLightningNetwork, FakePriceSource, type FakeChannel, type FakeFiberNode, type FakeLightningNode } from "../../fakes";
import { getSwap, isFinished, startHubApp, type HttpClient } from "../../support/hub-http";

/**
 * Shared values for the multi-asset tests: the CKB testnet UDTs spelled out as the VPS's FIBER_ASSETS lists them (so the
 * tests check the contract, not the code), and the real AppModule on fake nodes, an in-memory database and a fake clock.
 */

/* --------------------------------------------------------------------------------------------- testnet UDTs */

/** cWBTC (CCH Wrapped BTC) on CKB testnet: an xUDT with 8 decimals, one base unit per sat. */
export const CWBTC_SCRIPT: Script = {
  codeHash: "0x25c29dc317811a6f6f3985a7a9ebc4838bd388d19d0feeecf0bcd60f6c0975bb",
  hashType: "type",
  args: "0x9a1086531ed6dc69e0bd44cef5278e03faf3015b31aff60b08fb87663ce8507100000000",
};
export const CWBTC_CELL_DEP: CellDep = {
  outPoint: { txHash: "0xbf6fb538763efec2a70a6a3dcb7242787087e1030c4e7d86585bc63a9d337f5f", index: "0x0" },
  depType: "code",
};

/** RUSD on CKB testnet, with the cell dep of Fiber's bundled testnet whitelist. */
export const RUSD_SCRIPT: Script = {
  codeHash: "0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a",
  hashType: "type",
  args: "0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b",
};
export const RUSD_CELL_DEP: CellDep = {
  typeId: {
    codeHash: "0x00000000000000000000000000000000000000000000000000545950455f4944",
    hashType: "type",
    args: "0x97d30b723c0b2c66e9cb8d4d0df4ab5d7222cbb00d4a9a2055ce2e5d7f0d8b0f",
  },
};

/** 10^8: base units per whole RUSD, cWBTC or CKB. */
export const ONE_WHOLE = 100_000_000n;
export const INBOUND_RUSD = 20n * ONE_WHOLE;
/** 10 cWBTC: what bottle and bracer auto-accept. */
export const INBOUND_CWBTC = 10n * ONE_WHOLE;
export const INBOUND_CKB = 2_000n * ONE_WHOLE;
/** cWBTC's own Lightning cap in the example below; CKB and RUSD keep SWAP_MAX_SATS (100,000 by default). */
export const CWBTC_MAX_SATS = 20_000n;

/** The FIBER_ASSETS entries of the VPS example (docs/testing-testnet.md): RUSD, then cWBTC without an option premium. */
export const RUSD_ENTRY = {
  id: "RUSD",
  symbol: "RUSD",
  name: "RUSD stablecoin",
  decimals: 8,
  usdRule: "usd_peg",
  typeScript: RUSD_SCRIPT,
  cellDeps: [RUSD_CELL_DEP],
  inboundAmount: INBOUND_RUSD.toString(),
};
export const CWBTC_ENTRY = {
  id: "CWBTC",
  symbol: "cWBTC",
  name: "CCH Wrapped BTC",
  decimals: 8,
  usdRule: "btc_parity",
  typeScript: CWBTC_SCRIPT,
  cellDeps: [CWBTC_CELL_DEP],
  optionPremiumBps: 0,
  maxSats: CWBTC_MAX_SATS.toString(),
  inboundAmount: INBOUND_CWBTC.toString(),
  autoAcceptAmount: INBOUND_CWBTC.toString(),
};

export const P2P_ADDR = "/ip4/203.0.113.7/tcp/8228";
export const WS_ADDR = "/ip4/203.0.113.7/tcp/8228/ws";

/** Testnet with RUSD and cWBTC from FIBER_ASSETS, inbound channels on, the demo wallet on, an in-memory database. */
export const ASSETS_ENV: Readonly<Record<string, string>> = {
  HUB_DB_PATH: SQLITE_IN_MEMORY_PATH,
  CKB_NETWORK: "testnet",
  FIBER_ASSETS: JSON.stringify([RUSD_ENTRY, CWBTC_ENTRY]),
  FIBER_PUBLIC_P2P_ADDRS: P2P_ADDR,
  FIBER_PUBLIC_WS_ADDRS: WS_ADDR,
  FIBER_INBOUND_ENABLED: "true",
  FIBER_INBOUND_CKB_AMOUNT: INBOUND_CKB.toString(),
  DEMO_ENABLED: "true",
  DEMO_LND_GRPC_HOST: "127.0.0.1:10010",
  DEMO_FIBER_RPC_URL: "http://127.0.0.1:8237",
  SWAP_POLL_INTERVAL_MS: String(MS_PER_HOUR),
};

export const assetsConfig = (env: Record<string, string> = {}): HubConfig => loadHubConfig({ ...ASSETS_ENV, ...env });

/** The hub's channels with a relay: generous CKB, RUSD and cWBTC payout liquidity. */
export const HUB_CHANNELS: FakeChannel[] = [
  { channelId: `0x${"a1".repeat(32)}`, peer: "relay", udtTypeScript: null, ready: true, localBalance: 100_000n * ONE_WHOLE, remoteBalance: 0n },
  { channelId: `0x${"a2".repeat(32)}`, peer: "relay", udtTypeScript: RUSD_SCRIPT, ready: true, localBalance: 10_000n * ONE_WHOLE, remoteBalance: 0n },
  { channelId: `0x${"a3".repeat(32)}`, peer: "relay", udtTypeScript: CWBTC_SCRIPT, ready: true, localBalance: 1_000n * ONE_WHOLE, remoteBalance: 0n },
];

/* ---------------------------------------------------------------------------------------------- the app */

export interface AssetsHub {
  app: INestApplication;
  config: HubConfig;
  clock: FakeClock;
  hubLn: FakeLightningNode;
  userLn: FakeLightningNode;
  hubFiber: FakeFiberNode;
  userFiber: FakeFiberNode;
  prices: FakePriceSource[];
  engine: SwapEngine;
  store: SwapStore;
  http(): HttpClient;
}

/** The real AppModule on fake nodes ("user" nodes are the demo wallet's), with `env` on top of ASSETS_ENV. */
export async function startAssetsHub(env: Record<string, string> = {}, channels: FiberChannelBalance[] = HUB_CHANNELS): Promise<AssetsHub> {
  const config = assetsConfig(env);
  const clock = new FakeClock();
  const ln = new FakeLightningNetwork(config.bitcoin.network, clock);
  const fiber = new FakeFiberNetwork(config.ckb.network, clock);
  const [hubLn, userLn] = [ln.node("hub"), ln.node("user")];
  const [hubFiber, userFiber] = [fiber.node("hub"), fiber.node("user")];
  hubFiber.setChannels(channels);
  const prices = ["coingecko", "binance", "kucoin"].map((name) => new FakePriceSource(name, clock));
  const app = await startHubApp(config, [
    [CLOCK, clock],
    [LIGHTNING, hubLn],
    [FIBER, hubFiber],
    [PRICE_SOURCES, prices],
    [DEMO_LIGHTNING, userLn],
    [DEMO_FIBER, userFiber],
  ]);
  return {
    app,
    config,
    clock,
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

/** Silences Nest's loggers for every test of the calling file and closes each hub a test started. */
export function useAssetsHubs(): { start: typeof startAssetsHub } {
  const started: INestApplication[] = [];
  beforeEach(() => {
    for (const level of ["error", "warn", "log"] as const) jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  });
  afterEach(async () => {
    for (const app of started.splice(0)) await app.close();
    jest.restoreAllMocks();
  });
  return {
    start: async (...args) => {
      const hub = await startAssetsHub(...args);
      started.push(hub.app);
      return hub;
    },
  };
}

/** Runs engine passes (as the scheduler does) until the swap is finished, then returns it as the API shows it. */
export async function processUntilFinished(hub: AssetsHub, swapId: string, maxPasses = 12): Promise<SwapDto> {
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const swap = await getSwap(hub, swapId);
    if (isFinished(swap)) return swap;
    await hub.engine.processOpenSwaps();
  }
  return getSwap(hub, swapId);
}

/** Every price source with its CKB feed down (BTC still answers). */
export const takeCkbFeedsDown = (hub: AssetsHub): void => {
  for (const source of hub.prices) source.prices = { ...source.prices, ckb: null };
};
