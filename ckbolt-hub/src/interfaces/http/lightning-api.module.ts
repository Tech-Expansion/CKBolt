import { Module, type DynamicModule, type ModuleMetadata } from "@nestjs/common";
import { LightningInboundChannelsController } from "./controllers/lightning-inbound-channels.controller";
import { LightningNodeController } from "./controllers/lightning-node.controller";
import { LnInboundEnabledGuard } from "./guards/ln-inbound-enabled.guard";
import { SwapsPausedGuard } from "./guards/swaps-paused.guard";

export interface LightningApiModuleOptions {
  /** Modules that export LIGHTNING_NODE_SERVICE and LN_INBOUND_CHANNELS. HUB_CONFIG comes from the global HubConfigModule. */
  imports?: ModuleMetadata["imports"];
}

export const LIGHTNING_API_CONTROLLERS = [LightningNodeController, LightningInboundChannelsController];

/**
 * REST API v1 for Lightning wallets: GET /v1/lightning/node and the inbound channels. A module beside ApiModule, so an
 * API without the hub's Lightning node services still starts; ApiModule's global error filter and per-client rate limit
 * cover these routes as well, and the app's proxy secret middleware every route. The composition root registers it as
 *
 *   LightningApiModule.register({ imports: [LightningNodeModule] })
 */
@Module({})
export class LightningApiModule {
  static register(options: LightningApiModuleOptions = {}): DynamicModule {
    return {
      module: LightningApiModule,
      imports: options.imports ?? [],
      controllers: LIGHTNING_API_CONTROLLERS,
      providers: [LnInboundEnabledGuard, SwapsPausedGuard],
    };
  }
}
