import { Module } from "@nestjs/common";
import type { AssetRegistry } from "../../domain/assets";
import type { SwapStore } from "../ports/swap-store.port";
import { ASSETS, SWAP_STORE } from "../ports/tokens";
import { PricingModule } from "../pricing/pricing.module";
import { assertOpenSwapAssetsServed } from "./open-swap-assets.check";
import { SWAP_ENGINE } from "./swap-engine.contract";
import { SwapEngineService } from "./swap-engine.service";
import { SwapSchedulerService } from "./swap-scheduler.service";

/**
 * Resolved when Nest builds the modules, before any of them starts (so before the scheduler's recovery pass): the hub
 * refuses to start while an open swap is in an asset it no longer serves (assertOpenSwapAssetsServed).
 */
const OPEN_SWAP_ASSETS_CHECKED = Symbol("OPEN_SWAP_ASSETS_CHECKED");

/**
 * Swaps: the engine (SWAP_ENGINE) and the scheduler that drives it. Needs PRICING_SERVICE (PricingModule) and the
 * global LIGHTNING, FIBER, SWAP_STORE (infrastructure modules) and HUB_CONFIG, TIMING_PROFILE, ASSETS, CLOCK
 * (HubConfigModule).
 */
@Module({
  imports: [PricingModule],
  providers: [
    {
      provide: OPEN_SWAP_ASSETS_CHECKED,
      useFactory: (store: SwapStore, assets: AssetRegistry): true => {
        assertOpenSwapAssetsServed(store.listOpenSwaps(), assets);
        return true;
      },
      inject: [SWAP_STORE, ASSETS],
    },
    { provide: SWAP_ENGINE, useClass: SwapEngineService },
    SwapSchedulerService,
  ],
  exports: [SWAP_ENGINE],
})
export class SwapsModule {}
