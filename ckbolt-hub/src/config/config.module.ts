import { Global, Module } from "@nestjs/common";
import { systemClock } from "../application/ports/clock.port";
import { ASSETS, CLOCK, HUB_CONFIG, TIMING_PROFILE } from "../application/ports/tokens";
import { assetRegistryOf, loadHubConfig, type HubConfig } from "./hub.config";

/** Provides the validated config and the values derived from it to every module. */
@Global()
@Module({
  providers: [
    { provide: HUB_CONFIG, useFactory: () => loadHubConfig() },
    { provide: TIMING_PROFILE, useFactory: (config: HubConfig) => config.timing, inject: [HUB_CONFIG] },
    { provide: ASSETS, useFactory: assetRegistryOf, inject: [HUB_CONFIG] },
    { provide: CLOCK, useValue: systemClock },
  ],
  exports: [HUB_CONFIG, TIMING_PROFILE, ASSETS, CLOCK],
})
export class HubConfigModule {}
