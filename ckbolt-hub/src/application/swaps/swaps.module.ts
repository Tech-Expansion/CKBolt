import { Module } from "@nestjs/common";
import { PricingModule } from "../pricing/pricing.module";
import { SWAP_ENGINE } from "./swap-engine.contract";
import { SwapEngineService } from "./swap-engine.service";
import { SwapSchedulerService } from "./swap-scheduler.service";

/**
 * Swaps: the engine (SWAP_ENGINE) and the scheduler that drives it. Needs PRICING_SERVICE (PricingModule) and the
 * global LIGHTNING, FIBER, SWAP_STORE (infrastructure modules) and HUB_CONFIG, TIMING_PROFILE, ASSETS, CLOCK
 * (HubConfigModule).
 */
@Module({
  imports: [PricingModule],
  providers: [{ provide: SWAP_ENGINE, useClass: SwapEngineService }, SwapSchedulerService],
  exports: [SWAP_ENGINE],
})
export class SwapsModule {}
