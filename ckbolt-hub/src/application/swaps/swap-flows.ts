import { SWAP_DIRECTION } from "../../common/constants/swap.constants";
import { FiberToLnFlow } from "./fiber-to-ln.flow";
import { LnToFiberFlow } from "./ln-to-fiber.flow";
import type { SwapFlowDeps, SwapFlows } from "./swap-flow";

/** One flow per direction. A new direction is a new SwapFlow registered here. */
export const createSwapFlows = (deps: SwapFlowDeps): SwapFlows => ({
  [SWAP_DIRECTION.LN_TO_FIBER]: new LnToFiberFlow(deps),
  [SWAP_DIRECTION.FIBER_TO_LN]: new FiberToLnFlow(deps),
});
