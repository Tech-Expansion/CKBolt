import { API_ROUTES, API_VERSION, type ApiErrorCode } from "../../../common/constants/api.constants";
import { LIGHTNING_ASSET_ID } from "../../../common/constants/assets.constants";
import { BTC_DECIMALS } from "../../../common/constants/protocol.constants";
import { SWAP_DIRECTION, SWAP_STATE } from "../../../common/constants/swap.constants";
import { toDecimalString } from "../../../common/utils/amount.util";
import { toIso } from "../../../common/utils/time.util";
import type { HubFiberNode } from "../../../application/fiber-node/fiber-node.contract";
import type { InboundChannel, InboundChannelOpening, InboundChannelState } from "../../../application/fiber-node/inbound-channels.contract";
import type { HubLightningNode } from "../../../application/lightning-node/lightning-node.contract";
import type { LnInboundChannel, LnInboundChannelOpening } from "../../../application/lightning-node/ln-inbound-channels.contract";
import type { LnChannelState } from "../../../application/ports/lightning-channels.port";
import type { AssetAvailability } from "../../../application/pricing/pricing.contract";
import type { CreatedSwap } from "../../../application/swaps/swap-engine.contract";
import type { InboundOffer, PeerChannelOffer } from "../../../application/fiber-node/fiber-node.contract";
import type { CellDep, Direction, FiberAsset, FiberAssetId, Quote, QuotePurpose, Script, Swap, SwapEvent, SwapState } from "../../../domain/types";

/**
 * Response bodies of the REST API (v1). Amounts are decimal strings of base units; times are ISO 8601 strings.
 * Single resources are returned as the object itself; collections as `{ data: [...] }`; errors as `{ error }`.
 */

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
  /** Hub fee plus option premium, plus REQUEST_PREMIUM_BPS on a request quote. */
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
  /**
   * True once the hub has cancelled the hold invoice, so it keeps nothing of the user's: a held payment goes back to the
   * payer. Also true for a swap that was never paid (its hold invoice was cancelled or expired unpaid).
   */
  refunded: boolean;
  failureReason: string | null;
  /** Shown once the swap has succeeded (it is public on both networks by then). */
  preimage: string | null;
  /** True when the hub found the payout invoice is the hub-run demo wallet's own (custodial test money). */
  demo: boolean;
  quoteExpiresAt: string;
  createdAt: string;
  updatedAt: string;
  links: { self: string; events: string };
}

/**
 * The 201 of POST /v1/swaps: the swap and its cancel token, which the hub hands out only here and keeps only as a hash.
 * Whoever holds it can cancel the swap while nobody has paid it (POST /v1/swaps/:id/cancel, header
 * X-CKBolt-Cancel-Token), and nothing else: it moves no money.
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
 * `network` is what each node itself reports, not the hub's configuration: null when the node does not answer or names a
 * chain the hub does not know. `reason` says why the hub is degraded (plain sentences); it is absent when the hub is ok.
 */
export interface HealthDto {
  status: "ok" | "degraded";
  reason?: string;
  version: string;
  lightning: { reachable: boolean; network: string | null; synced: boolean; blockHeight: number | null };
  fiber: { reachable: boolean; network: string | null; version: string | null };
  demo: { enabled: boolean };
  /**
   * True while the hub is paused for maintenance (SWAPS_PAUSED): new quotes, swaps and inbound channels (Fiber and
   * Lightning) answer 503 `maintenance`.
   */
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

/**
 * A cell dep of a UDT's type script: by out point (CKB's form; `index` as a hex quantity such as "0x0") or by type id.
 * In fnn's YAML they are `cell_dep: { out_point: { tx_hash, index }, dep_type }` and `type_id: { code_hash, hash_type, args }`.
 */
export type CellDepDto = { outPoint: { txHash: string; index: string }; depType: "code" | "dep_group" } | { typeId: Script };

/**
 * What a Fiber node puts in its config's `ckb.udt_whitelist` (fnn's UdtArgInfo) to take channels in a UDT: a browser
 * node (fiber-js) builds its entry from this. `script` is the exact type script: fnn reads the whitelist's `args` as an
 * unanchored regex, so write it as `^<args>$`. `autoAcceptAmount` (base units, decimal string) is fnn's
 * `auto_accept_amount` that takes the hub's inbound channel in the UDT without a manual accept (it is at most the
 * hub's funding); null when the hub opens no inbound channel in it (leave the field out of the entry then).
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
 * the asset for it. fnn's default (leave the field out) is the simplest choice.
 */
export interface PeerChannelsDto {
  minAmount: string;
  assumedCommitmentDelayEpochs: number;
}

/**
 * An asset the hub swaps, as GET /v1/fiber/node lists it: `udtWhitelist` null for CKB; `peerChannels` null unless a node
 * may open its own channel to the hub in the asset now: null for every asset as well while nodes have as many such
 * channels open as the hub allows (FIBER_PEER_CHANNELS_MAX_OPEN), or when the hub cannot read its node's channels.
 */
export interface FiberNodeAssetDto {
  id: FiberAssetId;
  udtTypeScript: Script | null;
  udtWhitelist: UdtWhitelistDto | null;
  peerChannels: PeerChannelsDto | null;
}

/**
 * The hub's Fiber node as another Fiber node sees it. `addresses.ws` are the multiaddrs a browser node (fiber-js) dials;
 * `p2p` the native TCP ones (fnn, Fiber Studio). `assets` are the ones the hub swaps, each with its UDT type script (null
 * for CKB) and what a node needs to whitelist the UDT. `inbound.amounts` is what the hub funds an inbound channel with
 * per asset, in base units; empty when the hub opens none (`enabled` false).
 */
export interface FiberNodeDto {
  nodeId: string;
  network: string;
  addresses: { p2p: string[]; ws: string[] };
  assets: FiberNodeAssetDto[];
  /**
   * `amounts`: what the hub funds an inbound channel with per asset, in base units. `fundable`: per asset, whether the
   * hub could fund one now; an asset is left out when the hub could not tell (its node's channels did not read).
   */
  inbound: { enabled: boolean; amounts: Partial<Record<FiberAssetId, string>>; fundable?: Partial<Record<FiberAssetId, boolean>> };
}

/**
 * An inbound channel the hub's node has started to open (202): `fundingAmount` (base units) is all on the hub's side, so
 * it is what the node can receive, less fnn's reserve on a CKB channel. Follow it with GET /v1/fiber/inbound-channels/:nodeId.
 */
export interface InboundChannelOpeningDto {
  nodeId: string;
  asset: FiberAssetId;
  fundingAmount: string;
  temporaryChannelId: string;
}

/** A channel the hub's node opened to the node. `hubBalance` is what the node can still receive over it, `nodeBalance` its own. */
export interface InboundChannelDto {
  channelId: string;
  asset: FiberAssetId;
  state: InboundChannelState;
  hubBalance: string;
  nodeBalance: string;
}

/**
 * The hub's Lightning node as a Lightning wallet sees it. `network` is what the node reports (null for a chain the hub
 * does not know). `uris` are what a wallet adds as a peer (pubkey@host:port). `inbound` is the channel the hub opens to
 * a connected wallet, sats as decimal strings: its size and the part that starts on the wallet's side.
 */
export interface LightningNodeDto {
  pubkey: string;
  network: string | null;
  uris: string[];
  inbound: { enabled: boolean; capacitySats: string; pushSats: string };
}

/**
 * An inbound Lightning channel the hub's node has started to open (202): its funding transaction is published, and the
 * channel is ready once it confirms. Follow it with GET /v1/lightning/inbound-channels/:pubkey.
 */
export interface LightningInboundChannelOpeningDto {
  pubkey: string;
  capacitySats: string;
  pushSats: string;
  fundingTxid: string;
}

/**
 * A channel the hub's Lightning node has with the wallet, whoever opened it. `walletBalanceSats` is what the wallet can
 * still pay the hub over it, `hubBalanceSats` what the hub can pay the wallet.
 */
export interface LightningInboundChannelDto {
  /** The funding outpoint, txid:vout. */
  channelPoint: string;
  state: LnChannelState;
  capacitySats: string;
  hubBalanceSats: string;
  walletBalanceSats: string;
}

/* ------------------------------------------------------------------------------------------------ mappers */

export const resourcePath = (...segments: string[]): string => `/v${API_VERSION}/${segments.join("/")}`;

const lightningLeg = (sats: bigint): LegDto => ({ network: "lightning", asset: LIGHTNING_ASSET_ID, amount: toDecimalString(sats), decimals: BTC_DECIMALS });
const fiberLeg = (amount: bigint, asset: FiberAsset): LegDto => ({
  network: "fiber",
  asset: asset.id,
  amount: toDecimalString(amount),
  decimals: asset.decimals,
});

/** The user's pay and receive legs for a direction. */
function legs(direction: Direction, sats: bigint, fiberAmount: bigint, asset: FiberAsset): { pay: LegDto; receive: LegDto } {
  return direction === SWAP_DIRECTION.LN_TO_FIBER
    ? { pay: lightningLeg(sats), receive: fiberLeg(fiberAmount, asset) }
    : { pay: fiberLeg(fiberAmount, asset), receive: lightningLeg(sats) };
}

export function toAssetDto(a: AssetAvailability): AssetDto {
  return {
    id: a.asset.id,
    symbol: a.asset.symbol,
    name: a.asset.name,
    displayName: a.asset.displayName ?? null,
    iconUrl: a.asset.iconUrl ?? null,
    decimals: a.asset.decimals,
    directions: a.directions,
    minSats: toDecimalString(a.minSats),
    maxSats: toDecimalString(a.maxSats),
    liquidity: { lightningSats: toDecimalString(a.liquidity.lightningSats), fiberAmount: toDecimalString(a.liquidity.fiberAmount) },
  };
}

export function toQuoteDto(q: Quote, asset: FiberAsset): QuoteDto {
  return {
    id: q.id,
    direction: q.direction,
    asset: q.asset,
    ...legs(q.direction, q.sats, q.fiberAmount, asset),
    prices: { btcUsd: q.btcUsd, assetUsd: q.assetUsd, source: q.priceSource, at: toIso(q.priceAt) },
    feeBps: q.feeBps,
    purpose: q.purpose,
    createdAt: toIso(q.createdAt),
    expiresAt: toIso(q.expiresAt),
    signature: q.signature,
    hubPubkey: q.hubPubkey,
  };
}

export function toSwapDto(s: Swap, asset: FiberAsset): SwapDto {
  const { pay, receive } = legs(s.direction, s.sats, s.fiberAmount, asset);
  const self = resourcePath(API_ROUTES.SWAPS, s.id);
  return {
    id: s.id,
    quoteId: s.quoteId,
    direction: s.direction,
    asset: s.asset,
    state: s.state,
    paymentHash: s.paymentHash,
    pay: { ...pay, invoice: s.holdInvoice },
    receive: { ...receive, invoice: s.payoutInvoice },
    refunded: s.refunded,
    failureReason: s.failureReason,
    preimage: s.state === SWAP_STATE.SUCCEEDED ? s.preimage : null,
    demo: s.demo,
    quoteExpiresAt: toIso(s.quoteExpiresAt),
    createdAt: toIso(s.createdAt),
    updatedAt: toIso(s.updatedAt),
    links: { self, events: `${self}/${API_ROUTES.SWAP_EVENTS}` },
  };
}

export const toCreatedSwapDto = (created: CreatedSwap, asset: FiberAsset): CreatedSwapDto => ({
  ...toSwapDto(created, asset),
  cancelToken: created.cancelToken,
});

export const toSwapEventDto = (e: SwapEvent): SwapEventDto => ({ at: toIso(e.at), type: e.type, detail: e.detail });

const toCellDepDto = (dep: CellDep): CellDepDto =>
  "typeId" in dep ? { typeId: { ...dep.typeId } } : { outPoint: { ...dep.outPoint }, depType: dep.depType };

/** A UDT's whitelist entry, with the auto-accept amount of the hub's inbound channel offer in it (if any). */
const toUdtWhitelistDto = (asset: FiberAsset, script: Script, offer: InboundOffer | undefined): UdtWhitelistDto => ({
  name: asset.symbol,
  script: { ...script },
  cellDeps: asset.cellDeps.map(toCellDepDto),
  autoAcceptAmount: offer === undefined || offer.autoAcceptAmount === null ? null : toDecimalString(offer.autoAcceptAmount),
});

const toPeerChannelsDto = (offer: PeerChannelOffer | undefined): PeerChannelsDto | null =>
  offer === undefined ? null : { minAmount: toDecimalString(offer.minAmount), assumedCommitmentDelayEpochs: offer.assumedCommitmentDelayEpochs };

const toFiberNodeAssetDto = (asset: FiberAsset, node: HubFiberNode): FiberNodeAssetDto => ({
  id: asset.id,
  udtTypeScript: asset.udtTypeScript && { ...asset.udtTypeScript },
  udtWhitelist:
    asset.udtTypeScript && toUdtWhitelistDto(asset, asset.udtTypeScript, node.inbound.offers.find((offer) => offer.asset.id === asset.id)),
  peerChannels: toPeerChannelsDto(node.peerChannels.find((offer) => offer.asset.id === asset.id)),
});

export const toFiberNodeDto = (node: HubFiberNode): FiberNodeDto => ({
  nodeId: node.nodeId,
  network: node.network,
  addresses: { p2p: [...node.addresses.p2p], ws: [...node.addresses.ws] },
  assets: node.assets.map((asset) => toFiberNodeAssetDto(asset, node)),
  inbound: {
    enabled: node.inbound.enabled,
    amounts: Object.fromEntries(node.inbound.offers.map((offer) => [offer.asset.id, toDecimalString(offer.amount)])),
    fundable: Object.fromEntries(node.inbound.offers.flatMap((offer) => (offer.fundable === null ? [] : [[offer.asset.id, offer.fundable]]))),
  },
});

export const toInboundChannelOpeningDto = (opening: InboundChannelOpening): InboundChannelOpeningDto => ({
  nodeId: opening.nodeId,
  asset: opening.asset,
  fundingAmount: toDecimalString(opening.fundingAmount),
  temporaryChannelId: opening.temporaryChannelId,
});

export const toInboundChannelDto = (channel: InboundChannel): InboundChannelDto => ({
  channelId: channel.channelId,
  asset: channel.asset,
  state: channel.state,
  hubBalance: toDecimalString(channel.hubBalance),
  nodeBalance: toDecimalString(channel.nodeBalance),
});

export const toLightningNodeDto = (node: HubLightningNode): LightningNodeDto => ({
  pubkey: node.pubkey,
  network: node.network,
  uris: [...node.uris],
  inbound: {
    enabled: node.inbound.enabled,
    capacitySats: toDecimalString(node.inbound.capacitySats),
    pushSats: toDecimalString(node.inbound.pushSats),
  },
});

export const toLightningInboundChannelOpeningDto = (opening: LnInboundChannelOpening): LightningInboundChannelOpeningDto => ({
  pubkey: opening.pubkey,
  capacitySats: toDecimalString(opening.capacitySats),
  pushSats: toDecimalString(opening.pushSats),
  fundingTxid: opening.fundingTxid,
});

export const toLightningInboundChannelDto = (channel: LnInboundChannel): LightningInboundChannelDto => ({
  channelPoint: channel.channelPoint,
  state: channel.state,
  capacitySats: toDecimalString(channel.capacitySats),
  hubBalanceSats: toDecimalString(channel.hubBalanceSats),
  walletBalanceSats: toDecimalString(channel.walletBalanceSats),
});
