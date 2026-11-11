import { API_ERROR_CODE, HUB_PROXY_ERROR_CODE, type FiberAssetId, type InboundChannelDto, type InboundChannelState } from "@/lib/hub/contract";

/**
 * A Fiber channel from the hub for an external node (Fiber Studio, fnn): the node connects to the hub's address, the
 * visitor pastes its node id and picks a token on the guide's hub card, and the hub opens a private channel with its own
 * tokens on its side (POST /v1/fiber/inbound-channels), so the node can receive swaps. Plain logic here; the card is
 * components/app/guide/fiber-channel.tsx.
 */

/** Where the node's channel in the token stands: none yet, or the state of the one the card shows. */
export type FiberChannelStatus = "none" | InboundChannelState;

const SHOWN_FIRST: readonly InboundChannelState[] = ["ready", "opening", "closing"];

/** The channel in `asset` the card shows (ready over opening over closing), or null when there is none. */
export function shownFiberChannel(channels: readonly InboundChannelDto[], asset: FiberAssetId): InboundChannelDto | null {
  const inAsset = channels.filter((c) => c.asset === asset);
  for (const state of SHOWN_FIRST) {
    const channel = inAsset.find((c) => c.state === state);
    if (channel) return channel;
  }
  return null;
}

/** The shown channel's state, or `opening` right after the hub took a request it does not list yet, or `none`. */
export const fiberChannelStatus = (channel: InboundChannelDto | null, requested: boolean): FiberChannelStatus =>
  channel?.state ?? (requested ? "opening" : "none");

export const FIBER_CHANNEL_MESSAGE = {
  NODE_ID_INVALID: "Paste your Fiber node id: 66 hex characters, starting 02 or 03.",
  CONNECT_FIRST: "Connect your node to the hub first (the command above), then try again.",
  DISABLED: "The hub does not open Fiber channels right now.",
  ASSET: "The hub does not open channels in this token.",
  LIMIT: "The hub's channel limit is reached for now. Try again later.",
  NO_FUNDS: "The hub has no funds for a new channel in this token right now. Try again later.",
  PAUSED: "The hub is paused for maintenance. Try again later.",
  KEY_REFUSED: "The hub did not accept this node id.",
  HUB_UNREACHABLE: "The hub did not answer. Try again.",
  FAILED: "The hub could not open a channel. Try again later.",
} as const;

/** A refusal as the card shows it: one plain line, and the hub's own sentence behind a "?". */
export interface FiberChannelError {
  line: string;
  detail: string | null;
}

const LINE_BY_CODE: Readonly<Record<string, string>> = {
  [API_ERROR_CODE.INBOUND_DISABLED]: FIBER_CHANNEL_MESSAGE.DISABLED,
  [API_ERROR_CODE.ASSET_UNAVAILABLE]: FIBER_CHANNEL_MESSAGE.ASSET,
  [API_ERROR_CODE.RATE_LIMITED]: FIBER_CHANNEL_MESSAGE.LIMIT,
  // 409 has two causes, not connected or a channel already: the caller reads the node's channels first.
  [API_ERROR_CODE.CONFLICT]: FIBER_CHANNEL_MESSAGE.CONNECT_FIRST,
  [API_ERROR_CODE.INSUFFICIENT_LIQUIDITY]: FIBER_CHANNEL_MESSAGE.NO_FUNDS,
  [API_ERROR_CODE.MAINTENANCE]: FIBER_CHANNEL_MESSAGE.PAUSED,
  [API_ERROR_CODE.VALIDATION]: FIBER_CHANNEL_MESSAGE.KEY_REFUSED,
  [API_ERROR_CODE.BAD_REQUEST]: FIBER_CHANNEL_MESSAGE.KEY_REFUSED,
  [API_ERROR_CODE.UNAUTHORIZED]: FIBER_CHANNEL_MESSAGE.HUB_UNREACHABLE,
  [HUB_PROXY_ERROR_CODE.HUB_UNAVAILABLE]: FIBER_CHANNEL_MESSAGE.HUB_UNREACHABLE,
  [HUB_PROXY_ERROR_CODE.HUB_TIMEOUT]: FIBER_CHANNEL_MESSAGE.HUB_UNREACHABLE,
};

/** Why the hub did not open the channel, in plain words, with its own sentence as the detail. */
export function fiberChannelError(error: { code: string; message: string }): FiberChannelError {
  const line = LINE_BY_CODE[error.code] ?? FIBER_CHANNEL_MESSAGE.FAILED;
  const detail = error.message.trim();
  return { line, detail: detail && detail !== line ? detail : null };
}
