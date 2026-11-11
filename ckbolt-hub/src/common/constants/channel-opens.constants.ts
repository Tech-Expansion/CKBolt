import { MS_PER_DAY } from "./protocol.constants";

/**
 * Values of the channels the hub's nodes open on request: inbound Fiber channels (src/application/fiber-node) and
 * inbound Lightning channels (src/application/lightning-node), both capped by ChannelOpenCaps
 * (src/application/channel-opens). The caps themselves are tunables in HubConfig.fiberPeers and HubConfig.lightningPeers.
 */

/** Which of the hub's nodes opened a channel on request: its fnn (inbound Fiber channels) or its LND (Lightning). */
export const CHANNEL_OPEN_KIND = {
  FIBER: "fiber",
  LIGHTNING: "lightning",
} as const;

export type ChannelOpenKind = (typeof CHANNEL_OPEN_KIND)[keyof typeof CHANNEL_OPEN_KIND];

/** The per-client and per-peer caps count the channels opened in this sliding window. */
export const CHANNEL_OPEN_CAP_WINDOW_MS = MS_PER_DAY;

/**
 * How long an open is kept in the log. Older ones count toward no cap (the sliding day, and the UTC day, which began
 * less than a day ago), so they are deleted with the client key they carry.
 */
export const CHANNEL_OPEN_LOG_RETENTION_MS = CHANNEL_OPEN_CAP_WINDOW_MS;

/**
 * Most open requests that may wait behind the one running. A peer that stalls holds an open until the node call's
 * deadline, so without a bound the queue, and every request in it, could grow without end.
 */
export const CHANNEL_OPEN_QUEUE_MAX_WAITING = 5;

/** Retry-After of a request refused because the queue of opens is full: opens take seconds, at worst a deadline each. */
export const CHANNEL_OPEN_QUEUE_FULL_RETRY_AFTER_SECONDS = 30;
