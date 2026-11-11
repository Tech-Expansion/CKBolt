import { LIGHTNING_PUBKEY_PATTERN } from "@/lib/hub/constants";
import {
  API_ERROR_CODE,
  HUB_PROXY_ERROR_CODE,
  type LightningInboundChannelDto,
  type LightningNodeDto,
  type LnChannelState,
} from "@/lib/hub/contract";
import { LN_WALLET_MESSAGE } from "./messages";

/**
 * A Lightning channel from the hub (phase-3c plan F3.1). LDK wallets such as Alby Hub on Mutinynet can pay the hub only
 * over a channel of their own with it. The wallet adds the hub's node as a peer (the hub cannot dial it), then the
 * visitor pastes the wallet's node id and asks; the hub opens a private channel and pushes part of it to the wallet's
 * side. Plain logic here; the guide's hub card shows it (components/app/guide/hub-channel.tsx).
 */

/** Where the wallet's channel with the hub stands: none yet, or the state of the one the card shows. */
export type HubChannelStatus = "none" | LnChannelState;

/** The order the card prefers: a ready channel over one opening, over one closing. */
const SHOWN_FIRST: readonly LnChannelState[] = ["ready", "opening", "closing"];

/** The channel the card shows, or null when the wallet has none with the hub. */
export function shownHubChannel(channels: readonly LightningInboundChannelDto[]): LightningInboundChannelDto | null {
  for (const state of SHOWN_FIRST) {
    const channel = channels.find((c) => c.state === state);
    if (channel) return channel;
  }
  return null;
}

/**
 * Where things stand: the shown channel's state, or `opening` right after the hub took a request it does not list
 * yet, or `none`.
 */
export const hubChannelStatus = (channel: LightningInboundChannelDto | null, requested: boolean): HubChannelStatus =>
  channel?.state ?? (requested ? "opening" : "none");

/** A pasted node id as the hub takes it (66 hex characters, lower case), or null when it is not one. */
export function readNodeId(text: string): string | null {
  const key = text.trim().toLowerCase();
  return LIGHTNING_PUBKEY_PATTERN.test(key) ? key : null;
}

/** The hub opens channels to wallets, and names an address a wallet can add as a peer. */
export const hubOffersChannel = (node: LightningNodeDto | null): node is LightningNodeDto =>
  node !== null && node.inbound.enabled && node.uris.length > 0;

/** A refusal as the card shows it: one plain line, and the hub's own sentence behind a "?". */
export interface HubChannelError {
  line: string;
  detail: string | null;
}

const LINE_BY_CODE: Readonly<Record<string, string>> = {
  [API_ERROR_CODE.INBOUND_DISABLED]: LN_WALLET_MESSAGE.CHANNEL_DISABLED,
  [API_ERROR_CODE.RATE_LIMITED]: LN_WALLET_MESSAGE.CHANNEL_LIMIT,
  // 409 has two causes; the caller reads the wallet's channels first and shows one if it has it.
  [API_ERROR_CODE.CONFLICT]: LN_WALLET_MESSAGE.CHANNEL_ADD_PEER,
  [API_ERROR_CODE.INSUFFICIENT_LIQUIDITY]: LN_WALLET_MESSAGE.CHANNEL_NO_FUNDS,
  [API_ERROR_CODE.MAINTENANCE]: LN_WALLET_MESSAGE.CHANNEL_PAUSED,
  [API_ERROR_CODE.VALIDATION]: LN_WALLET_MESSAGE.CHANNEL_KEY_REFUSED,
  [API_ERROR_CODE.BAD_REQUEST]: LN_WALLET_MESSAGE.CHANNEL_KEY_REFUSED,
  [API_ERROR_CODE.UNAUTHORIZED]: LN_WALLET_MESSAGE.CHANNEL_HUB_UNREACHABLE,
  [HUB_PROXY_ERROR_CODE.HUB_UNAVAILABLE]: LN_WALLET_MESSAGE.CHANNEL_HUB_UNREACHABLE,
  [HUB_PROXY_ERROR_CODE.HUB_TIMEOUT]: LN_WALLET_MESSAGE.CHANNEL_HUB_UNREACHABLE,
};

/** Why the hub did not open a channel, in plain words, with its own sentence as the detail. */
export function hubChannelError(error: { code: string; message: string }): HubChannelError {
  const line = LINE_BY_CODE[error.code] ?? LN_WALLET_MESSAGE.CHANNEL_FAILED;
  const detail = error.message.trim();
  return { line, detail: detail && detail !== line ? detail : null };
}
