import { MS_PER_HOUR, MS_PER_SECOND } from "./protocol.constants";

/**
 * Values of what the hub offers Lightning wallets (src/application/lightning-node): its node's URIs and inbound channels.
 * The tunables (URIs, channel size, caps, reserve) live in HubConfig.lightningPeers.
 */

/** Where a Lightning channel is in its life, as the hub reports it: LND's pending open and pending close lists. */
export const LN_CHANNEL_STATE = {
  OPENING: "opening",
  READY: "ready",
  CLOSING: "closing",
} as const;

/**
 * Retry-After of a request refused because the hub has as many inbound Lightning channels open as it allows. Channels
 * do not close on a schedule, so this only spaces out retries.
 */
export const LN_INBOUND_CHANNELS_FULL_RETRY_AFTER_SECONDS = MS_PER_HOUR / MS_PER_SECOND;

/**
 * The memo (LND's immutable channel description) of every inbound channel the hub opens: how the cap on open inbound
 * channels tells them from the hub's own channels (its private channel to the LSP, say).
 */
export const LN_INBOUND_CHANNEL_MEMO = "ckbolt inbound channel";
