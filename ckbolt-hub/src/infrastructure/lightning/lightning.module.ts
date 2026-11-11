import { Global, Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import type { Clock } from "../../application/ports/clock.port";
import type { LightningChannelsPort } from "../../application/ports/lightning-channels.port";
import type { LightningPort } from "../../application/ports/lightning.port";
import { CLOCK, DEMO_LIGHTNING, HUB_CONFIG, LIGHTNING, LIGHTNING_CHANNELS } from "../../application/ports/tokens";
import type { HubConfig, LndConnection } from "../../config/hub.config";
import { connectLnd } from "./lnd-connection";
import { LndChannelsAdapter } from "./lnd-channels.adapter";
import { LndLightningAdapter } from "./lnd-lightning.adapter";

function createLndAdapter(connection: LndConnection, config: HubConfig, clock: Clock): LndLightningAdapter {
  const settings = {
    network: config.bitcoin.network,
    name: connection.grpcHost,
    maxPaymentParts: config.swaps.lnMaxPaymentParts,
    invoiceRouteHints: config.swaps.lnInvoiceRouteHints,
  };
  return new LndLightningAdapter(connectLnd(connection), settings, clock);
}

/** The hub LND through the channel-only macaroon, only while inbound channels are on (the config has it only then). */
function createChannelsAdapter(config: HubConfig, clock: Clock): LndChannelsAdapter | null {
  const { inboundChannels, lnd } = config.lightningPeers;
  return inboundChannels.enabled && lnd ? new LndChannelsAdapter(connectLnd(lnd), clock) : null;
}

/**
 * Provides LIGHTNING (the hub's LND, `config.lnd`), LIGHTNING_CHANNELS (the same LND through the channel-only
 * credential, `config.lightningPeers.lnd`, or null when inbound channels are off) and DEMO_LIGHTNING (the demo wallet's
 * LND, `config.demo.lnd`, or null when the demo is off) to every module. Credentials are read at start-up, so a missing
 * file fails fast.
 */
@Global()
@Module({
  providers: [
    {
      provide: LIGHTNING,
      useFactory: (config: HubConfig, clock: Clock): LightningPort => createLndAdapter(config.lnd, config, clock),
      inject: [HUB_CONFIG, CLOCK],
    },
    {
      provide: LIGHTNING_CHANNELS,
      useFactory: (config: HubConfig, clock: Clock): LightningChannelsPort | null => createChannelsAdapter(config, clock),
      inject: [HUB_CONFIG, CLOCK],
    },
    {
      provide: DEMO_LIGHTNING,
      useFactory: (config: HubConfig, clock: Clock): LightningPort | null =>
        config.demo.enabled && config.demo.lnd ? createLndAdapter(config.demo.lnd, config, clock) : null,
      inject: [HUB_CONFIG, CLOCK],
    },
  ],
  exports: [LIGHTNING, LIGHTNING_CHANNELS, DEMO_LIGHTNING],
})
export class LightningModule implements OnApplicationShutdown {
  constructor(
    @Inject(LIGHTNING) private readonly hubNode: LightningPort,
    @Inject(LIGHTNING_CHANNELS) private readonly channelsNode: LightningChannelsPort | null,
    @Inject(DEMO_LIGHTNING) private readonly demoNode: LightningPort | null,
  ) {}

  /**
   * Application shutdown is the last lifecycle step: the swap scheduler has stopped (onModuleDestroy) and the HTTP server
   * has closed, so no swap or request is mid-call here.
   */
  onApplicationShutdown(): void {
    for (const node of [this.hubNode, this.channelsNode, this.demoNode]) {
      if (node instanceof LndLightningAdapter || node instanceof LndChannelsAdapter) node.close();
    }
  }
}
