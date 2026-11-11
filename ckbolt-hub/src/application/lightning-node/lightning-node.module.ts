import { Module } from "@nestjs/common";
import { LIGHTNING_NODE_SERVICE } from "./lightning-node.contract";
import { LightningNodeServiceImpl } from "./lightning-node.service";
import { LN_INBOUND_CHANNELS } from "./ln-inbound-channels.contract";
import { LnInboundChannelsService } from "./ln-inbound-channels.service";

/**
 * The hub's Lightning node for Lightning wallets: LIGHTNING_NODE_SERVICE (its description) and LN_INBOUND_CHANNELS.
 * Needs the global LIGHTNING and LIGHTNING_CHANNELS (LightningModule) and HUB_CONFIG, CLOCK (HubConfigModule).
 */
@Module({
  providers: [
    { provide: LIGHTNING_NODE_SERVICE, useClass: LightningNodeServiceImpl },
    { provide: LN_INBOUND_CHANNELS, useClass: LnInboundChannelsService },
  ],
  exports: [LIGHTNING_NODE_SERVICE, LN_INBOUND_CHANNELS],
})
export class LightningNodeModule {}
