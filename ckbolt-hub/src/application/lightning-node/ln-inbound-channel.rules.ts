import { LN_CHANNEL_STATE, LN_INBOUND_CHANNEL_MEMO } from "../../common/constants/lightning-node.constants";
import type { LnInboundChannelsConfig } from "../../config/hub.config";
import type { LnChannel } from "../ports/lightning-channels.port";
import type { LnInboundChannel } from "./ln-inbound-channels.contract";

/** Pure rules of inbound Lightning channels: which of the node's channels count as what, and what an open needs. */

/** An inbound channel as the hub opens them: opened by the hub's LND with the inbound memo, in any state. */
export const isInboundLnChannel = (channel: LnChannel): boolean => !channel.openedByPeer && channel.memo === LN_INBOUND_CHANNEL_MEMO;

/** A channel with `pubkey` that is open or opening, whoever opened it: the wallet does not get a second one. */
export const isActiveChannelWith = (channel: LnChannel, pubkey: string): boolean =>
  channel.peer === pubkey && channel.state !== LN_CHANNEL_STATE.CLOSING;

/** Confirmed on-chain sats one open needs: the channel itself plus the reserve the hub keeps. */
export const onchainSatsNeeded = (settings: Pick<LnInboundChannelsConfig, "capacitySats" | "onchainReserveSats">): bigint =>
  settings.capacitySats + settings.onchainReserveSats;

/** A channel as the wallet sees it: the hub's side is what the wallet can still pay the hub over it. */
export const toLnInboundChannel = (channel: LnChannel): LnInboundChannel => ({
  channelPoint: channel.channelPoint,
  state: channel.state,
  capacitySats: channel.capacitySats,
  hubBalanceSats: channel.localSats,
  walletBalanceSats: channel.remoteSats,
});
