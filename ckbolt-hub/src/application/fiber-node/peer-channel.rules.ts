import type { PeerChannelsConfig } from "../../config/hub.config";
import type { AssetRegistry } from "../../domain/assets";
import type { FiberChannel } from "../ports/fiber.port";
import type { PeerChannelOffer } from "./fiber-node.contract";
import { isInAsset, isLiveChannel } from "./inbound-channel.rules";

/**
 * The served UDTs nodes may open channels to the hub in with their own tokens, in the registry's order, each with the
 * least funding the hub's node accepts on its own and the commitment delay the hub counts for such a channel.
 */
export function peerChannelOffers(
  settings: Pick<PeerChannelsConfig, "terms">,
  assets: AssetRegistry,
  assumedCommitmentDelayEpochs: number,
): PeerChannelOffer[] {
  return assets.list().flatMap((asset) => {
    const terms = settings.terms[asset.id];
    return terms === undefined ? [] : [{ asset, minAmount: terms.minAmount, assumedCommitmentDelayEpochs }];
  });
}

/**
 * A channel a node opened to the hub's node in a served UDT that takes peer channels, from the time its funding is
 * built until it is closed (opening past the negotiation, ready or closing): it holds a CKB reserve from the hub's
 * node's wallet. A channel still negotiating its funding locks nothing yet and does not count: that includes an open
 * request fnn-hub has not accepted (one below the token's minAmount, say), so a node cannot hide the offers with cheap
 * requests. A channel whose opener fnn does not report counts as the node's (FiberChannel.openedByPeer), so the cap
 * errs on the side of fewer offers.
 */
export function isNodeOpenedPeerChannel(channel: FiberChannel, settings: Pick<PeerChannelsConfig, "terms">, assets: AssetRegistry): boolean {
  if (!channel.openedByPeer || channel.negotiating === true || !isLiveChannel(channel)) return false;
  return assets.list().some((asset) => settings.terms[asset.id] !== undefined && isInAsset(channel, asset));
}

/** How many channels nodes opened to the hub's node in the UDTs that take peer channels, all of them together. */
export const nodeOpenedPeerChannelCount = (
  channels: readonly FiberChannel[],
  settings: Pick<PeerChannelsConfig, "terms">,
  assets: AssetRegistry,
): number => channels.filter((channel) => isNodeOpenedPeerChannel(channel, settings, assets)).length;

/**
 * The offers while nodes have opened fewer such channels than `maxOpen`; none once they have opened as many, or when
 * the hub's node's channels could not be read (null), since the hub cannot then tell how many reserves are taken.
 */
export function offersWithinPeerChannelCap(
  offers: readonly PeerChannelOffer[],
  channels: readonly FiberChannel[] | null,
  settings: PeerChannelsConfig,
  assets: AssetRegistry,
): PeerChannelOffer[] {
  if (channels === null) return [];
  return nodeOpenedPeerChannelCount(channels, settings, assets) < settings.maxOpen ? [...offers] : [];
}
