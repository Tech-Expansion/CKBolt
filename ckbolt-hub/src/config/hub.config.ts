import { z } from "zod";
import {
  FIBER_MAX_COMMITMENT_DELAY_EPOCHS,
  FIBER_MIN_COMMITMENT_DELAY_EPOCHS,
  LND_MIN_CHANNEL_FUNDING_SATS,
  LND_MIN_HOLD_EXPIRY_DELTA_BLOCKS,
  MS_PER_MINUTE,
  MS_PER_SECOND,
} from "../common/constants/protocol.constants";
import { CKB_ASSET_ID } from "../common/constants/assets.constants";
import { INBOUND_CHANNEL_MIN_ACCEPT_TIMEOUT_SECONDS, INBOUND_CHANNEL_MIN_FUNDING } from "../common/constants/fiber-node.constants";
import { PROXY_SECRET_MIN_LENGTH } from "../common/constants/http.constants";
import { PERCENT_PER_WHOLE, REQUEST_QUOTE_TTL_MAX_SECONDS, REQUEST_QUOTE_TTL_MIN_SECONDS } from "../common/constants/pricing.constants";
import { TIMING_PROFILES, type TimingProfileName } from "../common/constants/timing.constants";
import { isMultiaddr, isWebSocketMultiaddr } from "../common/utils/multiaddr.util";
import { isLocalBindHost } from "../common/utils/network.util";
import { isLnNodeUri } from "../common/utils/node-id.util";
import { createAssetRegistry, type AssetRegistry } from "../domain/assets";
import { resolveAssetTerms, type AssetTerms } from "../domain/pricing";
import type { TimingProfile } from "../domain/timing/timing.types";
import type { BtcNetwork, CkbNetwork, FiberAsset, FiberAssetId } from "../domain/types";
import {
  fiberAssetsJson,
  fromFiberAssetsEntry,
  jsonText,
  legacyUdtAssetSettings,
  scriptSchema,
  type PeerChannelTerms,
  type UdtAssetSettings,
} from "./fiber-assets.config";

/**
 * Every tunable of the hub, read from the environment once at start-up and validated. Nothing tunable is hard-coded
 * elsewhere: services receive HubConfig (token HUB_CONFIG). See .env.example for the variables.
 */

export interface LndConnection {
  grpcHost: string;
  /** TLS certificate: base64 of the PEM, or a file path. One of them is required. */
  tlsCertBase64?: string;
  tlsCertPath?: string;
  /** Macaroon: hex, or a file path. One of them is required. */
  macaroonHex?: string;
  macaroonPath?: string;
}

export interface FiberConnection {
  rpcUrl: string;
  /** Biscuit token when the RPC is exposed beyond localhost. */
  authToken?: string;
  /** Use the subscribe_store_changes WebSocket for push hints (needs `pubsub` in fnn rpc.enabled_modules). */
  pubsub: boolean;
  /** How long one JSON-RPC call may take, ms. */
  rpcTimeoutMs: number;
  /** Delay before reopening a closed store-changes WebSocket, ms. */
  pubsubReconnectMs: number;
}

/**
 * Channels the hub's fnn opens to a node connected to it (a browser node), so that node can receive (ln_to_fiber). The
 * hub's funding is the node's inbound liquidity, so the caps keep anyone from tying up the hub's funds.
 */
export interface InboundChannelsConfig {
  enabled: boolean;
  /** What one inbound channel is funded with, per asset, in base units. An asset without an amount is not offered. */
  amounts: Partial<Record<FiberAssetId, bigint>>;
  /**
   * Per UDT with an amount: the auto_accept_amount a browser node puts in its udt_whitelist so it takes the hub's inbound
   * channel without a manual accept (at most the amount; the amount itself unless FIBER_ASSETS sets it). CKB has none:
   * a browser node accepts the hub's CKB channel by hand.
   */
  autoAcceptAmounts: Partial<Record<FiberAssetId, bigint>>;
  /** Most inbound channels one client (the rate limiter's client key) may have opened in a sliding day. */
  maxPerClientPerDay: number;
  /** Most inbound channels opened to one node in a sliding day. */
  maxPerNodePerDay: number;
  /**
   * Most inbound channels opened in a UTC day by every client together, closed ones included, so fresh node ids cannot
   * use up `maxOpen` (or the hub's CKB) in one go. Counted in the hub's database: a restart keeps the count.
   */
  maxPerDay: number;
  /** Most inbound channels (private channels the hub's fnn opened) open or opening at once. */
  maxOpen: number;
  /**
   * Seconds an inbound channel may wait for the node to accept it (a browser node accepts the hub's CKB channel itself,
   * with the amount its visitor chose). Older ones are abandoned when the hub next reads its inbound channels, so a
   * closed tab does not keep the node from asking again, or hold a place under `maxOpen`, for fnn's one-day funding timeout.
   */
  acceptTimeoutSeconds: number;
}

/**
 * Channels other Fiber nodes (a browser node) open to the hub's fnn in a UDT, funded with their own tokens, so they can
 * pay the hub (fiber_to_ln) without first receiving the token in a swap. fnn-hub's udt_whitelist auto-accepts them (it
 * adds no tokens and locks its own CKB reserve), and the hub sizes fiber_to_ln hold invoices in those UDTs for the
 * longest commitment delay an opener may choose, which fnn does not report.
 */
export interface PeerChannelsConfig {
  /** Per UDT that takes them (FIBER_ASSETS peerChannels): what fnn-hub's whitelist auto-accepts from on. */
  terms: Partial<Record<FiberAssetId, PeerChannelTerms>>;
  /**
   * Most channels nodes may have opened to the hub's fnn in those UDTs together (any state but closed: each locks
   * about 180 CKB of the fnn wallet as its reserve) before GET /v1/fiber/node stops offering them. It only stops the
   * offer: fnn 0.9.1 has no count limit, so fnn-hub still auto-accepts any channel funded with minAmount or more.
   */
  maxOpen: number;
}

/**
 * Channels the hub's LND opens to a Lightning wallet connected to it (an LDK wallet such as Alby Hub, which on Mutinynet
 * can pay the hub only over a channel of its own): private, static_remote_key, with `pushSats` on the wallet's side.
 * Funded from the hub's on-chain wallet, so the caps keep anyone from tying up its bitcoin.
 */
export interface LnInboundChannelsConfig {
  enabled: boolean;
  /** Size of one channel, sats; at least LND's smallest channel. */
  capacitySats: bigint;
  /** What of it starts on the wallet's side, sats; below the capacity. */
  pushSats: bigint;
  /** Most channels one client (the rate limiter's client key) may have opened in a sliding day. */
  maxPerClientPerDay: number;
  /** Most channels opened to one wallet in a sliding day. */
  maxPerNodePerDay: number;
  /**
   * Most channels opened in a UTC day by every client together, closed ones included: rotating wallet keys and
   * addresses cannot farm the pushed sats past it. Counted in the hub's database: a restart keeps the count.
   */
  maxPerDay: number;
  /** Most sats pushed to wallets in a UTC day by every channel together (the push is the hub's money given away). */
  pushBudgetSatsPerDay: bigint;
  /** Most inbound channels (the ones the hub opened with its inbound memo) open, opening or closing at once. */
  maxOpen: number;
  /** Confirmed on-chain sats the hub keeps after funding a channel (fees, its own channels, the next opens). */
  onchainReserveSats: bigint;
}

export interface HubConfig {
  server: {
    host: string;
    port: number;
    corsOrigins: string[];
    /**
     * Count clients by the last X-Forwarded-For entry of requests from a loopback or private address (the proxy in front
     * of the hub). Needs `host` to be such an address, or every interface inside a container (checked at start-up).
     */
    trustProxy: boolean;
    /**
     * HUB_PROXY_SECRET: when set, every request must carry it in X-CKBolt-Proxy-Secret (401 otherwise), and a request
     * that does is counted by its X-CKBolt-Client header. null: no secret, every request is served.
     */
    proxySecret: string | null;
    rateLimitPerMinute: number;
    /** Most clients each rate limit tracks at once; past that it forgets the one idle the longest. */
    rateLimitMaxClients: number;
  };
  database: { path: string };
  bitcoin: { network: BtcNetwork };
  /**
   * The CKB network, and the UDTs the hub serves on it, in order (CKB is built in): from FIBER_ASSETS, or from the legacy
   * UDT_RUSD_SCRIPT and UDT_CWBTC_SCRIPT when it is not set. None on mainnet.
   */
  ckb: { network: CkbNetwork; udtAssets: FiberAsset[] };
  timing: TimingProfile;
  lnd: LndConnection;
  fiber: FiberConnection;
  /** What the hub offers other Fiber nodes: where they reach its fnn, and inbound channels. */
  fiberPeers: {
    /**
     * Multiaddrs other Fiber nodes dial the hub's fnn at (GET /v1/fiber/node): native TCP for fnn and Fiber Studio, and
     * WebSocket (`.../ws` or `.../wss`) for browser nodes, which can dial nothing else.
     */
    publicAddresses: { p2p: string[]; ws: string[] };
    inboundChannels: InboundChannelsConfig;
    peerChannels: PeerChannelsConfig;
  };
  /** What the hub offers Lightning wallets: where they reach its LND, and inbound channels. */
  lightningPeers: {
    /** pubkey@host:port URIs wallets add the hub's LND as a peer with (GET /v1/lightning/node); empty: LND's own. */
    publicUris: string[];
    inboundChannels: LnInboundChannelsConfig;
    /**
     * The channel-only LND credential (LND_CHANNELS_MACAROON_PATH, with the host and TLS certificate of `lnd`), kept apart
     * from the swap macaroon, which cannot open channels. null when inbound channels are off.
     */
    lnd: LndConnection | null;
  };
  demo: {
    enabled: boolean;
    lnd: LndConnection | null;
    fiber: FiberConnection | null;
    maxActionsPerHour: number;
    /** Demo-wallet actions per hour of every client together: client keys can be shared or made up. */
    maxTotalActionsPerHour: number;
    /**
     * Lifetime a demo payout invoice gets on top of the quote validity, so it is still payable when the hub pays out at
     * the end of the swap's pay window.
     */
    payoutInvoiceExtraSeconds: number;
  };
  health: {
    /** How long a node gets to answer getInfo before the health check reports it unreachable, ms. */
    timeoutMs: number;
  };
  pricing: {
    sources: string[];
    httpTimeoutMs: number;
    maxPriceAgeMs: number;
    /** How long a fetched market price is reused (concurrent fetches share one round of requests), ms. 0 disables it. */
    priceCacheMs: number;
    /** Hub fee on every swap, basis points; an asset's own feeBps (FIBER_ASSETS) replaces it for that asset. */
    feeBps: number;
    /**
     * Premium for the free option a held swap gives the user, basis points; an asset's own optionPremiumBps replaces it
     * (0 suits a BTC-pegged token such as cWBTC, whose price cannot move against BTC).
     */
    optionPremiumBps: number;
    /** Life of a swap quote (purpose `swap`), and so of an unpaid swap's hold invoice. */
    quoteTtlSeconds: number;
    /**
     * Life of a request quote (purpose `request`, Get paid's Lightning invoice), and so of its unpaid hold invoice:
     * REQUEST_QUOTE_TTL_MIN_SECONDS to REQUEST_QUOTE_TTL_MAX_SECONDS.
     */
    requestQuoteTtlSeconds: number;
    /**
     * Added to feeBps and optionPremiumBps on a request quote, basis points: its payer holds a free option on the price
     * for the whole request TTL, not a swap's. 0 on the test networks; see .env.example for sizing it.
     */
    requestPremiumBps: number;
    /** The Lightning leg's bounds, sats; an asset's own minSats and maxSats replace them for that asset. */
    minSats: bigint;
    maxSats: bigint;
    /** Per UDT, the terms FIBER_ASSETS sets for it (resolveAssetTerms fills the rest from the values above). */
    termsByAsset: Readonly<Partial<Record<FiberAssetId, Partial<AssetTerms>>>>;
    /** 32-byte Ed25519 seed (hex) that signs quotes. Generated per process when absent (quotes then die with the process). */
    signingKeyHex: string | null;
  };
  swaps: {
    pollIntervalMs: number;
    lnPayTimeoutSeconds: number;
    /**
     * Most the hub spends on routing a payout, basis points of the payout. The payee can route the payout through a
     * node of its own and collect this budget, so each must stay below pricing.feeBps and every asset's own feeBps
     * (checked at start-up).
     */
    lnMaxFeeBps: number;
    fiberMaxFeeBps: number;
    /** Most parts (LND max_paths) a Lightning payout may be split into. */
    lnMaxPaymentParts: number;
    /**
     * Whether the hub's hold invoices carry route hints for its private channels (LND `private`), so a payer can reach
     * the hub over a channel that is not announced, e.g. a private channel with the payer's LSP.
     */
    lnInvoiceRouteHints: boolean;
    /** final_expiry_delta the hub puts on its Fiber hold invoices (fiber_to_ln), ms. */
    fiberHoldFinalExpiryDeltaMs: number;
    /**
     * Commitment delay (epochs) the hub assumes for a channel a peer opened to its fnn. The opener chooses it (fnn
     * accepts 1 to 84 epochs) and fnn fails a held TLC 2/3 of it before expiry, but list_channels does not show it, so
     * by default the hub assumes the maximum. Channels the hub's fnn opened use fnn's default of 1 epoch. Must stay the
     * maximum while any UDT takes peer channels (checked at start-up): anyone may open those, with any delay.
     */
    fiberPeerChannelCommitmentDelayEpochs: number;
    /**
     * An unpaid hold invoice expires with its quote, but in whole seconds and by the node's own clock, so the node may
     * cancel or expire it a little before the hub's clock reaches the quote's expiry. A release from this long before
     * that instant on counts as the quote expiring, not as a cancellation behind the hub's back. ms.
     */
    holdInvoiceExpiryToleranceMs: number;
    /**
     * Most times the hub sends a payout again when the paying node has no record of it (a crash right after saving
     * outgoing_in_flight, or a send whose answer was lost). After that it stops sending and refunds once
     * payoutMissingConfirmMs has passed.
     */
    payoutMaxResends: number;
    /**
     * How long after its last send a payout must still be unknown to the paying node before the hub trusts that nothing
     * of it is in flight and may refund (a send whose call timed out can still be starting inside the node). At least
     * the Fiber RPC timeout (checked at start-up). ms.
     */
    payoutMissingConfirmMs: number;
    /**
     * Most swaps one client (the rate limiter's client key) may have waiting for their payment. Each reserves its payout
     * and leaves a hold invoice on the hub's nodes until its quote expires, and costs nothing to create.
     */
    maxUnpaidSwapsPerClient: number;
    /** Most swaps waiting for their payment from every client together. */
    maxUnpaidSwaps: number;
    /**
     * Most of a direction's payout liquidity (its payout balance less what paid swaps still need) that swaps waiting
     * for their payment may reserve together, percent: unpaid swaps cost nothing, so a few clients could otherwise
     * lock a whole direction. A swap past it answers 503 insufficient_liquidity.
     */
    maxUnpaidSharePercent: number;
    /**
     * Most swaps on request quotes one client may have waiting for their payment (open payment requests). They count
     * here instead of in maxUnpaidSwapsPerClient, so a merchant's open requests do not stop its swaps; they count in
     * maxUnpaidSwaps and maxUnpaidSharePercent like any unpaid swap.
     */
    maxOpenRequestsPerClient: number;
    /** SWAPS_PAUSED: new quotes and swaps answer 503 maintenance; the swaps already running go on to their end. */
    paused: boolean;
  };
}

const bool = z
  .enum(["true", "false", "1", "0", "yes", "no"])
  .transform((v) => v === "true" || v === "1" || v === "yes");
const list = z.string().transform((v) => v.split(",").map((s) => s.trim()).filter(Boolean));
/** A comma-separated list whose every entry must pass `isValid`. */
const checkedList = (isValid: (entry: string) => boolean, message: string) => list.pipe(z.array(z.string().refine(isValid, message)));
/** An amount of base units: a positive whole number. */
const baseUnits = z.coerce.bigint().positive();
/** A variable left empty (`NAME=`) counts as not set. */
const unsetWhenBlank = (value: unknown): unknown => (typeof value === "string" && value.trim() === "" ? undefined : value);
/** An optional amount of base units; empty counts as not set. */
const optionalBaseUnits = z.preprocess(unsetWhenBlank, baseUnits.optional());
const scriptJson = jsonText.pipe(scriptSchema);

const envSchema = z.object({
  HUB_HOST: z.string().default("127.0.0.1"),
  HUB_PORT: z.coerce.number().int().positive().default(8787),
  HUB_CORS_ORIGINS: list.default(""),
  HUB_TRUST_PROXY: bool.default("false"),
  HUB_PROXY_SECRET: z.preprocess(
    unsetWhenBlank,
    z.string().min(PROXY_SECRET_MIN_LENGTH, `must be at least ${PROXY_SECRET_MIN_LENGTH} characters`).optional(),
  ),
  HUB_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(120),
  HUB_RATE_LIMIT_MAX_CLIENTS: z.coerce.number().int().positive().default(10_000),
  HUB_DB_PATH: z.string().default("./data/hub.sqlite"),

  BTC_NETWORK: z.enum(["regtest", "signet", "testnet", "testnet4", "mainnet"]).default("regtest"),
  TIMING_PROFILE: z.enum(Object.keys(TIMING_PROFILES) as [TimingProfileName, ...TimingProfileName[]]).default("regtest"),
  CKB_NETWORK: z.enum(["devnet", "testnet", "mainnet"]).default("devnet"),
  /** The UDTs the hub serves (src/config/fiber-assets.config.ts); replaces the three legacy variables below. */
  FIBER_ASSETS: z.preprocess(unsetWhenBlank, fiberAssetsJson.optional()),
  UDT_RUSD_SCRIPT: scriptJson.optional(),
  UDT_CWBTC_SCRIPT: scriptJson.optional(),

  LN_MARGIN_BLOCKS: z.coerce.number().int().nonnegative().optional(),
  LN_ROUTE_BUDGET_BLOCKS: z.coerce.number().int().nonnegative().optional(),
  PAYER_MAX_CLTV: z.coerce.number().int().positive().optional(),
  PAYER_ROUTE_BUDGET_BLOCKS: z.coerce.number().int().nonnegative().optional(),
  FIBER_MARGIN_MINUTES: z.coerce.number().nonnegative().optional(),
  FIBER_MAX_HOPS: z.coerce.number().int().nonnegative().optional(),
  MAX_PAYOUT_LOCK_MINUTES: z.coerce.number().int().positive().optional(),

  LND_HOLD_EXPIRY_DELTA_BLOCKS: z.coerce.number().int().min(LND_MIN_HOLD_EXPIRY_DELTA_BLOCKS).optional(),
  LND_GRPC_HOST: z.string().default("127.0.0.1:10009"),
  LND_TLS_CERT_BASE64: z.string().optional(),
  LND_TLS_CERT_PATH: z.string().optional(),
  LND_MACAROON_HEX: z.string().optional(),
  LND_MACAROON_PATH: z.string().optional(),
  LND_CHANNELS_MACAROON_PATH: z.preprocess(unsetWhenBlank, z.string().optional()),

  FIBER_RPC_URL: z.string().url().default("http://127.0.0.1:8227"),
  FIBER_RPC_TOKEN: z.string().optional(),
  FIBER_PUBSUB: bool.default("false"),
  FIBER_RPC_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  FIBER_PUBSUB_RECONNECT_MS: z.coerce.number().int().positive().default(5_000),

  FIBER_PUBLIC_P2P_ADDRS: checkedList(isMultiaddr, "must be a multiaddr such as /ip4/203.0.113.7/tcp/8228").default(""),
  FIBER_PUBLIC_WS_ADDRS: checkedList(isWebSocketMultiaddr, "must be a WebSocket multiaddr such as /ip4/203.0.113.7/tcp/8228/ws").default(""),
  FIBER_INBOUND_ENABLED: bool.default("false"),
  FIBER_INBOUND_CKB_AMOUNT: optionalBaseUnits,
  FIBER_INBOUND_RUSD_AMOUNT: optionalBaseUnits,
  FIBER_INBOUND_MAX_PER_CLIENT_PER_DAY: z.coerce.number().int().positive().default(2),
  FIBER_INBOUND_MAX_PER_NODE_PER_DAY: z.coerce.number().int().positive().default(2),
  FIBER_INBOUND_MAX_PER_DAY: z.coerce.number().int().positive().default(10),
  FIBER_INBOUND_MAX_OPEN: z.coerce.number().int().positive().default(20),
  FIBER_INBOUND_ACCEPT_TIMEOUT_SECONDS: z.coerce.number().int().min(INBOUND_CHANNEL_MIN_ACCEPT_TIMEOUT_SECONDS).default(600),
  FIBER_PEER_CHANNELS_MAX_OPEN: z.coerce.number().int().nonnegative().default(10),

  LN_PUBLIC_URIS: checkedList(isLnNodeUri, "must be a Lightning node URI such as 02...@203.0.113.7:9735").default(""),
  LN_INBOUND_ENABLED: bool.default("false"),
  LN_INBOUND_CAPACITY_SATS: z.coerce
    .bigint()
    .min(LND_MIN_CHANNEL_FUNDING_SATS, `must be at least ${LND_MIN_CHANNEL_FUNDING_SATS} sats, the smallest channel LND opens`)
    .default(30_000n),
  LN_INBOUND_PUSH_SATS: z.coerce.bigint().nonnegative().default(20_000n),
  LN_INBOUND_MAX_PER_CLIENT_PER_DAY: z.coerce.number().int().positive().default(1),
  LN_INBOUND_MAX_PER_NODE_PER_DAY: z.coerce.number().int().positive().default(1),
  LN_INBOUND_MAX_PER_DAY: z.coerce.number().int().positive().default(10),
  LN_INBOUND_PUSH_BUDGET_SATS_PER_DAY: z.coerce.bigint().nonnegative().default(200_000n),
  LN_INBOUND_MAX_OPEN: z.coerce.number().int().positive().default(20),
  LN_INBOUND_ONCHAIN_RESERVE_SATS: z.coerce.bigint().nonnegative().default(20_000n),

  HEALTH_CHECK_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),

  DEMO_ENABLED: bool.default("false"),
  DEMO_MAX_ACTIONS_PER_HOUR: z.coerce.number().int().positive().default(60),
  DEMO_MAX_ACTIONS_PER_HOUR_TOTAL: z.coerce.number().int().positive().default(600),
  DEMO_PAYOUT_INVOICE_EXTRA_SECONDS: z.coerce.number().int().nonnegative().default(3_600),
  DEMO_LND_GRPC_HOST: z.string().optional(),
  DEMO_LND_TLS_CERT_BASE64: z.string().optional(),
  DEMO_LND_TLS_CERT_PATH: z.string().optional(),
  DEMO_LND_MACAROON_HEX: z.string().optional(),
  DEMO_LND_MACAROON_PATH: z.string().optional(),
  DEMO_FIBER_RPC_URL: z.string().url().optional(),
  DEMO_FIBER_RPC_TOKEN: z.string().optional(),

  PRICE_SOURCES: list.default("coingecko,binance,kucoin"),
  PRICE_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  PRICE_MAX_AGE_SECONDS: z.coerce.number().int().positive().default(600),
  PRICE_CACHE_MS: z.coerce.number().int().nonnegative().default(15_000),
  FEE_BPS: z.coerce.number().int().nonnegative().default(50),
  OPTION_PREMIUM_BPS: z.coerce.number().int().nonnegative().default(50),
  QUOTE_TTL_SECONDS: z.coerce.number().int().positive().default(180),
  REQUEST_QUOTE_TTL_SECONDS: z.coerce.number().int().min(REQUEST_QUOTE_TTL_MIN_SECONDS).max(REQUEST_QUOTE_TTL_MAX_SECONDS).default(900),
  REQUEST_PREMIUM_BPS: z.coerce.number().int().nonnegative().default(0),
  SWAP_MIN_SATS: z.coerce.bigint().nonnegative().default(1_000n),
  SWAP_MAX_SATS: z.coerce.bigint().positive().default(100_000n),
  QUOTE_SIGNING_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),

  SWAP_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2_000),
  LN_PAY_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(60),
  LN_MAX_FEE_BPS: z.coerce.number().int().nonnegative().default(25),
  FIBER_MAX_FEE_BPS: z.coerce.number().int().nonnegative().default(25),
  LN_MAX_PAYMENT_PARTS: z.coerce.number().int().positive().default(16),
  LN_INVOICE_ROUTE_HINTS: bool.default("false"),
  FIBER_HOLD_FINAL_EXPIRY_DELTA_MINUTES: z.coerce.number().positive().default(6 * 60),
  HOLD_INVOICE_EXPIRY_TOLERANCE_SECONDS: z.coerce.number().int().nonnegative().default(5),
  PAYOUT_MAX_RESENDS: z.coerce.number().int().nonnegative().default(3),
  PAYOUT_MISSING_CONFIRM_SECONDS: z.coerce.number().int().positive().default(30),
  SWAP_MAX_UNPAID_PER_CLIENT: z.coerce.number().int().positive().default(5),
  SWAP_MAX_UNPAID: z.coerce.number().int().positive().default(50),
  SWAP_MAX_UNPAID_SHARE_PERCENT: z.coerce.number().int().min(1).max(PERCENT_PER_WHOLE).default(50),
  REQUEST_MAX_OPEN_PER_CLIENT: z.coerce.number().int().positive().default(3),
  SWAPS_PAUSED: bool.default("false"),
  FIBER_PEER_CHANNEL_COMMITMENT_DELAY_EPOCHS: z.coerce
    .number()
    .int()
    .min(FIBER_MIN_COMMITMENT_DELAY_EPOCHS)
    .max(FIBER_MAX_COMMITMENT_DELAY_EPOCHS)
    .default(FIBER_MAX_COMMITMENT_DELAY_EPOCHS),
});

export type HubEnv = z.infer<typeof envSchema>;

const lndConnection = (host: string, cert64?: string, certPath?: string, macHex?: string, macPath?: string): LndConnection => ({
  grpcHost: host,
  tlsCertBase64: cert64,
  tlsCertPath: certPath,
  macaroonHex: macHex,
  macaroonPath: macPath,
});

/** A Fiber node's connection; every node shares the client timings from the environment. */
const fiberConnection = (e: HubEnv, rpcUrl: string, authToken: string | undefined, pubsub: boolean): FiberConnection => ({
  rpcUrl,
  authToken,
  pubsub,
  rpcTimeoutMs: e.FIBER_RPC_TIMEOUT_MS,
  pubsubReconnectMs: e.FIBER_PUBSUB_RECONNECT_MS,
});

/**
 * A payout the paying node has no record of is refunded only once a send whose call timed out can no longer be starting
 * inside the node, so the wait must outlast the slowest node call (the Fiber RPC timeout; LND sets no deadline of its own).
 */
function assertPayoutConfirmOutlastsRpcTimeout(e: HubEnv): void {
  if (e.PAYOUT_MISSING_CONFIRM_SECONDS * MS_PER_SECOND >= e.FIBER_RPC_TIMEOUT_MS) return;
  const confirm = `PAYOUT_MISSING_CONFIRM_SECONDS (${e.PAYOUT_MISSING_CONFIRM_SECONDS})`;
  throw new Error(`Invalid hub configuration: ${confirm} must be at least FIBER_RPC_TIMEOUT_MS (${e.FIBER_RPC_TIMEOUT_MS} ms)`);
}

/**
 * HUB_TRUST_PROXY lets the last X-Forwarded-For entry name the client, so only the proxy may reach the hub: HUB_HOST
 * must be loopback or private, or every interface (a container reached through its published port).
 */
function assertTrustedProxyHost(e: HubEnv): void {
  if (!e.HUB_TRUST_PROXY || isLocalBindHost(e.HUB_HOST)) return;
  throw new Error(
    `Invalid hub configuration: HUB_TRUST_PROXY=true needs HUB_HOST (${e.HUB_HOST}) to be a loopback or private address, ` +
      "so that only the proxy in front of the hub can reach it",
  );
}

/** The legacy asset variables FIBER_ASSETS replaces. */
const LEGACY_ASSET_VARIABLES = ["UDT_RUSD_SCRIPT", "UDT_CWBTC_SCRIPT", "FIBER_INBOUND_RUSD_AMOUNT"] as const satisfies readonly (keyof HubEnv)[];

/** FIBER_ASSETS lists every UDT itself, so a legacy variable next to it would be ignored: refuse rather than guess. */
function assertNoLegacyAssetVariables(e: HubEnv): void {
  if (e.FIBER_ASSETS === undefined) return;
  const set = LEGACY_ASSET_VARIABLES.filter((name) => e[name] !== undefined);
  if (set.length === 0) return;
  throw new Error(
    `Invalid hub configuration: FIBER_ASSETS replaces ${set.join(", ")}: remove ${set.length === 1 ? "it" : "them"} and put ` +
      "the asset's type script and inboundAmount in its FIBER_ASSETS entry",
  );
}

/** Mainnet is out of scope for stage 3: the hub serves no UDT there. */
function assertNoUdtOnMainnet(e: HubEnv): void {
  if (e.CKB_NETWORK !== "mainnet" || !e.FIBER_ASSETS?.length) return;
  throw new Error("Invalid hub configuration: FIBER_ASSETS lists UDTs, but the hub serves no UDT on mainnet yet: leave it empty or unset");
}

/** The UDTs the hub serves with their settings: FIBER_ASSETS, or the legacy variables when it is not set. */
const udtAssetSettings = (e: HubEnv): UdtAssetSettings[] =>
  e.FIBER_ASSETS !== undefined
    ? e.FIBER_ASSETS.map(fromFiberAssetsEntry)
    : legacyUdtAssetSettings({
        network: e.CKB_NETWORK,
        udtScripts: { RUSD: e.UDT_RUSD_SCRIPT, CWBTC: e.UDT_CWBTC_SCRIPT },
        inboundAmounts: e.FIBER_INBOUND_RUSD_AMOUNT === undefined ? {} : { RUSD: e.FIBER_INBOUND_RUSD_AMOUNT },
      });

/** The global terms: FEE_BPS, OPTION_PREMIUM_BPS, SWAP_MIN_SATS, SWAP_MAX_SATS. */
const globalTerms = (e: HubEnv): AssetTerms => ({
  feeBps: e.FEE_BPS,
  optionPremiumBps: e.OPTION_PREMIUM_BPS,
  minSats: e.SWAP_MIN_SATS,
  maxSats: e.SWAP_MAX_SATS,
});

/**
 * The payee of a payout can route it through a node of its own and collect the whole routing fee budget, so each
 * budget must leave part of the hub fee (the option premium is kept for the free option the swap gives). `feeName`
 * names where the fee comes from.
 */
function assertPayoutFeeBudgetsBelow(e: HubEnv, feeBps: number, feeName: string): void {
  const budgets = { LN_MAX_FEE_BPS: e.LN_MAX_FEE_BPS, FIBER_MAX_FEE_BPS: e.FIBER_MAX_FEE_BPS };
  for (const [name, bps] of Object.entries(budgets)) {
    if (bps >= feeBps) throw new Error(`Invalid hub configuration: ${name} (${bps}) must be below ${feeName} (${feeBps})`);
  }
}

/** Each UDT's own terms keep the rules of the global ones: a fee above the routing budgets, minSats not above maxSats. */
function assertUdtTermsValid(e: HubEnv, udts: readonly UdtAssetSettings[]): void {
  for (const { asset, terms } of udts) {
    if (terms.feeBps !== undefined) assertPayoutFeeBudgetsBelow(e, terms.feeBps, `the feeBps of ${asset.id} in FIBER_ASSETS`);
    const { minSats, maxSats } = resolveAssetTerms(globalTerms(e), terms);
    if (minSats <= maxSats) continue;
    throw new Error(
      `Invalid hub configuration: ${asset.id} would swap from ${minSats} to ${maxSats} sats: its minSats must not be above its ` +
        "maxSats (FIBER_ASSETS, or SWAP_MIN_SATS and SWAP_MAX_SATS for what the entry leaves out)",
    );
  }
}

/** The inbound channel amounts by asset: CKB's from FIBER_INBOUND_CKB_AMOUNT, each UDT's from its settings. */
const inboundAmounts = (e: HubEnv, udts: readonly UdtAssetSettings[]): Partial<Record<FiberAssetId, bigint>> => ({
  ...(e.FIBER_INBOUND_CKB_AMOUNT === undefined ? {} : { [CKB_ASSET_ID]: e.FIBER_INBOUND_CKB_AMOUNT }),
  ...Object.fromEntries(udts.flatMap(({ asset, inboundAmount }) => (inboundAmount === undefined ? [] : [[asset.id, inboundAmount]]))),
});

/** The auto-accept amounts by UDT, for the UDTs with an inbound amount. */
const autoAcceptAmounts = (udts: readonly UdtAssetSettings[]): Partial<Record<FiberAssetId, bigint>> =>
  Object.fromEntries(udts.flatMap(({ asset, autoAcceptAmount }) => (autoAcceptAmount === undefined ? [] : [[asset.id, autoAcceptAmount]])));

/** The variable that sets the inbound channel amount of an asset with a minimum (INBOUND_CHANNEL_MIN_FUNDING). */
const INBOUND_AMOUNT_VARIABLE: Readonly<Record<string, keyof HubEnv>> = { [CKB_ASSET_ID]: "FIBER_INBOUND_CKB_AMOUNT" };

/**
 * A legacy FIBER_INBOUND_RUSD_AMOUNT for RUSD the hub does not serve on its network would be offered nowhere (the legacy
 * settings give the amount to RUSD only when it is served, so then no UDT has an amount).
 */
function assertLegacyInboundAssetServed(e: HubEnv, udts: readonly UdtAssetSettings[]): void {
  if (e.FIBER_INBOUND_RUSD_AMOUNT === undefined || udts.some(({ inboundAmount }) => inboundAmount !== undefined)) return;
  throw new Error(
    `Invalid hub configuration: FIBER_INBOUND_RUSD_AMOUNT is set, but the hub does not serve RUSD on ${e.CKB_NETWORK}: ` +
      "remove the amount, or configure the asset",
  );
}

/**
 * A node with fnn's defaults accepts a smaller CKB channel only by hand, so the hub's channel would stay opening. A UDT's
 * amount is at least its auto-accept amount already (FIBER_ASSETS checks it).
 */
function assertInboundAmountsAccepted(amounts: Partial<Record<FiberAssetId, bigint>>): void {
  for (const [asset, minimum] of Object.entries(INBOUND_CHANNEL_MIN_FUNDING)) {
    const amount = amounts[asset];
    if (amount === undefined || minimum === undefined || amount >= minimum) continue;
    throw new Error(
      `Invalid hub configuration: ${INBOUND_AMOUNT_VARIABLE[asset] ?? asset} (${amount}) must be at least ${minimum}: below that, ` +
        "a node on fnn's default settings (a browser node, Fiber Studio) does not accept the channel on its own",
    );
  }
}

/**
 * Inbound channels need something to offer (an amount for at least one asset, each served and large enough for a node
 * to accept) and a way in: the hub's fnn can open a channel only to a node already connected to it, which needs a
 * public address to dial.
 */
function assertInboundChannelsUsable(e: HubEnv, udts: readonly UdtAssetSettings[]): void {
  if (!e.FIBER_INBOUND_ENABLED) return;
  assertLegacyInboundAssetServed(e, udts);
  const amounts = inboundAmounts(e, udts);
  if (Object.keys(amounts).length === 0) {
    throw new Error(
      "Invalid hub configuration: FIBER_INBOUND_ENABLED needs FIBER_INBOUND_CKB_AMOUNT or a UDT's inboundAmount in FIBER_ASSETS " +
        "(FIBER_INBOUND_RUSD_AMOUNT without FIBER_ASSETS)",
    );
  }
  assertInboundAmountsAccepted(amounts);
  if (e.FIBER_PUBLIC_WS_ADDRS.length + e.FIBER_PUBLIC_P2P_ADDRS.length === 0) {
    throw new Error(
      "Invalid hub configuration: FIBER_INBOUND_ENABLED needs FIBER_PUBLIC_WS_ADDRS or FIBER_PUBLIC_P2P_ADDRS, " +
        "so that a node can connect to the hub's Fiber node before asking for a channel",
    );
  }
}

/** The channel terms by UDT, for the UDTs nodes may open channels to the hub in. */
const peerChannelTerms = (udts: readonly UdtAssetSettings[]): Partial<Record<FiberAssetId, PeerChannelTerms>> =>
  Object.fromEntries(udts.flatMap(({ asset, peerChannels }) => (peerChannels === undefined ? [] : [[asset.id, peerChannels]])));

/**
 * fnn-hub auto-accepts a peer channel whatever commitment delay its opener chose (1 to 84 epochs) and does not report it,
 * while it fails a held TLC 2/3 of that delay before expiry. With peer channels on, anyone can open one with the longest
 * delay, so the hub must count the longest: a shorter assumption would let a payer make fnn fail its held payment while
 * the hub's Lightning payout is still out, then collect the payout.
 */
function assertPeerChannelDelayUnverified(e: HubEnv, udts: readonly UdtAssetSettings[]): void {
  const taking = udts.filter(({ peerChannels }) => peerChannels !== undefined).map(({ asset }) => asset.id);
  if (taking.length === 0 || e.FIBER_PEER_CHANNEL_COMMITMENT_DELAY_EPOCHS === FIBER_MAX_COMMITMENT_DELAY_EPOCHS) return;
  throw new Error(
    `Invalid hub configuration: FIBER_PEER_CHANNEL_COMMITMENT_DELAY_EPOCHS (${e.FIBER_PEER_CHANNEL_COMMITMENT_DELAY_EPOCHS}) must stay ` +
      `${FIBER_MAX_COMMITMENT_DELAY_EPOCHS} while FIBER_ASSETS lets nodes open channels to the hub (peerChannels in ` +
      `${taking.join(", ")}): fnn accepts any commitment delay up to ${FIBER_MAX_COMMITMENT_DELAY_EPOCHS} epochs on such a ` +
      "channel and does not report it",
  );
}

/** The pushed part starts on the wallet's side, so the hub must keep some of the channel: LND refuses a push of it all. */
function assertLnPushBelowCapacity(e: HubEnv): void {
  if (e.LN_INBOUND_PUSH_SATS < e.LN_INBOUND_CAPACITY_SATS) return;
  throw new Error(
    `Invalid hub configuration: LN_INBOUND_PUSH_SATS (${e.LN_INBOUND_PUSH_SATS}) must be below LN_INBOUND_CAPACITY_SATS (${e.LN_INBOUND_CAPACITY_SATS})`,
  );
}

/**
 * The push is the hub's money given to the wallet: never more than one swap may move (SWAP_MAX_SATS), and never more
 * than the daily push budget, or no channel could ever open. Checked only with inbound Lightning channels on.
 */
function assertLnPushWithinLimits(e: HubEnv): void {
  if (!e.LN_INBOUND_ENABLED) return;
  const push = `LN_INBOUND_PUSH_SATS (${e.LN_INBOUND_PUSH_SATS})`;
  if (e.LN_INBOUND_PUSH_SATS > e.SWAP_MAX_SATS) {
    throw new Error(`Invalid hub configuration: ${push} must be at most SWAP_MAX_SATS (${e.SWAP_MAX_SATS})`);
  }
  if (e.LN_INBOUND_PUSH_SATS > e.LN_INBOUND_PUSH_BUDGET_SATS_PER_DAY) {
    throw new Error(
      `Invalid hub configuration: ${push} must be at most LN_INBOUND_PUSH_BUDGET_SATS_PER_DAY (${e.LN_INBOUND_PUSH_BUDGET_SATS_PER_DAY})`,
    );
  }
}

/** Opening channels needs the channel-only macaroon: the swap macaroon cannot, and must not, open them. */
function assertLnInboundCredential(e: HubEnv): void {
  if (!e.LN_INBOUND_ENABLED || e.LND_CHANNELS_MACAROON_PATH !== undefined) return;
  throw new Error(
    "Invalid hub configuration: LN_INBOUND_ENABLED needs LND_CHANNELS_MACAROON_PATH, the macaroon baked for opening " +
      "channels only (deploy/README.md, `testnet macaroons`)",
  );
}

/** The channel-only LND connection: the hub LND's host and TLS certificate with the channel macaroon. */
const lndChannelsConnection = (e: HubEnv): LndConnection | null =>
  e.LN_INBOUND_ENABLED && e.LND_CHANNELS_MACAROON_PATH !== undefined
    ? lndConnection(e.LND_GRPC_HOST, e.LND_TLS_CERT_BASE64, e.LND_TLS_CERT_PATH, undefined, e.LND_CHANNELS_MACAROON_PATH)
    : null;

/** Parses and validates the environment. Throws a readable error listing every bad variable. */
export function loadHubConfig(env: NodeJS.ProcessEnv = process.env): HubConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid hub configuration: ${issues}`);
  }
  const e = parsed.data;
  if (e.SWAP_MIN_SATS > e.SWAP_MAX_SATS) throw new Error("Invalid hub configuration: SWAP_MIN_SATS is above SWAP_MAX_SATS");
  assertPayoutFeeBudgetsBelow(e, e.FEE_BPS, "FEE_BPS");
  assertPayoutConfirmOutlastsRpcTimeout(e);
  assertTrustedProxyHost(e);
  assertNoLegacyAssetVariables(e);
  assertNoUdtOnMainnet(e);
  const udts = udtAssetSettings(e);
  assertUdtTermsValid(e, udts);
  assertInboundChannelsUsable(e, udts);
  assertPeerChannelDelayUnverified(e, udts);
  assertLnPushBelowCapacity(e);
  assertLnPushWithinLimits(e);
  assertLnInboundCredential(e);

  const base = TIMING_PROFILES[e.TIMING_PROFILE];
  const timing: TimingProfile = {
    ...base,
    lndHoldExpiryDeltaBlocks: e.LND_HOLD_EXPIRY_DELTA_BLOCKS ?? base.lndHoldExpiryDeltaBlocks,
    lnMarginBlocks: e.LN_MARGIN_BLOCKS ?? base.lnMarginBlocks,
    lnRouteBudgetBlocks: e.LN_ROUTE_BUDGET_BLOCKS ?? base.lnRouteBudgetBlocks,
    payerMaxCltv: e.PAYER_MAX_CLTV ?? base.payerMaxCltv,
    payerRouteBudgetBlocks: e.PAYER_ROUTE_BUDGET_BLOCKS ?? base.payerRouteBudgetBlocks,
    fiberMarginMs: e.FIBER_MARGIN_MINUTES !== undefined ? e.FIBER_MARGIN_MINUTES * MS_PER_MINUTE : base.fiberMarginMs,
    maxFiberHops: e.FIBER_MAX_HOPS ?? base.maxFiberHops,
    maxPayoutLockMs: e.MAX_PAYOUT_LOCK_MINUTES !== undefined ? e.MAX_PAYOUT_LOCK_MINUTES * MS_PER_MINUTE : base.maxPayoutLockMs,
  };

  const demoLnd = e.DEMO_LND_GRPC_HOST
    ? lndConnection(e.DEMO_LND_GRPC_HOST, e.DEMO_LND_TLS_CERT_BASE64, e.DEMO_LND_TLS_CERT_PATH, e.DEMO_LND_MACAROON_HEX, e.DEMO_LND_MACAROON_PATH)
    : null;
  const demoFiber = e.DEMO_FIBER_RPC_URL ? fiberConnection(e, e.DEMO_FIBER_RPC_URL, e.DEMO_FIBER_RPC_TOKEN, false) : null;
  if (e.DEMO_ENABLED && (!demoLnd || !demoFiber)) {
    throw new Error("Invalid hub configuration: DEMO_ENABLED needs DEMO_LND_* and DEMO_FIBER_RPC_URL");
  }

  return {
    server: {
      host: e.HUB_HOST,
      port: e.HUB_PORT,
      corsOrigins: e.HUB_CORS_ORIGINS,
      trustProxy: e.HUB_TRUST_PROXY,
      proxySecret: e.HUB_PROXY_SECRET ?? null,
      rateLimitPerMinute: e.HUB_RATE_LIMIT_PER_MINUTE,
      rateLimitMaxClients: e.HUB_RATE_LIMIT_MAX_CLIENTS,
    },
    database: { path: e.HUB_DB_PATH },
    bitcoin: { network: e.BTC_NETWORK },
    ckb: { network: e.CKB_NETWORK, udtAssets: udts.map(({ asset }) => asset) },
    timing,
    lnd: lndConnection(e.LND_GRPC_HOST, e.LND_TLS_CERT_BASE64, e.LND_TLS_CERT_PATH, e.LND_MACAROON_HEX, e.LND_MACAROON_PATH),
    fiber: fiberConnection(e, e.FIBER_RPC_URL, e.FIBER_RPC_TOKEN, e.FIBER_PUBSUB),
    fiberPeers: {
      publicAddresses: { p2p: e.FIBER_PUBLIC_P2P_ADDRS, ws: e.FIBER_PUBLIC_WS_ADDRS },
      inboundChannels: {
        enabled: e.FIBER_INBOUND_ENABLED,
        amounts: inboundAmounts(e, udts),
        autoAcceptAmounts: autoAcceptAmounts(udts),
        maxPerClientPerDay: e.FIBER_INBOUND_MAX_PER_CLIENT_PER_DAY,
        maxPerNodePerDay: e.FIBER_INBOUND_MAX_PER_NODE_PER_DAY,
        maxPerDay: e.FIBER_INBOUND_MAX_PER_DAY,
        maxOpen: e.FIBER_INBOUND_MAX_OPEN,
        acceptTimeoutSeconds: e.FIBER_INBOUND_ACCEPT_TIMEOUT_SECONDS,
      },
      peerChannels: { terms: peerChannelTerms(udts), maxOpen: e.FIBER_PEER_CHANNELS_MAX_OPEN },
    },
    lightningPeers: {
      publicUris: e.LN_PUBLIC_URIS,
      inboundChannels: {
        enabled: e.LN_INBOUND_ENABLED,
        capacitySats: e.LN_INBOUND_CAPACITY_SATS,
        pushSats: e.LN_INBOUND_PUSH_SATS,
        maxPerClientPerDay: e.LN_INBOUND_MAX_PER_CLIENT_PER_DAY,
        maxPerNodePerDay: e.LN_INBOUND_MAX_PER_NODE_PER_DAY,
        maxPerDay: e.LN_INBOUND_MAX_PER_DAY,
        pushBudgetSatsPerDay: e.LN_INBOUND_PUSH_BUDGET_SATS_PER_DAY,
        maxOpen: e.LN_INBOUND_MAX_OPEN,
        onchainReserveSats: e.LN_INBOUND_ONCHAIN_RESERVE_SATS,
      },
      lnd: lndChannelsConnection(e),
    },
    demo: {
      enabled: e.DEMO_ENABLED,
      lnd: demoLnd,
      fiber: demoFiber,
      maxActionsPerHour: e.DEMO_MAX_ACTIONS_PER_HOUR,
      maxTotalActionsPerHour: e.DEMO_MAX_ACTIONS_PER_HOUR_TOTAL,
      payoutInvoiceExtraSeconds: e.DEMO_PAYOUT_INVOICE_EXTRA_SECONDS,
    },
    health: { timeoutMs: e.HEALTH_CHECK_TIMEOUT_MS },
    pricing: {
      sources: e.PRICE_SOURCES,
      httpTimeoutMs: e.PRICE_HTTP_TIMEOUT_MS,
      maxPriceAgeMs: e.PRICE_MAX_AGE_SECONDS * MS_PER_SECOND,
      priceCacheMs: e.PRICE_CACHE_MS,
      feeBps: e.FEE_BPS,
      optionPremiumBps: e.OPTION_PREMIUM_BPS,
      quoteTtlSeconds: e.QUOTE_TTL_SECONDS,
      requestQuoteTtlSeconds: e.REQUEST_QUOTE_TTL_SECONDS,
      requestPremiumBps: e.REQUEST_PREMIUM_BPS,
      minSats: e.SWAP_MIN_SATS,
      maxSats: e.SWAP_MAX_SATS,
      termsByAsset: Object.fromEntries(udts.flatMap(({ asset, terms }) => (Object.keys(terms).length === 0 ? [] : [[asset.id, terms]]))),
      signingKeyHex: e.QUOTE_SIGNING_KEY ?? null,
    },
    swaps: {
      pollIntervalMs: e.SWAP_POLL_INTERVAL_MS,
      lnPayTimeoutSeconds: e.LN_PAY_TIMEOUT_SECONDS,
      lnMaxFeeBps: e.LN_MAX_FEE_BPS,
      fiberMaxFeeBps: e.FIBER_MAX_FEE_BPS,
      lnMaxPaymentParts: e.LN_MAX_PAYMENT_PARTS,
      lnInvoiceRouteHints: e.LN_INVOICE_ROUTE_HINTS,
      fiberHoldFinalExpiryDeltaMs: e.FIBER_HOLD_FINAL_EXPIRY_DELTA_MINUTES * MS_PER_MINUTE,
      holdInvoiceExpiryToleranceMs: e.HOLD_INVOICE_EXPIRY_TOLERANCE_SECONDS * MS_PER_SECOND,
      fiberPeerChannelCommitmentDelayEpochs: e.FIBER_PEER_CHANNEL_COMMITMENT_DELAY_EPOCHS,
      payoutMaxResends: e.PAYOUT_MAX_RESENDS,
      payoutMissingConfirmMs: e.PAYOUT_MISSING_CONFIRM_SECONDS * MS_PER_SECOND,
      maxUnpaidSwapsPerClient: e.SWAP_MAX_UNPAID_PER_CLIENT,
      maxUnpaidSwaps: e.SWAP_MAX_UNPAID,
      maxUnpaidSharePercent: e.SWAP_MAX_UNPAID_SHARE_PERCENT,
      maxOpenRequestsPerClient: e.REQUEST_MAX_OPEN_PER_CLIENT,
      paused: e.SWAPS_PAUSED,
    },
  };
}

/** The registry of the assets this config serves: CKB and its UDTs (ASSETS in HubConfigModule). */
export const assetRegistryOf = (config: HubConfig): AssetRegistry => createAssetRegistry(config.ckb.network, config.ckb.udtAssets);
