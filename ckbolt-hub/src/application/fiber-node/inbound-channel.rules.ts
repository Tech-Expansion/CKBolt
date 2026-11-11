import { FIBER_CHANNEL_STATUS } from "../../common/constants/fiber-node.constants";
import { sumOf } from "../../common/utils/amount.util";
import { sameAssetScript } from "../../common/utils/script.util";
import type { InboundChannelsConfig } from "../../config/hub.config";
import type { AssetRegistry } from "../../domain/assets";
import { availableFiberPayout, type PayoutReservation } from "../../domain/pricing";
import type { FiberAsset } from "../../domain/types";
import type { FiberChannel } from "../ports/fiber.port";
import type { InboundOffer } from "./fiber-node.contract";
import type { InboundChannelState } from "./inbound-channels.contract";

/** Pure rules of inbound channels: what the hub offers, and which of its node's channels count as what. */

/**
 * The served assets the hub has an inbound channel amount for, in the registry's order, each UDT with the auto-accept
 * amount a browser node whitelists for it; none when inbound is off.
 */
export function inboundOffers(settings: InboundChannelsConfig, assets: AssetRegistry): InboundOffer[] {
  if (!settings.enabled) return [];
  return assets.list().flatMap((asset) => {
    const amount = settings.amounts[asset.id];
    if (amount === undefined) return [];
    const autoAcceptAmount = asset.udtTypeScript === null ? null : (settings.autoAcceptAmounts[asset.id] ?? amount);
    return [{ asset, amount, autoAcceptAmount }];
  });
}

/** A channel that is not closed. */
export const isLiveChannel = (channel: FiberChannel): channel is FiberChannel & { status: InboundChannelState } =>
  channel.status !== FIBER_CHANNEL_STATUS.CLOSED;

/** A live channel the hub's node opened and funded itself (its routing channels as well as inbound channels). */
export const isOpenedByHub = (channel: FiberChannel): channel is FiberChannel & { status: InboundChannelState } =>
  isLiveChannel(channel) && !channel.openedByPeer;

/** An inbound channel as the hub opens them: live, opened by the hub's node, and private (its routing channels are public). */
export const isInboundChannel = (channel: FiberChannel): boolean => isOpenedByHub(channel) && !channel.public;

/**
 * A live private channel, which pays only its own peer: the hub's inbound channels, and the channels nodes open to the
 * hub privately with their own tokens (FIBER_ASSETS peerChannels), whose hub side grows as they pay the hub.
 */
export const paysOnlyItsPeer = (channel: FiberChannel): boolean => isLiveChannel(channel) && !channel.public;

/** A channel in `asset`: both CKB (no type script) or the same UDT type script. */
export const isInAsset = (channel: FiberChannel, asset: FiberAsset): boolean => sameAssetScript(channel.udtTypeScript, asset.udtTypeScript);

/**
 * How much more the hub may put into inbound channels in `asset`: its Fiber payout liquidity for swaps in the asset
 * (what a new ln_to_fiber quote could get, from every channel but its private ones, which pay only their own node: its
 * inbound channels and the channels nodes opened to it) less what its inbound channels in the asset hold already. So the inbound channels together never hold more than the
 * hub keeps free for swap payouts; the fnn wallet they are funded from cannot be read over fnn's RPC.
 */
export function inboundFundingRoom(
  channels: readonly FiberChannel[],
  openSwaps: readonly PayoutReservation[],
  asset: FiberAsset,
  maxFeeBps: number,
): bigint {
  const forSwaps = availableFiberPayout(channels.filter((channel) => !paysOnlyItsPeer(channel)), openSwaps, asset, maxFeeBps);
  const inInbound = sumOf(channels.filter((channel) => isInboundChannel(channel) && isInAsset(channel, asset)).map((channel) => channel.localBalance));
  return forSwaps - inInbound;
}

/** Whether the hub can fund `offer` now without its inbound channels outgrowing what it keeps for swap payouts. */
export const canFundInbound = (
  channels: readonly FiberChannel[],
  openSwaps: readonly PayoutReservation[],
  offer: InboundOffer,
  maxFeeBps: number,
): boolean => inboundFundingRoom(channels, openSwaps, offer.asset, maxFeeBps) >= offer.amount;
