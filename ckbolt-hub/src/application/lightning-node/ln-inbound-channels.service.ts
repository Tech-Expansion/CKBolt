import { Inject, Injectable, Logger } from "@nestjs/common";
import { CHANNEL_OPEN_KIND, CHANNEL_OPEN_QUEUE_MAX_WAITING } from "../../common/constants/channel-opens.constants";
import { LN_INBOUND_CHANNEL_MEMO } from "../../common/constants/lightning-node.constants";
import { HubError } from "../../common/errors/hub.error";
import { describeError } from "../../common/utils/error.util";
import { rethrowAsHubError } from "../../common/utils/hub-error.util";
import { toLnPubkey } from "../../common/utils/node-id.util";
import { SerialQueue } from "../../common/utils/serial-queue.util";
import type { HubConfig, LnInboundChannelsConfig } from "../../config/hub.config";
import { ChannelOpenCaps, type ChannelOpenRequest } from "../channel-opens/channel-open-caps";
import type { ChannelOpenLog } from "../ports/channel-open-log.port";
import type { Clock } from "../ports/clock.port";
import type { LightningChannelsPort, LnChannel } from "../ports/lightning-channels.port";
import { CHANNEL_OPEN_LOG, CLOCK, HUB_CONFIG, LIGHTNING_CHANNELS } from "../ports/tokens";
import { LIGHTNING_NODE_SERVICE, type LightningNodeService } from "./lightning-node.contract";
import { LIGHTNING_NODE_ERROR } from "./lightning-node.errors";
import { isActiveChannelWith, isInboundLnChannel, onchainSatsNeeded, toLnInboundChannel } from "./ln-inbound-channel.rules";
import type { LnInboundChannel, LnInboundChannelOpening, LnInboundChannels, OpenLnInboundChannelInput } from "./ln-inbound-channels.contract";

/**
 * Inbound Lightning channels (LN_INBOUND_CHANNELS). Before the hub's LND opens one, in this order: inbound channels are
 * on; the client and the wallet are under their sliding-day caps, every client together under the UTC day's count and
 * push budget, and the hub has fewer inbound channels than its cap; the wallet is connected to the hub's LND; the hub has
 * no channel with it yet, open or opening, whoever opened it; and the confirmed on-chain balance covers the channel plus
 * LN_INBOUND_ONCHAIN_RESERVE_SATS. The channel is private, static_remote_key, LN_INBOUND_PUSH_SATS of it on the wallet's
 * side, and carries the inbound memo the cap counts by.
 *
 * Opens run one at a time, so two requests cannot both pass the checks before the first channel shows on the node, and
 * at most CHANNEL_OPEN_QUEUE_MAX_WAITING wait. The channels and the balance are read from the node and the daily counts
 * from the hub's database (ChannelOpenCaps), so all of them survive a restart.
 */
@Injectable()
export class LnInboundChannelsService implements LnInboundChannels {
  private readonly logger = new Logger(LnInboundChannelsService.name);
  private readonly settings: LnInboundChannelsConfig;
  private readonly caps: ChannelOpenCaps;
  private readonly opens = new SerialQueue(CHANNEL_OPEN_QUEUE_MAX_WAITING);

  constructor(
    @Inject(LIGHTNING_CHANNELS) private readonly channels: LightningChannelsPort | null,
    @Inject(LIGHTNING_NODE_SERVICE) private readonly hubNode: LightningNodeService,
    @Inject(CHANNEL_OPEN_LOG) openLog: ChannelOpenLog,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(HUB_CONFIG) config: HubConfig,
  ) {
    this.settings = config.lightningPeers.inboundChannels;
    const { maxPerClientPerDay: perClient, maxPerNodePerDay: perPeer, maxPerDay: perDay } = this.settings;
    const refusals = {
      client: LIGHTNING_NODE_ERROR.tooManyFromClient,
      peer: LIGHTNING_NODE_ERROR.tooManyForWallet,
      day: LIGHTNING_NODE_ERROR.tooManyToday,
    };
    const pushBudget = { satsPerDay: this.settings.pushBudgetSatsPerDay, refusal: LIGHTNING_NODE_ERROR.pushBudgetSpent };
    this.caps = new ChannelOpenCaps(openLog, CHANNEL_OPEN_KIND.LIGHTNING, { perClient, perPeer, perDay }, refusals, pushBudget);
  }

  get enabled(): boolean {
    return this.settings.enabled && this.channels !== null;
  }

  async open(input: OpenLnInboundChannelInput): Promise<LnInboundChannelOpening> {
    const node = this.requireNode();
    const request = { ...input, pubkey: toLnPubkey(input.pubkey) };
    if (this.opens.isFull) throw LIGHTNING_NODE_ERROR.busy();
    return this.opens.run(() => this.checkAndOpen(node, request));
  }

  /** Only the channels the hub opened as inbound channels: its own channels (to the LSP, by hand) stay private. */
  async list(pubkey: string): Promise<LnInboundChannel[]> {
    const channels = await this.readChannels(this.requireNode(), toLnPubkey(pubkey));
    return channels.filter(isInboundLnChannel).map(toLnInboundChannel);
  }

  /** The channel credential exists only while inbound channels are on (LightningModule). */
  private requireNode(): LightningChannelsPort {
    if (!this.settings.enabled || this.channels === null) throw LIGHTNING_NODE_ERROR.inboundDisabled();
    return this.channels;
  }

  private async checkAndOpen(node: LightningChannelsPort, input: OpenLnInboundChannelInput): Promise<LnInboundChannelOpening> {
    this.caps.assertAllowed(this.capRequest(input), this.clock.now());
    const channels = await this.readChannels(node);
    this.assertRoomForAnother(channels);
    await this.assertConnected(node, input.pubkey);
    this.assertNoChannelYet(channels, input.pubkey);
    await this.assertFunds(node);
    return this.openChannel(node, input);
  }

  /** What the caps count of this open: the client, the wallet and the push. */
  private capRequest({ clientKey, pubkey }: OpenLnInboundChannelInput): ChannelOpenRequest {
    return { clientKey, peer: pubkey, pushedSats: this.settings.pushSats };
  }

  private readChannels(node: LightningChannelsPort, peer?: string): Promise<LnChannel[]> {
    return rethrowAsHubError(() => node.listChannels(peer), LIGHTNING_NODE_ERROR.nodeUnavailable);
  }

  private assertRoomForAnother(channels: readonly LnChannel[]): void {
    if (channels.filter(isInboundLnChannel).length >= this.settings.maxOpen) throw LIGHTNING_NODE_ERROR.tooManyOpen();
  }

  /** The 409 names the URIs to connect with; a node that cannot tell them still gets the 409, without them. */
  private async assertConnected(node: LightningChannelsPort, pubkey: string): Promise<void> {
    const connected = await rethrowAsHubError(() => node.isConnected(pubkey), LIGHTNING_NODE_ERROR.nodeUnavailable);
    if (connected) return;
    const uris = await this.hubNode.uris().catch(() => []);
    throw LIGHTNING_NODE_ERROR.notConnected(uris);
  }

  private assertNoChannelYet(channels: readonly LnChannel[], pubkey: string): void {
    if (channels.some((channel) => isActiveChannelWith(channel, pubkey))) throw LIGHTNING_NODE_ERROR.channelExists();
  }

  private async assertFunds(node: LightningChannelsPort): Promise<void> {
    const confirmed = await rethrowAsHubError(() => node.confirmedOnchainSats(), LIGHTNING_NODE_ERROR.nodeUnavailable);
    if (confirmed < onchainSatsNeeded(this.settings)) throw LIGHTNING_NODE_ERROR.insufficientLiquidity();
  }

  /**
   * A refusal LND answers with opened nothing and counts against no cap. An unknown outcome (the call did not come back
   * in time) may have opened the channel, so it counts.
   */
  private async openChannel(node: LightningChannelsPort, input: OpenLnInboundChannelInput): Promise<LnInboundChannelOpening> {
    const { pubkey } = input;
    const { capacitySats, pushSats } = this.settings;
    const args = { peer: pubkey, capacitySats, pushSats, private: true, memo: LN_INBOUND_CHANNEL_MEMO };
    const { fundingTxid } = await node.openChannel(args).catch((error: unknown) => {
      if (!(error instanceof HubError)) {
        this.logger.warn(`LND refused an inbound channel to ${pubkey}: ${describeError(error)}`);
        throw LIGHTNING_NODE_ERROR.openRefused(error);
      }
      this.caps.record(this.capRequest(input), this.clock.now());
      throw error;
    });
    this.caps.record(this.capRequest(input), this.clock.now());
    this.logger.log(`Opening an inbound Lightning channel of ${capacitySats} sats (${pushSats} pushed) to ${pubkey}: funding ${fundingTxid}`);
    return { pubkey, capacitySats, pushSats, fundingTxid };
  }
}
