import { Global, Module } from "@nestjs/common";
import { DEMO_FIBER, FIBER, HUB_CONFIG } from "../../application/ports/tokens";
import { createDemoFiber, createHubFiber } from "./fiber.factory";

/**
 * Binds FiberPort to fnn JSON-RPC: FIBER is the hub's node (config.fiber), DEMO_FIBER the demo wallet's node
 * (config.demo.fiber) or null when the demo is disabled. Global, so feature modules inject the tokens directly.
 */
@Global()
@Module({
  providers: [
    { provide: FIBER, useFactory: createHubFiber, inject: [HUB_CONFIG] },
    { provide: DEMO_FIBER, useFactory: createDemoFiber, inject: [HUB_CONFIG] },
  ],
  exports: [FIBER, DEMO_FIBER],
})
export class FiberModule {}
