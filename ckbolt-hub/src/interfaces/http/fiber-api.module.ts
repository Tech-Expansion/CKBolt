import { Module, type DynamicModule, type ModuleMetadata } from "@nestjs/common";
import { FiberNodeController } from "./controllers/fiber-node.controller";
import { InboundChannelsController } from "./controllers/inbound-channels.controller";
import { InboundEnabledGuard } from "./guards/inbound-enabled.guard";
import { SwapsPausedGuard } from "./guards/swaps-paused.guard";

export interface FiberApiModuleOptions {
  /** Modules that export FIBER_NODE_SERVICE and INBOUND_CHANNELS. HUB_CONFIG comes from the global HubConfigModule. */
  imports?: ModuleMetadata["imports"];
}

export const FIBER_API_CONTROLLERS = [FiberNodeController, InboundChannelsController];

/**
 * REST API v1 for other Fiber nodes (a browser node): GET /v1/fiber/node and the inbound channels. A module beside
 * ApiModule, so an API without the hub's Fiber node services still starts; ApiModule's global error filter and
 * per-client rate limit cover these routes as well. The composition root registers it as
 *
 *   FiberApiModule.register({ imports: [FiberNodeModule] })
 */
@Module({})
export class FiberApiModule {
  static register(options: FiberApiModuleOptions = {}): DynamicModule {
    return {
      module: FiberApiModule,
      imports: options.imports ?? [],
      controllers: FIBER_API_CONTROLLERS,
      providers: [InboundEnabledGuard, SwapsPausedGuard],
    };
  }
}
