import type { FiberAssetId } from "../../domain/types";
import {
  FIBER_CKB_CHANNEL_RESERVE_SHANNONS,
  FIBER_DEFAULT_AUTO_ACCEPT_MIN_CKB_SHANNONS,
  MS_PER_HOUR,
  MS_PER_SECOND,
} from "./protocol.constants";

/**
 * Values of what the hub offers other Fiber nodes (src/application/fiber-node): its node's addresses and inbound
 * channels. The tunables (addresses, amounts, caps) live in HubConfig.fiberPeers.
 */

/** Where a channel is in its life, as the hub reports it: fnn's many opening states are all `opening`. */
export const FIBER_CHANNEL_STATUS = {
  OPENING: "opening",
  READY: "ready",
  CLOSING: "closing",
  CLOSED: "closed",
} as const;

/**
 * Retry-After of a request refused because the hub has as many inbound channels open as it allows. Channels do not
 * close on a schedule, so this only spaces out retries.
 */
export const INBOUND_CHANNELS_FULL_RETRY_AFTER_SECONDS = MS_PER_HOUR / MS_PER_SECOND;

/**
 * Least FIBER_INBOUND_ACCEPT_TIMEOUT_SECONDS: a browser node keeps trying accept_channel for about 20 seconds after the
 * hub's answer (ckbolt-web HUB_ACCEPT_RETRY_DELAYS_MS), so a shorter wait could abandon a channel it is accepting.
 */
export const INBOUND_CHANNEL_MIN_ACCEPT_TIMEOUT_SECONDS = 60;

/**
 * The smallest funding of an inbound channel, per asset, in base units: a node with fnn's default settings (Fiber
 * Studio) accepts a smaller channel only by hand, so it would stay opening. A browser node accepts every CKB channel by
 * hand now (accept_channel, its auto-accept turned off), so this only spares other nodes. CKB: the reserve plus the
 * default auto-accept minimum. A UDT's auto-accept amount is the node's own whitelist setting, so it has no minimum here:
 * FIBER_ASSETS holds its inboundAmount to the autoAcceptAmount the hub tells browser nodes to whitelist.
 */
export const INBOUND_CHANNEL_MIN_FUNDING: Readonly<Partial<Record<FiberAssetId, bigint>>> = {
  CKB: FIBER_CKB_CHANNEL_RESERVE_SHANNONS + FIBER_DEFAULT_AUTO_ACCEPT_MIN_CKB_SHANNONS,
};
