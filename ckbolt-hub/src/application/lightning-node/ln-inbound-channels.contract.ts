import type { LnChannelState } from "../ports/lightning-channels.port";

export interface OpenLnInboundChannelInput {
  /** The wallet to open the channel to (its node's public key, lower-case hex); it must be connected to the hub's LND. */
  pubkey: string;
  /** The HTTP layer's client key (the one the rate limiter counts), for the per-client daily cap. */
  clientKey: string;
}

/** A channel the hub's LND has started to open: its funding transaction is published. */
export interface LnInboundChannelOpening {
  pubkey: string;
  capacitySats: bigint;
  /** What starts on the wallet's side. */
  pushSats: bigint;
  fundingTxid: string;
}

/** A channel the hub's LND has with a wallet: `walletBalanceSats` is what the wallet can still pay the hub over it. */
export interface LnInboundChannel {
  channelPoint: string;
  state: LnChannelState;
  capacitySats: bigint;
  hubBalanceSats: bigint;
  walletBalanceSats: bigint;
}

/**
 * Inbound Lightning channels: the hub's LND opens a private, static_remote_key channel, funded from its own on-chain
 * wallet with part of it pushed to the wallet, to a Lightning wallet connected to it, so a wallet that cannot route to
 * the hub (LDK on Mutinynet) can pay it directly. Capped per client and per wallet each sliding day, for every client
 * together each UTC day (a count and a push budget) and in total, and only while the hub's confirmed on-chain balance
 * covers the channel and its reserve.
 */
export interface LnInboundChannels {
  /** LN_INBOUND_ENABLED: when false the routes answer 404 inbound_disabled. */
  readonly enabled: boolean;
  /**
   * Starts opening the channel. Throws HubErrors, from the first check that fails: 404 inbound_disabled; 429 rate_limited
   * (too many requests already wait for an open; the client's or the wallet's sliding-day cap; the UTC day's count or
   * push budget; or the cap on open inbound channels); 409 conflict (the wallet is not
   * connected to the hub's LND, or already has a channel with it, open or opening); 503 insufficient_liquidity (the
   * confirmed on-chain balance does not cover the channel and the reserve); 503 upstream_unavailable (the node does not
   * answer, or refuses to open the channel).
   */
  open(input: OpenLnInboundChannelInput): Promise<LnInboundChannelOpening>;
  /**
   * The inbound channels the hub's LND has with the wallet that are not closed: the ones it opened with the inbound memo.
   * Its other channels (to its LSP, or opened by hand) are left out.
   */
  list(pubkey: string): Promise<LnInboundChannel[]>;
}

export const LN_INBOUND_CHANNELS = Symbol("LN_INBOUND_CHANNELS");
