import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import type { FiberChannel } from "../../../src/application/ports/fiber.port";
import type { SwapStore } from "../../../src/application/ports/swap-store.port";
import { CLOCK, FIBER, LIGHTNING, PRICE_SOURCES, SWAP_STORE } from "../../../src/application/ports/tokens";
import { FIBER_CHANNEL_STATUS } from "../../../src/common/constants/fiber-node.constants";
import { SQLITE_IN_MEMORY_PATH } from "../../../src/common/constants/persistence.constants";
import { MS_PER_HOUR } from "../../../src/common/constants/protocol.constants";
import { assetRegistryOf, loadHubConfig, type HubConfig } from "../../../src/config/hub.config";
import type { AssetRegistry } from "../../../src/domain/assets";
import type { BtcNetwork, CkbNetwork, Script } from "../../../src/domain/types";
import { FakeClock, FakeFiberNetwork, FakeLightningNetwork, FakePriceSource, type FakeChannel, type FakeFiberNode, type FakeLightningNode } from "../../fakes";
import { startHubApp, type HttpClient } from "../../support/hub-http";
import { DEVNET_RUSD_SCRIPT } from "../api/api.fixtures";

/**
 * Shared values for the tests of the hub's Fiber node routes (GET /v1/fiber/node, inbound channels) and of the health
 * check reading each node's own network. Values are spelled out here so the tests check the contract, not the code.
 */

/* ------------------------------------------------------------------------------------------------- values */

export const ONE_CKB = 100_000_000n;
/** One RUSD in base units (8 decimals). */
export const ONE_RUSD = 100_000_000n;

/** What the tests configure an inbound channel to be funded with. */
export const INBOUND_CKB_AMOUNT = 500n * ONE_CKB;
export const INBOUND_RUSD_AMOUNT = 20n * ONE_RUSD;

/** Browser nodes (compressed public keys as fnn prints them: hex without 0x). */
export const BROWSER_NODE = `02${"b1".repeat(32)}`;
export const SECOND_NODE = `03${"c2".repeat(32)}`;
export const THIRD_NODE = `02${"d3".repeat(32)}`;
/** A public relay node the hub's fnn has routing channels with (bottle/bracer on testnet). */
export const RELAY_NODE = `02${"ee".repeat(32)}`;

/** The same node id as a client may type it: 0x prefix and upper-case hex. */
export const asTyped = (nodeId: string): string => `0x${nodeId.toUpperCase()}`;

export const P2P_ADDR = "/ip4/203.0.113.7/tcp/8228";
export const WS_ADDR = "/ip4/203.0.113.7/tcp/8228/ws";
export const WSS_ADDR = "/dns4/fiber.example.org/tcp/443/wss";

/** A UDT the hub does not serve (no CWBTC script is configured). */
export const UNSERVED_UDT_SCRIPT: Script = { codeHash: `0x${"77".repeat(32)}`, hashType: "type", args: `0x${"88".repeat(20)}` };
export const RUSD_SCRIPT: Script = DEVNET_RUSD_SCRIPT;

/** The REST paths as the plan's contract writes them (spelled out: the contract is what is under test). */
export const FIBER_PATH = {
  NODE: "/v1/fiber/node",
  INBOUND: "/v1/fiber/inbound-channels",
  inboundOf: (nodeId: string): string => `/v1/fiber/inbound-channels/${nodeId}`,
  HEALTH: "/v1/health",
  ASSETS: "/v1/assets",
} as const;

/* ------------------------------------------------------------------------------------------------- config */

/** Devnet settings with RUSD served, the public addresses set and inbound channels on, for CKB and RUSD. */
export const INBOUND_ENV: Readonly<Record<string, string>> = {
  HUB_DB_PATH: SQLITE_IN_MEMORY_PATH,
  UDT_RUSD_SCRIPT: JSON.stringify(RUSD_SCRIPT),
  SWAP_POLL_INTERVAL_MS: String(MS_PER_HOUR),
  FIBER_PUBLIC_P2P_ADDRS: P2P_ADDR,
  FIBER_PUBLIC_WS_ADDRS: `${WS_ADDR},${WSS_ADDR}`,
  FIBER_INBOUND_ENABLED: "true",
  FIBER_INBOUND_CKB_AMOUNT: INBOUND_CKB_AMOUNT.toString(),
  FIBER_INBOUND_RUSD_AMOUNT: INBOUND_RUSD_AMOUNT.toString(),
};

/** Env overrides on top of INBOUND_ENV; null leaves a variable unset. */
export type EnvPatch = Record<string, string | null>;

export const inboundEnv = (patch: EnvPatch = {}): Record<string, string> =>
  Object.fromEntries(Object.entries({ ...INBOUND_ENV, ...patch }).filter((entry): entry is [string, string] => entry[1] !== null));

export const inboundConfig = (patch: EnvPatch = {}): HubConfig => loadHubConfig(inboundEnv(patch));

export const assetsOf = (config: HubConfig): AssetRegistry => assetRegistryOf(config);

/* ------------------------------------------------------------------------------------------------ channels */

/** A channel of the hub's fnn: public, ready, opened by the hub, unless the overrides say otherwise. */
export function hubChannel(overrides: Partial<FiberChannel> & Pick<FiberChannel, "channelId">): FakeChannel {
  const status = overrides.status ?? FIBER_CHANNEL_STATUS.READY;
  return {
    peer: RELAY_NODE,
    udtTypeScript: null,
    ready: status === FIBER_CHANNEL_STATUS.READY,
    localBalance: 0n,
    remoteBalance: 0n,
    status,
    public: true,
    openedByPeer: false,
    ...overrides,
  };
}

export const channelId = (byte: string): string => `0x${byte.repeat(32)}`;

/** The hub's routing channels with the relay: generous CKB and RUSD payout liquidity. */
export const ROUTING_CHANNELS: FakeChannel[] = [
  hubChannel({ channelId: channelId("a1"), localBalance: 100_000n * ONE_CKB, remoteBalance: 1_000n * ONE_CKB }),
  hubChannel({ channelId: channelId("a2"), udtTypeScript: RUSD_SCRIPT, localBalance: 10_000n * ONE_RUSD }),
];

/* ---------------------------------------------------------------------------------------------- the app */

export interface FiberAccessHubOptions {
  env?: EnvPatch;
  /** The CKB network the hub's fnn really runs on. Default: the hub's CKB_NETWORK. */
  fiberNetwork?: CkbNetwork;
  /** The Bitcoin network the hub's LND really runs on. Default: the hub's BTC_NETWORK. */
  lightningNetwork?: BtcNetwork;
  channels?: FakeChannel[];
}

export interface FiberAccessHub {
  app: INestApplication;
  config: HubConfig;
  clock: FakeClock;
  hubFiber: FakeFiberNode;
  hubLn: FakeLightningNode;
  store: SwapStore;
  http(): HttpClient;
}

/** The real AppModule (every real module and route) on fake nodes, an in-memory database and a fake clock. */
export async function startFiberAccessHub(options: FiberAccessHubOptions = {}): Promise<FiberAccessHub> {
  const config = inboundConfig(options.env);
  const clock = new FakeClock();
  const hubLn = new FakeLightningNetwork(options.lightningNetwork ?? config.bitcoin.network, clock).node("hub");
  const hubFiber = new FakeFiberNetwork(options.fiberNetwork ?? config.ckb.network, clock).node("hub");
  hubFiber.setChannels(options.channels ?? ROUTING_CHANNELS);
  const prices = ["coingecko", "binance", "kucoin"].map((name) => new FakePriceSource(name, clock));
  const app = await startHubApp(config, [
    [CLOCK, clock],
    [LIGHTNING, hubLn],
    [FIBER, hubFiber],
    [PRICE_SOURCES, prices],
  ]);
  return { app, config, clock, hubFiber, hubLn, store: app.get<SwapStore>(SWAP_STORE), http: () => request(app.getHttpServer()) };
}

/** The channels the hub's fake fnn opened to `nodeId` (any state), as the node lists them. */
export const channelsTo = async (node: FakeFiberNode, nodeId: string): Promise<FiberChannel[]> =>
  (await node.listChannelDetails(nodeId)).filter((channel) => !channel.openedByPeer);
