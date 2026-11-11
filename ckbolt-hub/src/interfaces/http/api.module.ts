import { Module, type DynamicModule, type ModuleMetadata } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { AssetsController } from "./controllers/assets.controller";
import { DemoController } from "./controllers/demo.controller";
import { HealthController } from "./controllers/health.controller";
import { QuotesController } from "./controllers/quotes.controller";
import { SwapsController } from "./controllers/swaps.controller";
import { HubExceptionFilter } from "./filters/hub-exception.filter";
import { DemoEnabledGuard } from "./guards/demo-enabled.guard";
import { DemoRateLimitGuard } from "./guards/demo-rate-limit.guard";
import { RateLimitGuard } from "./guards/rate-limit.guard";
import { SwapsPausedGuard } from "./guards/swaps-paused.guard";
import { ApiPresenter } from "./presenters/api.presenter";

export interface ApiModuleOptions {
  /**
   * Modules that export PRICING_SERVICE, SWAP_ENGINE, DEMO_WALLET and HEALTH_SERVICE (unless they are global).
   * HUB_CONFIG, CLOCK and ASSETS come from the global HubConfigModule.
   */
  imports?: ModuleMetadata["imports"];
}

export const API_CONTROLLERS = [HealthController, AssetsController, QuotesController, SwapsController, DemoController];

/**
 * REST API v1: controllers under /v1, the global error filter and the global per-client rate limit. Request bodies and
 * ids are validated per route with ZodValidationPipe. The proxy secret (HUB_PROXY_SECRET) is not checked here but by
 * the app's first Express middleware, before any body is parsed (configureHttpApp, http-app.ts). The composition root
 * (AppModule) passes the service modules:
 *
 *   ApiModule.register({ imports: [PricingModule, SwapsModule, DemoModule.register({ imports: [SwapsModule] }), HealthModule] })
 */
@Module({})
export class ApiModule {
  static register(options: ApiModuleOptions = {}): DynamicModule {
    return {
      module: ApiModule,
      imports: options.imports ?? [],
      controllers: API_CONTROLLERS,
      providers: [
        ApiPresenter,
        DemoEnabledGuard,
        DemoRateLimitGuard,
        SwapsPausedGuard,
        { provide: APP_GUARD, useClass: RateLimitGuard },
        { provide: APP_FILTER, useClass: HubExceptionFilter },
      ],
    };
  }
}
