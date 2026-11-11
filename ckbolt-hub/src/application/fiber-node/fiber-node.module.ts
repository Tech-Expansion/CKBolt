import { Module } from "@nestjs/common";
import { FIBER_NODE_SERVICE } from "./fiber-node.contract";
import { FiberNodeServiceImpl } from "./fiber-node.service";
import { INBOUND_CHANNELS } from "./inbound-channels.contract";
import { InboundChannelsService } from "./inbound-channels.service";

/**
 * The hub's Fiber node for other Fiber nodes: FIBER_NODE_SERVICE (its description) and INBOUND_CHANNELS. Needs the
 * global FIBER, SWAP_STORE, CHANNEL_OPEN_LOG and INBOUND_OPEN_STORE (infrastructure modules) and HUB_CONFIG, ASSETS,
 * CLOCK (HubConfigModule).
 */
@Module({
  providers: [
    { provide: FIBER_NODE_SERVICE, useClass: FiberNodeServiceImpl },
    { provide: INBOUND_CHANNELS, useClass: InboundChannelsService },
  ],
  exports: [FIBER_NODE_SERVICE, INBOUND_CHANNELS],
})
export class FiberNodeModule {}
