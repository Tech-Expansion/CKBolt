import { Inject, Injectable } from "@nestjs/common";
import { rethrowAsHubError } from "../../common/utils/hub-error.util";
import type { HubConfig } from "../../config/hub.config";
import type { LightningPort, LnNodeInfo } from "../ports/lightning.port";
import { HUB_CONFIG, LIGHTNING } from "../ports/tokens";
import type { HubLightningNode, LightningNodeService } from "./lightning-node.contract";
import { LIGHTNING_NODE_ERROR } from "./lightning-node.errors";

/**
 * Describes the hub's Lightning node to wallets: its key and network as the node reports them (through the swap
 * credential, which may read them), the URIs to add it as a peer with (LN_PUBLIC_URIS, else the ones LND announces) and
 * the inbound channels it opens.
 */
@Injectable()
export class LightningNodeServiceImpl implements LightningNodeService {
  constructor(
    @Inject(LIGHTNING) private readonly lightning: LightningPort,
    @Inject(HUB_CONFIG) private readonly config: HubConfig,
  ) {}

  async describe(): Promise<HubLightningNode> {
    const info = await this.nodeInfo();
    const { capacitySats, pushSats, enabled } = this.config.lightningPeers.inboundChannels;
    return {
      pubkey: info.pubkey,
      network: info.network,
      uris: this.urisOf(info),
      inbound: { enabled, capacitySats, pushSats },
    };
  }

  async uris(): Promise<string[]> {
    const { publicUris } = this.config.lightningPeers;
    return publicUris.length > 0 ? [...publicUris] : this.urisOf(await this.nodeInfo());
  }

  /** The configured URIs win: LND announces only what it knows of itself (nothing without --externalip). */
  private urisOf(info: LnNodeInfo): string[] {
    const { publicUris } = this.config.lightningPeers;
    return [...(publicUris.length > 0 ? publicUris : info.uris)];
  }

  private nodeInfo(): Promise<LnNodeInfo> {
    return rethrowAsHubError(() => this.lightning.getInfo(), LIGHTNING_NODE_ERROR.nodeUnavailable);
  }
}
