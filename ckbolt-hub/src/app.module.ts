import { Module } from "@nestjs/common";
import { DemoModule } from "./application/demo/demo.module";
import { FiberNodeModule } from "./application/fiber-node/fiber-node.module";
import { HealthModule } from "./application/health/health.module";
import { LightningNodeModule } from "./application/lightning-node/lightning-node.module";
import { PricingModule } from "./application/pricing/pricing.module";
import { SwapsModule } from "./application/swaps/swaps.module";
import { HubConfigModule } from "./config/config.module";
import { FiberModule } from "./infrastructure/fiber/fiber.module";
import { LightningModule } from "./infrastructure/lightning/lightning.module";
import { PersistenceModule } from "./infrastructure/persistence/persistence.module";
import { PricesModule } from "./infrastructure/prices/prices.module";
import { ApiModule } from "./interfaces/http/api.module";
import { FiberApiModule } from "./interfaces/http/fiber-api.module";
import { LightningApiModule } from "./interfaces/http/lightning-api.module";

/** The demo wallet needs the swap engine; one instance serves the API. */
const DEMO_MODULE = DemoModule.register({ imports: [SwapsModule] });

/**
 * Composition root. The global modules provide the config (HubConfigModule) and the adapters behind the ports
 * (LightningModule, FiberModule, PersistenceModule, PricesModule); the application modules hold the services; ApiModule
 * exposes them under /v1, FiberApiModule the hub's Fiber node routes (/v1/fiber/...) and LightningApiModule the hub's
 * Lightning node routes (/v1/lightning/...).
 *
 * Shutdown order: Nest destroys feature modules (the swap scheduler stops and waits for running work) before the
 * global ones, then closes the HTTP server; the database and the LND connections close last, on application shutdown.
 */
@Module({
  imports: [
    HubConfigModule,
    LightningModule,
    FiberModule,
    PersistenceModule,
    PricesModule,
    PricingModule,
    SwapsModule,
    DEMO_MODULE,
    HealthModule,
    FiberNodeModule,
    LightningNodeModule,
    ApiModule.register({ imports: [PricingModule, SwapsModule, DEMO_MODULE, HealthModule] }),
    FiberApiModule.register({ imports: [FiberNodeModule] }),
    LightningApiModule.register({ imports: [LightningNodeModule] }),
  ],
})
export class AppModule {}
