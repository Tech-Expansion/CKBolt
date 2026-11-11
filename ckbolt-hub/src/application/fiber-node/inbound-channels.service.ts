import { Inject, Injectable, Logger } from "@nestjs/common";
import { CHANNEL_OPEN_KIND, CHANNEL_OPEN_QUEUE_MAX_WAITING } from "../../common/constants/channel-opens.constants";
import { HubError } from "../../common/errors/hub.error";
import { rethrowAsHubError } from "../../common/utils/hub-error.util";
import { toNodeId } from "../../common/utils/node-id.util";
import { SerialQueue } from "../../common/utils/serial-queue.util";
import type { HubConfig, InboundChannelsConfig } from "../../config/hub.config";
import type { AssetRegistry } from "../../domain/assets";
import type { FiberAssetId } from "../../domain/types";
import { ChannelOpenCaps, type ChannelOpenRequest } from "../channel-opens/channel-open-caps";
import type { ChannelOpenLog } from "../ports/channel-open-log.port";
import type { Clock } from "../ports/clock.port";
import type { FiberChannel, FiberPort } from "../ports/fiber.port";
import type { InboundOpenStore } from "../ports/inbound-open-store.port";
import type { SwapStore } from "../ports/swap-store.port";
import { ASSETS, CHANNEL_OPEN_LOG, CLOCK, FIBER, HUB_CONFIG, INBOUND_OPEN_STORE, SWAP_STORE } from "../ports/tokens";
import type { InboundOffer } from "./fiber-node.contract";
import { FIBER_NODE_ERROR } from "./fiber-node.errors";
import { canFundInbound, inboundOffers, isInAsset, isInboundChannel, isOpenedByHub } from "./inbound-channel.rules";
import type { InboundChannel, InboundChannelOpening, InboundChannels, OpenInboundChannelInput } from "./inbound-channels.contract";
import { abandonStaleInboundOpens, InboundOpenRequests } from "./stale-inbound-opens";

/** What the caps count of an open: the client and the node; the funding stays the hub's, so nothing is pushed. */
const capRequest = ({ clientKey, nodeId }: OpenInboundChannelInput): ChannelOpenRequest => ({ clientKey, peer: nodeId, pushedSats: 0n });

/**
 * Inbound channels (INBOUND_CHANNELS). Before the hub's fnn opens one, in this order: the asset has an amount, the client
 * and the node are under their sliding-day caps and every client together under the UTC day's, the node is connected,
 * the hub has no channel in the asset to it yet (open or opening), the hub has fewer inbound channels than its cap, and
 * the funding fits in inboundFundingRoom: the hub's Fiber payout liquidity for swaps in the asset, inbound channels left
 * out, less what its inbound channels in the asset hold.
 * The funding comes from the fnn wallet, which the hub cannot read: the check keeps inbound channels from growing past
 * what the hub keeps free to pay out swaps.
 *
 * Opens run one at a time, so two requests cannot both pass the checks before the first channel shows on the node, and
 * at most CHANNEL_OPEN_QUEUE_MAX_WAITING wait. The open channels are read from the node, and the daily counts
 * (ChannelOpenCaps, shared with inbound Lightning channels) and the opens it may abandon unaccepted (InboundOpenStore)
 * from the hub's database, so all of them survive a restart.
 */
@Injectable()
export class InboundChannelsService implements InboundChannels {
  private readonly logger = new Logger(InboundChannelsService.name);
  private readonly settings: InboundChannelsConfig;
  private readonly caps: ChannelOpenCaps;
  private readonly opens = new SerialQueue(CHANNEL_OPEN_QUEUE_MAX_WAITING);
  /** The opens the hub asked for, the only ones it abandons unaccepted (in its database: stale-inbound-opens.ts). */
  private readonly requested: InboundOpenRequests;

  constructor(
    @Inject(FIBER) private readonly fiber: FiberPort,
    @Inject(SWAP_STORE) private readonly store: SwapStore,
    @Inject(ASSETS) private readonly assets: AssetRegistry,
    @Inject(CHANNEL_OPEN_LOG) openLog: ChannelOpenLog,
    @Inject(INBOUND_OPEN_STORE) inboundOpens: InboundOpenStore,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(HUB_CONFIG) private readonly config: HubConfig,
  ) {
    this.settings = config.fiberPeers.inboundChannels;
    this.requested = new InboundOpenRequests(inboundOpens, this.settings.acceptTimeoutSeconds);
    const { maxPerClientPerDay: perClient, maxPerNodePerDay: perPeer, maxPerDay: perDay } = this.settings;
    // The funding stays on the hub's side: an inbound Fiber channel pushes nothing, so it has no push budget.
    this.caps = new ChannelOpenCaps(openLog, CHANNEL_OPEN_KIND.FIBER, { perClient, perPeer, perDay }, {
      client: FIBER_NODE_ERROR.tooManyFromClient,
      peer: FIBER_NODE_ERROR.tooManyForNode,
      day: FIBER_NODE_ERROR.tooManyToday,
    });
  }

  get enabled(): boolean {
    return this.settings.enabled;
  }

  async open(input: OpenInboundChannelInput): Promise<InboundChannelOpening> {
    if (!this.enabled) throw FIBER_NODE_ERROR.inboundDisabled();
    const offer = this.offerFor(input.asset);
    const request = { ...input, nodeId: toNodeId(input.nodeId) };
    if (this.opens.isFull) throw FIBER_NODE_ERROR.busy();
    return this.opens.run(() => this.checkAndOpen(request, offer));
  }

  async list(nodeId: string): Promise<InboundChannel[]> {
    const channels = await this.readChannelsDroppingStale(toNodeId(nodeId));
    return channels.filter(isOpenedByHub).flatMap((channel) => this.toInboundChannel(channel));
  }

  /** The channel as an inbound channel; none when it is in an asset the hub does not serve. */
  private toInboundChannel(channel: FiberChannel & { status: InboundChannel["state"] }): InboundChannel[] {
    const asset = this.assets.byTypeScript(channel.udtTypeScript);
    if (!asset) return [];
    const { channelId, status: state, localBalance: hubBalance, remoteBalance: nodeBalance } = channel;
    return [{ channelId, asset: asset.id, state, hubBalance, nodeBalance }];
  }

  private offerFor(assetId: FiberAssetId): InboundOffer {
    const offer = inboundOffers(this.settings, this.assets).find((candidate) => candidate.asset.id === assetId);
    if (!offer) throw FIBER_NODE_ERROR.assetNotOffered(assetId);
    return offer;
  }

  private async checkAndOpen(input: OpenInboundChannelInput, offer: InboundOffer): Promise<InboundChannelOpening> {
    this.caps.assertAllowed(capRequest(input), this.clock.now());
    await this.assertConnected(input.nodeId);
    const channels = await this.readChannelsDroppingStale();
    this.assertNoChannelYet(channels, input.nodeId, offer);
    this.assertRoomForAnother(channels);
    this.assertLiquidityFor(channels, offer);
    return this.openChannel(input, offer);
  }

  private async assertConnected(nodeId: string): Promise<void> {
    const connected = await rethrowAsHubError(() => this.fiber.isConnected(nodeId), FIBER_NODE_ERROR.nodeUnavailable);
    if (!connected) throw FIBER_NODE_ERROR.notConnected();
  }

  private readChannels(peer?: string): Promise<FiberChannel[]> {
    return rethrowAsHubError(() => this.fiber.listChannelDetails(peer), FIBER_NODE_ERROR.nodeUnavailable);
  }

  /** The node's channels, after abandoning its own inbound opens nobody accepted in time (stale-inbound-opens.ts). */
  private async readChannelsDroppingStale(peer?: string): Promise<FiberChannel[]> {
    const channels = await this.readChannels(peer);
    return abandonStaleInboundOpens(this.fiber, this.requested, { channels, peer }, this.clock.now(), this.logger);
  }

  /** One channel per node and asset: any live channel the hub's node opened to it, inbound or not, ready or not. */
  private assertNoChannelYet(channels: readonly FiberChannel[], nodeId: string, { asset }: InboundOffer): void {
    if (channels.some((channel) => channel.peer === nodeId && isOpenedByHub(channel) && isInAsset(channel, asset))) {
      throw FIBER_NODE_ERROR.channelExists(asset.id);
    }
  }

  private assertRoomForAnother(channels: readonly FiberChannel[]): void {
    if (channels.filter(isInboundChannel).length >= this.settings.maxOpen) throw FIBER_NODE_ERROR.tooManyOpen();
  }

  private assertLiquidityFor(channels: readonly FiberChannel[], offer: InboundOffer): void {
    if (!canFundInbound(channels, this.store.listOpenSwaps(), offer, this.config.swaps.fiberMaxFeeBps)) {
      throw FIBER_NODE_ERROR.insufficientLiquidity(offer);
    }
  }

  /**
   * A refusal the node answers with opened nothing and counts against no cap. An unknown outcome (the node did not
   * answer in time) may have started the channel, so it counts.
   */
  private async openChannel(input: OpenInboundChannelInput, offer: InboundOffer): Promise<InboundChannelOpening> {
    const { nodeId } = input;
    const args = { peer: nodeId, fundingAmount: offer.amount, udtTypeScript: offer.asset.udtTypeScript, public: false };
    const { temporaryChannelId } = await this.fiber.openChannel(args).catch((error: unknown) => {
      if (!(error instanceof HubError)) throw FIBER_NODE_ERROR.openRefused(error);
      this.caps.record(capRequest(input), this.clock.now());
      throw error;
    });
    this.caps.record(capRequest(input), this.clock.now());
    this.requested.remember(temporaryChannelId, nodeId, this.clock.now());
    this.logger.log(`Opening an inbound ${offer.asset.id} channel of ${offer.amount} base units to ${nodeId}`);
    return { nodeId, asset: offer.asset.id, fundingAmount: offer.amount, temporaryChannelId };
  }
}
