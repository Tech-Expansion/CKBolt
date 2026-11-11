import type { FIBER_CHANNEL_STATUS } from "../../common/constants/fiber-node.constants";
import type { FiberAssetId } from "../../domain/types";
import type { FiberChannelStatus } from "../ports/fiber.port";

/** Where an inbound channel is in its life; closed channels are not listed. */
export type InboundChannelState = Exclude<FiberChannelStatus, typeof FIBER_CHANNEL_STATUS.CLOSED>;

export interface OpenInboundChannelInput {
  /** The node to open the channel to (lower-case hex without 0x); it must be connected to the hub's node. */
  nodeId: string;
  asset: FiberAssetId;
  /** The HTTP layer's client key (the one the rate limiter counts), for the per-client daily cap. */
  clientKey: string;
}

/** A channel the hub's node has started to open: all of `fundingAmount` (base units) is on the hub's side. */
export interface InboundChannelOpening {
  nodeId: string;
  asset: FiberAssetId;
  fundingAmount: bigint;
  /** fnn's id for the channel until the peer accepts it; the channel is then listed under its final id. */
  temporaryChannelId: string;
}

/** A channel the hub's node opened to a node: `hubBalance` is what the node can still receive over it. */
export interface InboundChannel {
  channelId: string;
  asset: FiberAssetId;
  state: InboundChannelState;
  hubBalance: bigint;
  nodeBalance: bigint;
}

/**
 * Inbound channels: the hub's Fiber node opens a private channel, funded from its own wallet, to a node connected to it
 * (a browser node), so that node can receive ln_to_fiber payouts. One per node and asset, capped per client and per node
 * each sliding day, for every client together each UTC day, and in total, and only while the hub keeps enough Fiber
 * liquidity for swaps.
 */
export interface InboundChannels {
  /** FIBER_INBOUND_ENABLED: when false the routes answer 404 inbound_disabled. */
  readonly enabled: boolean;
  /**
   * Starts opening the channel. Throws HubErrors: 404 inbound_disabled; 422 asset_unavailable (no amount for the asset,
   * or the hub does not serve it); 429 rate_limited (too many requests already wait for an open, a daily cap, or the cap
   * on open inbound channels); 409 conflict (the
   * node is not connected, or already has a channel from the hub in the asset, open or opening); 422
   * insufficient_liquidity; 503 upstream_unavailable (the node does not answer, or refuses to open the channel).
   */
  open(input: OpenInboundChannelInput): Promise<InboundChannelOpening>;
  /** The channels the hub's node opened to `nodeId` that are not closed, in assets the hub serves. */
  list(nodeId: string): Promise<InboundChannel[]>;
}

export const INBOUND_CHANNELS = Symbol("INBOUND_CHANNELS");
