import type { GetChannelsResult, GetPendingChannelsResult } from "lightning";
import type { LnChannel, LnChannelOpening, OpenLnChannelArgs } from "../../application/ports/lightning-channels.port";
import { LN_CHANNEL_STATE } from "../../common/constants/lightning-node.constants";
import { LND_OPEN_CHANNEL, LND_STATIC_REMOTE_KEY_COMMITMENT } from "../../common/constants/lnd.constants";
import { reverseHexBytes } from "../../common/utils/hex.util";
import type { OpenChannelSyncRequest, RawChannelPoint } from "./lnd-open-channel";

/** Pure mapping between the `lightning` package's channel results and LightningChannelsPort types. Sats become bigint. */

/** getChannels also returns the channel's memo as `description`, which the package's typings leave out. */
type ListedChannel = GetChannelsResult["channels"][number] & { description?: string };
type PendingChannel = GetPendingChannelsResult["pending_channels"][number];

/** The funding outpoint as LND writes a channel point. */
const channelPointOf = (transactionId: string, vout: number): string => `${transactionId}:${vout}`;

/** A channel ListChannels lists: open. */
export const toOpenLnChannel = (channel: ListedChannel): LnChannel => ({
  channelPoint: channelPointOf(channel.transaction_id, channel.transaction_vout),
  peer: channel.partner_public_key,
  state: LN_CHANNEL_STATE.READY,
  capacitySats: BigInt(channel.capacity),
  localSats: BigInt(channel.local_balance),
  remoteSats: BigInt(channel.remote_balance),
  private: channel.is_private,
  openedByPeer: channel.is_partner_initiated,
  memo: channel.description ?? null,
});

/** A channel PendingChannels lists: opening, or closing (waiting for its close, or force closing). */
export const toPendingLnChannel = (channel: PendingChannel): LnChannel => ({
  channelPoint: channelPointOf(channel.transaction_id, channel.transaction_vout),
  peer: channel.partner_public_key,
  state: channel.is_opening ? LN_CHANNEL_STATE.OPENING : LN_CHANNEL_STATE.CLOSING,
  capacitySats: BigInt(channel.capacity),
  localSats: BigInt(channel.local_balance),
  remoteSats: BigInt(channel.remote_balance),
  private: channel.is_private === true,
  openedByPeer: channel.is_partner_initiated === true,
  memo: channel.description ?? null,
});

/**
 * The OpenChannelSync request of a channel the hub opens to a wallet: static_remote_key (no anchors), funded from
 * confirmed outputs only, with the fee aimed at the package's usual confirmation target.
 */
export const toOpenChannelRequest = (args: OpenLnChannelArgs): OpenChannelSyncRequest => ({
  node_pubkey: Buffer.from(args.peer, "hex"),
  local_funding_amount: args.capacitySats.toString(),
  push_sat: args.pushSats.toString(),
  private: args.private,
  commitment_type: LND_STATIC_REMOTE_KEY_COMMITMENT,
  memo: args.memo,
  target_conf: LND_OPEN_CHANNEL.CONF_TARGET_BLOCKS,
  min_confs: LND_OPEN_CHANNEL.MIN_CONFS,
  spend_unconfirmed: false,
});

/** The funding txid as block explorers show it: LND sends its bytes in internal (reversed) order, or the hex itself. */
export function toChannelOpening(point: RawChannelPoint): LnChannelOpening {
  const fromBytes = point.funding_txid_bytes && point.funding_txid_bytes.length > 0 ? reverseHexBytes(point.funding_txid_bytes.toString("hex")) : null;
  const fundingTxid = point.funding_txid_str || fromBytes;
  if (!fundingTxid) throw new Error("LND sent a channel point without a funding txid");
  return { fundingTxid, outputIndex: point.output_index };
}
