/**
 * The CKBolt hub's HTTP contract (REST API v1), copied for the web app.
 *
 * Source of truth, in the sibling repo `../ckbolt-hub`:
 * - `src/interfaces/http/contract/responses.ts`: response DTOs (`ErrorBody`, `ListBody`, `LegDto`, `AssetDto`, ...)
 * - `src/interfaces/http/contract/requests.ts`: request bodies (zod schemas there; plain types here)
 * - `src/common/constants/api.constants.ts`: `API_VERSION`, `API_ROUTES`, `API_ERROR_CODE`
 * - `src/common/constants/swap.constants.ts`: `TERMINAL_SWAP_STATES`, `SWAP_EVENT`, `QUOTE_PURPOSE`
 * - `src/common/constants/http.constants.ts`: the cancel token's header (`HTTP_HEADER.CANCEL_TOKEN`)
 * - `src/common/constants/assets.constants.ts`: `ASSET_ID_PATTERN` (here `FIBER_ASSET_ID_PATTERN`), `CKB_ASSET_ID`,
 *   `LIGHTNING_ASSET_ID`
 * - `src/domain/types.ts`: `Direction`, `FiberAssetId`, `SwapState`, `QuotePurpose`, `CkbNetwork`, `Script`
 * - `src/application/fiber-node/inbound-channels.contract.ts`: `InboundChannelState`
 * - `src/application/ports/lightning-channels.port.ts`: `LnChannelState`
 * - `docs/phase-3c-public-demo-plan.md`, section 8a: the proxy secret, Lightning channels from the hub, maintenance
 *
 * Change both repos together. Amounts are decimal strings of base units; times are ISO 8601 strings.
 */

/* ------------------------------------------------------------------------------------------- shared types */

/**
 * Which way value moves for the user.
 * - `ln_to_fiber`: the user pays BTC on Lightning and receives a Fiber asset.
 * - `fiber_to_ln`: the user pays a Fiber asset and receives BTC on Lightning.
 */
export type Direction = "ln_to_fiber" | "fiber_to_ln";

/**
 * An asset on the Fiber side: "CKB", built in, or the id the hub's config gives a UDT ("RUSD", "CWBTC", or any other its
 * FIBER_ASSETS lists). Upper-case letters and digits (FIBER_ASSET_ID_PATTERN); which ids a hub serves is what its
 * GET /v1/assets and GET /v1/fiber/node list. A well-formed id the hub does not serve is 422 asset_unavailable.
 */
export type FiberAssetId = string;

/** A Fiber asset id: an upper-case letter, then 1 to 15 upper-case letters or digits (the hub's ASSET_ID_PATTERN). */
export const FIBER_ASSET_ID_PATTERN = /^[A-Z][A-Z0-9]{1,15}$/;

/** The id of native CKB, the asset every hub serves. */
export const CKB_ASSET_ID = "CKB";

/** What the API calls the Lightning leg's asset (LegDto.asset), so no Fiber asset may take the name. */
export const LIGHTNING_ASSET_ID = "BTC";

/** CKB networks a hub's Fiber node can run on. */
export type CkbNetwork = "devnet" | "testnet" | "mainnet";

/** Order states, the same machine as Fiber's Cross-Chain Hub. */
export type SwapState = "pending" | "incoming_accepted" | "outgoing_in_flight" | "outgoing_succeeded" | "succeeded" | "failed";

export const TERMINAL_SWAP_STATES: readonly SwapState[] = ["succeeded", "failed"];

/**
 * What a quote is for: a swap now, or a payment request whose invoice waits for its payer (Get paid's Lightning
 * invoice). A request quote lives the hub's REQUEST_QUOTE_TTL_SECONDS (900 by default) instead of QUOTE_TTL_SECONDS.
 */
export type QuotePurpose = "swap" | "request";

export const QUOTE_PURPOSE = {
  SWAP: "swap",
  REQUEST: "request",
} as const satisfies Record<string, QuotePurpose>;

/** Machine names for `SwapEventDto.type`. */
export const SWAP_EVENT = {
  CREATED: "created",
  INCOMING_ACCEPTED: "incoming_accepted",
  PAYOUT_STARTED: "payout_started",
  PAYOUT_SUCCEEDED: "payout_succeeded",
  PAYOUT_FAILED: "payout_failed",
  SETTLED: "settled",
  CANCELLED: "cancelled",
  EXPIRED: "expired",
  ERROR: "error",
  /** The swap's creator cancelled it with its cancel token (POST /v1/swaps/:id/cancel). */
  CANCELLED_ON_REQUEST: "cancelled_on_request",
  /** The swap failed for a reason other than an expired quote or a failed payout. */
  FAILED: "failed",
  /** The payout was sent again because the paying node had no record of it (e.g. a crash right after saving). */
  PAYOUT_RETRIED: "payout_retried",
  /** Something only a person can resolve, e.g. a payout that succeeded while the held payment is gone. */
  ALERT: "alert",
} as const;

export type SwapEventType = (typeof SWAP_EVENT)[keyof typeof SWAP_EVENT];

/* ------------------------------------------------------------------------------------------------- routes */

export const API_VERSION = "1";

export const API_ROUTES = {
  HEALTH: "health",
  ASSETS: "assets",
  QUOTES: "quotes",
  SWAPS: "swaps",
  SWAP_EVENTS: "events",
  /** A sub-resource of one swap: POST /v1/swaps/:id/cancel. */
  SWAP_CANCEL: "cancel",
  DEMO_INVOICES: "demo/invoices",
  DEMO_PAYMENTS: "demo/payments",
  /** The hub's Fiber node, as a visitor's own node (the browser node) connects to it. */
  FIBER_NODE: "fiber/node",
  /** Channels the hub's Fiber node opens to a visitor's node so it can receive; `/:nodeId` lists them. */
  FIBER_INBOUND_CHANNELS: "fiber/inbound-channels",
  /** The hub's Lightning node, as a visitor's Lightning wallet adds it as a peer. */
  LIGHTNING_NODE: "lightning/node",
  /** Channels the hub's Lightning node opens to a visitor's wallet so it can pay the hub directly; `/:pubkey` lists them. */
  LIGHTNING_INBOUND_CHANNELS: "lightning/inbound-channels",
} as const;

/** Error codes the hub sends in the `{ error: { code, message } }` body. The proxy's own follow below. */
export const API_ERROR_CODE = {
  BAD_REQUEST: "bad_request",
  VALIDATION: "validation_failed",
  /** 401: the hub requires the proxy secret (HUB_PROXY_SECRET) and the request did not carry it. */
  UNAUTHORIZED: "unauthorized",
  NOT_FOUND: "not_found",
  /** The request conflicts with the resource's current state (a quote that already has a swap, a swap already paid). */
  CONFLICT: "conflict",
  QUOTE_EXPIRED: "quote_expired",
  QUOTE_UNAVAILABLE: "quote_unavailable",
  /** 422: a quote `purpose` the hub does not serve for the direction asked: request quotes are ln_to_fiber only. */
  PURPOSE_UNSUPPORTED: "purpose_unsupported",
  /** 403: POST /v1/swaps/:id/cancel without the swap's cancel token; the same answer whether it is missing or wrong. */
  CANCEL_REFUSED: "cancel_refused",
  /** A valid asset the hub does not serve on its network. */
  ASSET_UNAVAILABLE: "asset_unavailable",
  INVOICE_INVALID: "invoice_invalid",
  DUPLICATE_HASH: "duplicate_hash",
  INSUFFICIENT_LIQUIDITY: "insufficient_liquidity",
  DEMO_DISABLED: "demo_disabled",
  /** 404: the hub does not open inbound channels to visitors' nodes. */
  INBOUND_DISABLED: "inbound_disabled",
  RATE_LIMITED: "rate_limited",
  UPSTREAM_UNAVAILABLE: "upstream_unavailable",
  /** 503: swaps are paused for maintenance (the hub's SWAPS_PAUSED): no new quotes or swaps; running swaps finish. */
  MAINTENANCE: "maintenance",
  INTERNAL: "internal_error",
} as const;

export type ApiErrorCode = (typeof API_ERROR_CODE)[keyof typeof API_ERROR_CODE];

/**
 * Web only, not in the hub: codes the same-origin proxy (`app/api/hub/[...path]`, `./proxy.ts`) answers with itself,
 * in the same `{ error: { code, message } }` body, so the browser handles them like the hub's own.
 */
export const HUB_PROXY_ERROR_CODE = {
  /**
   * 503: HUB_URL is not set on the server, the server's settings are unsafe (HUB_PROXY_SECRET over http or without
   * TRUST_PROXY), or the hub cannot be reached.
   */
  HUB_UNAVAILABLE: "hub_unavailable",
  /** 403: a write that did not come from the app's own pages (another site's origin, or a body that is not JSON). */
  FORBIDDEN: "forbidden",
  /** 504: the hub did not answer within HUB_PROXY_TIMEOUT_MS. */
  HUB_TIMEOUT: "hub_timeout",
  /** 405, with an Allow header: the path exists but not for this method. */
  METHOD_NOT_ALLOWED: "method_not_allowed",
  /** 413: the request body is larger than HUB_PROXY_MAX_BODY_BYTES. */
  PAYLOAD_TOO_LARGE: "payload_too_large",
} as const;

export type HubProxyErrorCode = (typeof HUB_PROXY_ERROR_CODE)[keyof typeof HUB_PROXY_ERROR_CODE];

/** Every code the browser can get: the hub's and the proxy's. */
export type HubErrorCode = ApiErrorCode | HubProxyErrorCode;

/**
 * Headers the web app's proxy sends the hub when HUB_PROXY_SECRET is set: the shared secret (compared in constant time),
 * and the client key the hub counts its rate limits and daily caps against (1 to 128 printable characters). The hub
 * trusts the client key only on a request with the right secret.
 */
export const HUB_PROXY_HEADER = {
  SECRET: "x-ckbolt-proxy-secret",
  CLIENT: "x-ckbolt-client",
} as const;

/**
 * POST /v1/swaps/:id/cancel carries the swap's `cancelToken` (from the 201 of POST /v1/swaps) in this header (the hub's
 * REQUEST_HEADER.CANCEL_TOKEN). Missing or wrong, the hub answers 403 cancel_refused. The browser sends it to the
 * proxy, which passes it on for that route only.
 */
export const SWAP_CANCEL_TOKEN_HEADER = "x-ckbolt-cancel-token";

/* ----------------------------------------------------------------------------------------- request bodies */

/** POST /v1/quotes */
export interface CreateQuoteBody {
  direction: Direction;
  asset: FiberAssetId;
  /** Which amount is fixed: what the user pays, or what the user receives. */
  side: "pay" | "receive";
  /** A positive whole number of base units, as a string. */
  amount: string;
  /**
   * `request` for a payment request's quote (Get paid's Lightning invoice): ln_to_fiber only (422
   * purpose_unsupported otherwise); it lives the hub's request TTL, and its swap counts toward
   * REQUEST_MAX_OPEN_PER_CLIENT while it waits for its payment. Left out for a swap quote.
   */
  purpose?: typeof QUOTE_PURPOSE.REQUEST;
}

/** POST /v1/swaps. The 201 is a CreatedSwapDto: the swap and its cancel token, given only here. */
export interface CreateSwapBody {
  quoteId: string;
  /** Fiber invoice (ln_to_fiber) or BOLT11 invoice (fiber_to_ln) the hub pays out to. */
  payoutInvoice: string;
  /** Paid by or into the hub-run demo wallet. The hub defaults it to false. */
  demo?: boolean;
}

/** POST /v1/demo/invoices: the demo wallet makes the payout invoice for a swap it will receive. */
export interface CreateDemoInvoiceBody {
  direction: Direction;
  asset: FiberAssetId;
  /** Payout leg amount in its base units: sats for fiber_to_ln, asset base units for ln_to_fiber. */
  amount: string;
}

/** POST /v1/demo/payments: the demo wallet pays the swap's hold invoice. */
export interface CreateDemoPaymentBody {
  swapId: string;
}

/**
 * POST /v1/fiber/inbound-channels: the hub's Fiber node opens a channel to a node already connected to it, so that node
 * can receive (ln_to_fiber).
 */
export interface CreateInboundChannelBody {
  /** The node's public key: 66 hex characters (compressed secp256k1, no 0x), as Fiber's node_info reports it. */
  nodeId: string;
  asset: FiberAssetId;
}

/**
 * POST /v1/lightning/inbound-channels: the hub's Lightning node opens a private channel to a wallet already connected
 * to it as a peer, with part of it pushed to the wallet's side, so the wallet can pay the hub directly.
 */
export interface CreateLightningInboundChannelBody {
  /** The wallet's node public key: 66 hex characters (33-byte compressed secp256k1), as NWC get_info reports it. */
  pubkey: string;
}

/* ---------------------------------------------------------------------------------------- response bodies */

export interface ErrorBody {
  error: { code: ApiErrorCode; message: string };
}

export interface ListBody<T> {
  data: T[];
}

/** One side of a swap as the user sees it. */
export interface LegDto {
  network: "lightning" | "fiber";
  /** "BTC" on Lightning, the Fiber asset's id on Fiber. */
  asset: typeof LIGHTNING_ASSET_ID | FiberAssetId;
  /** Base units: sats on Lightning, asset base units on Fiber. */
  amount: string;
  decimals: number;
}

/**
 * `minSats` and `maxSats` bound the Lightning leg of a swap in this asset (each asset can have its own). `liquidity` is
 * the largest payout a new quote can get right now on each side: sats on Lightning (fiber_to_ln) and the asset's base
 * units on Fiber (ln_to_fiber), after the payouts of open swaps and the routing fee budget.
 *
 * `displayName` and `iconUrl` are how the hub's operator wants the asset shown (FIBER_ASSETS), null when not set: show
 * `displayName` instead of `name`, and the icon only as an image (`<img src>`), never by inlining its markup. `iconUrl`
 * is an https URL or an inline SVG (`data:image/svg+xml;base64,...`, at most 8,192 characters, checked to hold no
 * script, event handler or outside reference). An https icon is fetched from its own host: a page with
 * `Cross-Origin-Embedder-Policy: require-corp` shows it only if that host sends `Cross-Origin-Resource-Policy: cross-origin`.
 * The web app checks it again before use (lib/token-display.ts).
 */
export interface AssetDto {
  id: FiberAssetId;
  symbol: string;
  name: string;
  displayName: string | null;
  iconUrl: string | null;
  decimals: number;
  directions: Direction[];
  minSats: string;
  maxSats: string;
  liquidity: { lightningSats: string; fiberAmount: string };
}

export interface QuoteDto {
  id: string;
  direction: Direction;
  asset: FiberAssetId;
  /** What the user pays (incoming leg) and receives (outgoing leg). */
  pay: LegDto;
  receive: LegDto;
  prices: { btcUsd: number; assetUsd: number; source: string; at: string };
  /** Hub fee plus option premium, plus the hub's REQUEST_PREMIUM_BPS on a request quote. */
  feeBps: number;
  /** `swap`, or `request` when the quote was asked for with that purpose (then `expiresAt` is the request TTL away). */
  purpose: QuotePurpose;
  createdAt: string;
  /** Until when a swap can be created on it, and until when that swap's hold invoice can be paid. */
  expiresAt: string;
  signature: string;
  hubPubkey: string;
}

export interface SwapDto {
  id: string;
  quoteId: string;
  direction: Direction;
  asset: FiberAssetId;
  state: SwapState;
  paymentHash: string;
  /** What the user pays, and the hold invoice to pay it with. */
  pay: LegDto & { invoice: string };
  /** What the user receives, and the invoice it is paid to. */
  receive: LegDto & { invoice: string };
  refunded: boolean;
  failureReason: string | null;
  /** Shown once the swap has succeeded (it is public on both networks by then). */
  preimage: string | null;
  demo: boolean;
  quoteExpiresAt: string;
  createdAt: string;
  updatedAt: string;
  links: { self: string; events: string };
}

/**
 * The 201 of POST /v1/swaps: the swap and its cancel token, which the hub hands out only here and keeps only as a hash.
 * Whoever holds it can cancel the swap while nobody has paid it (POST /v1/swaps/:id/cancel, header
 * SWAP_CANCEL_TOKEN_HEADER), and nothing else: it moves no money. The app keeps it in memory only, and only for Get
 * paid's Lightning invoices (components/app/get-paid/use-lightning-invoice.ts).
 */
export interface CreatedSwapDto extends SwapDto {
  cancelToken: string;
}

export interface SwapEventDto {
  at: string;
  type: string;
  detail: string;
}

/**
 * `network` is what each node itself reports: null when the node does not answer or names a chain the hub does not know.
 * `reason` says why the hub is degraded (plain sentences); it is absent when the hub is ok.
 */
export interface HealthDto {
  status: "ok" | "degraded";
  reason?: string;
  version: string;
  lightning: { reachable: boolean; network: string | null; synced: boolean; blockHeight: number | null };
  fiber: { reachable: boolean; network: string | null; version: string | null };
  demo: { enabled: boolean };
  swaps: { paused: boolean };
}

export interface DemoInvoiceDto {
  invoice: string;
  paymentHash: string;
}

export interface DemoPaymentDto {
  swapId: string;
  status: "submitted";
}

/** A CKB script in JSON form; hex fields are 0x-prefixed (the hub's domain `Script`). */
export interface Script {
  codeHash: string;
  hashType: "type" | "data" | "data1" | "data2";
  args: string;
}

/** Where an inbound channel is in its life, from the hub's side; closed channels are not listed. */
export type InboundChannelState = "opening" | "ready" | "closing";

/**
 * A cell dep of a UDT's type script: by out point (CKB's form; `index` as a hex quantity such as "0x0") or by type id.
 * In fnn's YAML they are `cell_dep: { out_point: { tx_hash, index }, dep_type }` and `type_id: { code_hash, hash_type, args }`.
 */
export type CellDepDto = { outPoint: { txHash: string; index: string }; depType: "code" | "dep_group" } | { typeId: Script };

/**
 * What a Fiber node puts in its config's `ckb.udt_whitelist` (fnn's UdtArgInfo) to take channels in a UDT: the browser
 * node builds its entry from this (lib/wallets/fiber-browser/node-config.ts). `script` is the exact type script: fnn
 * reads the whitelist's `args` as an unanchored regex, so it is written `^<args>$`. `autoAcceptAmount` (base units,
 * decimal string) is fnn's `auto_accept_amount` that takes the hub's inbound channel in the UDT without a manual accept
 * (at most the hub's funding); null when the hub opens no inbound channel in it (the field is left out then).
 */
export interface UdtWhitelistDto {
  name: string;
  script: Script;
  cellDeps: CellDepDto[];
  autoAcceptAmount: string | null;
}

/**
 * A channel a node may open to the hub's node in a UDT, funded with its own tokens, to pay the hub (fiber_to_ln) without
 * receiving the token first. The hub's node accepts it on its own when it is funded with at least `minAmount` (base
 * units, decimal string) and adds no tokens: the node can send the hub what it put in, and receive back only what it
 * sent. To open one: whitelist the UDT (`udtWhitelist`), connect to one of `addresses`, then fnn's `open_channel` with
 * `pubkey` the hub's `nodeId`, `funding_udt_type_script` the asset's `udtTypeScript`, `funding_amount` at least
 * `minAmount`, and `public: false`. No `commitment_delay_epoch` is required: the hub cannot see it, so it counts
 * `assumedCommitmentDelayEpochs` (the longest fnn accepts, 84) whatever the opener chose, and sizes its hold invoices in
 * the asset for it. fnn's default (leave the field out) is the simplest choice. The browser node opens one from the
 * hub channel card (lib/wallets/fiber-browser/own-token-channel.ts).
 */
export interface PeerChannelsDto {
  minAmount: string;
  assumedCommitmentDelayEpochs: number;
}

/**
 * An asset the hub swaps, as GET /v1/fiber/node lists it: `udtWhitelist` null for CKB (and from hubs older than it);
 * `peerChannels` null unless a node may open its own channel to the hub in the asset now: null for every asset as well
 * while nodes have as many such channels open as the hub allows (FIBER_PEER_CHANNELS_MAX_OPEN), or when the hub cannot
 * read its node's channels (and absent from older hubs).
 */
export interface FiberNodeAssetDto {
  id: FiberAssetId;
  udtTypeScript: Script | null;
  udtWhitelist: UdtWhitelistDto | null;
  peerChannels: PeerChannelsDto | null;
}

/**
 * GET /v1/fiber/node: the hub's Fiber node as another Fiber node sees it. `addresses.ws` are the multiaddrs a browser
 * node (fiber-js) dials, `p2p` the native TCP ones. `assets` are the ones the hub swaps, each with its UDT type script
 * (null for CKB) and what a node needs to whitelist the UDT. `inbound.amounts` is what the hub funds an inbound channel
 * with per asset, in base units; empty when the hub opens none (`enabled` false). `inbound.fundable` says per asset
 * whether the hub could fund one now (false: it would answer 422 insufficient_liquidity); an asset is left out when the
 * hub cannot tell, and older hubs send none.
 */
export interface FiberNodeDto {
  nodeId: string;
  network: string;
  addresses: { p2p: string[]; ws: string[] };
  assets: FiberNodeAssetDto[];
  inbound: { enabled: boolean; amounts: Partial<Record<FiberAssetId, string>>; fundable?: Partial<Record<FiberAssetId, boolean>> };
}

/** 202 answer of POST /v1/fiber/inbound-channels: `fundingAmount` (base units) is all on the hub's side. */
export interface InboundChannelOpeningDto {
  nodeId: string;
  asset: FiberAssetId;
  fundingAmount: string;
  temporaryChannelId: string;
}

/** GET /v1/fiber/inbound-channels/:nodeId: `hubBalance` is what the node can still receive over it, `nodeBalance` its own. */
export interface InboundChannelDto {
  channelId: string;
  asset: FiberAssetId;
  state: InboundChannelState;
  hubBalance: string;
  nodeBalance: string;
}

/**
 * GET /v1/lightning/node: the hub's Lightning node as a wallet sees it. `network` is what the node reports (null for a
 * chain the hub does not know). `uris` (pubkey@host:port) are what a wallet adds as a peer before it asks for a channel. `inbound` is the channel the hub opens to a wallet, in sats: its
 * capacity, and the part pushed to the wallet's side.
 */
export interface LightningNodeDto {
  pubkey: string;
  network: string | null;
  uris: string[];
  inbound: { enabled: boolean; capacitySats: string; pushSats: string };
}

/** 202 answer of POST /v1/lightning/inbound-channels. */
export interface LightningInboundChannelOpeningDto {
  pubkey: string;
  capacitySats: string;
  pushSats: string;
  fundingTxid: string;
}

/** Where a channel of the hub's Lightning node with a wallet is; closed channels are not listed. */
export type LnChannelState = "opening" | "ready" | "closing";

/**
 * GET /v1/lightning/inbound-channels/:pubkey: the channels the hub's Lightning node has with that wallet. The hub maps
 * `hubBalanceSats` from its own side (LND local balance) and `walletBalanceSats` from the wallet's (remote balance):
 * the second is what the wallet can pay the hub over the channel.
 */
export interface LightningInboundChannelDto {
  /** The funding outpoint, txid:vout. */
  channelPoint: string;
  state: LnChannelState;
  capacitySats: string;
  hubBalanceSats: string;
  walletBalanceSats: string;
}
