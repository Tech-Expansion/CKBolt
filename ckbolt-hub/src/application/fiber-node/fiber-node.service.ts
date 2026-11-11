import { Inject, Injectable, Logger } from "@nestjs/common";
import { describeError } from "../../common/utils/error.util";
import { rethrowAsHubError } from "../../common/utils/hub-error.util";
import type { HubConfig } from "../../config/hub.config";
import type { AssetRegistry } from "../../domain/assets";
import type { FiberChannel, FiberPort } from "../ports/fiber.port";
import type { SwapStore } from "../ports/swap-store.port";
import { ASSETS, FIBER, HUB_CONFIG, SWAP_STORE } from "../ports/tokens";
import type { FiberNodeService, HubFiberNode, InboundOffer, InboundOfferState } from "./fiber-node.contract";
import { FIBER_NODE_ERROR } from "./fiber-node.errors";
import { canFundInbound, inboundOffers } from "./inbound-channel.rules";
import { offersWithinPeerChannelCap, peerChannelOffers } from "./peer-channel.rules";

/**
 * Describes the hub's Fiber node to other Fiber nodes: its id and network as the node reports them, the public addresses
 * from the config (never derived from the node, which may sit behind NAT or a TLS proxy), the assets the hub swaps, the
 * inbound channels it offers, each with whether its payout liquidity lets it fund one now, and the UDTs a node may open
 * its own channel to the hub in while fewer such channels are open than the config allows. Both read the node's
 * channels from one listing per request.
 */
@Injectable()
export class FiberNodeServiceImpl implements FiberNodeService {
  private readonly logger = new Logger(FiberNodeServiceImpl.name);

  constructor(
    @Inject(FIBER) private readonly fiber: FiberPort,
    @Inject(ASSETS) private readonly assets: AssetRegistry,
    @Inject(HUB_CONFIG) private readonly config: HubConfig,
    @Inject(SWAP_STORE) private readonly store: SwapStore,
  ) {}

  async describe(): Promise<HubFiberNode> {
    const info = await rethrowAsHubError(() => this.fiber.getInfo(), FIBER_NODE_ERROR.nodeUnavailable);
    const { publicAddresses, inboundChannels, peerChannels } = this.config.fiberPeers;
    const inbound = inboundOffers(inboundChannels, this.assets);
    const peers = peerChannelOffers(peerChannels, this.assets, this.config.swaps.fiberPeerChannelCommitmentDelayEpochs);
    const channels = inbound.length === 0 && peers.length === 0 ? [] : await this.readChannels();
    return {
      nodeId: info.nodeId,
      network: info.network,
      addresses: { p2p: [...publicAddresses.p2p], ws: [...publicAddresses.ws] },
      assets: this.assets.list(),
      inbound: { enabled: inboundChannels.enabled, offers: this.offerStates(inbound, channels) },
      peerChannels: offersWithinPeerChannelCap(peers, channels, peerChannels, this.assets),
    };
  }

  /** The node's channels in every state, or null when they cannot be read: the offers needing them then fail closed. */
  private async readChannels(): Promise<FiberChannel[] | null> {
    try {
      return await this.fiber.listChannelDetails();
    } catch (error) {
      this.logger.warn(
        `Could not list the Fiber node's channels: GET /v1/fiber/node says inbound funding is unknown and offers no peer channels: ${describeError(error)}`,
      );
      return null;
    }
  }

  /** The offers with whether each is fundable now; null for all when the node's channels could not be read. */
  private offerStates(offers: readonly InboundOffer[], channels: readonly FiberChannel[] | null): InboundOfferState[] {
    if (offers.length === 0) return [];
    if (!channels) return offers.map((offer) => ({ ...offer, fundable: null }));
    const openSwaps = this.store.listOpenSwaps();
    const { fiberMaxFeeBps } = this.config.swaps;
    return offers.map((offer) => ({ ...offer, fundable: canFundInbound(channels, openSwaps, offer, fiberMaxFeeBps) }));
  }
}
