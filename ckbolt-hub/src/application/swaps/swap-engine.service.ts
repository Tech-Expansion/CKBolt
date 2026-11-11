import { Inject, Injectable, Logger } from "@nestjs/common";
import { describeError } from "../../common/utils/error.util";
import { matchesSecretDigest } from "../../common/utils/secret.util";
import type { HubConfig } from "../../config/hub.config";
import type { AssetRegistry } from "../../domain/assets";
import type { TimingProfile } from "../../domain/timing/timing.types";
import type { Swap, SwapEvent } from "../../domain/types";
import type { Clock } from "../ports/clock.port";
import type { FiberPort } from "../ports/fiber.port";
import type { LightningPort } from "../ports/lightning.port";
import type { SwapStore } from "../ports/swap-store.port";
import { ASSETS, CLOCK, FIBER, HUB_CONFIG, LIGHTNING, SWAP_STORE, TIMING_PROFILE } from "../ports/tokens";
import { PRICING_SERVICE, type PricingService } from "../pricing/pricing.contract";
import { KeyedSerialRunner } from "./keyed-serial-runner";
import type { CreatedSwap, CreateSwapInput, SwapEngine } from "./swap-engine.contract";
import { SWAP_ERROR } from "./swap.errors";
import { SwapCreator } from "./swap-creator";
import { createSwapFlows } from "./swap-flows";
import { SwapJournal } from "./swap-journal";
import { SwapProcessor } from "./swap-processor";
import { UnpaidSwapLimits } from "./unpaid-swap-limits";

/**
 * The swap engine (SWAP_ENGINE): creates swaps and drives each one through the state machine. Every node, the store,
 * the clock and the config come in through the constructor, so tests run it on the fakes in test/fakes.
 */
@Injectable()
export class SwapEngineService implements SwapEngine {
  private readonly logger = new Logger(SwapEngineService.name);
  private readonly creator: SwapCreator;
  private readonly processor: SwapProcessor;
  /** The per-swap lock: the same swap is never processed twice at once. */
  private readonly runner = new KeyedSerialRunner();

  constructor(
    @Inject(LIGHTNING) lightning: LightningPort,
    @Inject(FIBER) fiber: FiberPort,
    @Inject(SWAP_STORE) private readonly store: SwapStore,
    @Inject(PRICING_SERVICE) pricing: PricingService,
    @Inject(ASSETS) assets: AssetRegistry,
    @Inject(TIMING_PROFILE) profile: TimingProfile,
    @Inject(CLOCK) clock: Clock,
    @Inject(HUB_CONFIG) config: HubConfig,
  ) {
    const flows = createSwapFlows({ lightning, fiber, assets, profile, clock, config });
    const journal = new SwapJournal(store, clock);
    const {
      maxUnpaidSwapsPerClient: perClient,
      maxOpenRequestsPerClient: requestsPerClient,
      maxUnpaidSwaps: total,
      maxUnpaidSharePercent: maxSharePercent,
    } = config.swaps;
    const unpaidSwaps = new UnpaidSwapLimits(store, clock, { perClient, requestsPerClient, total, maxSharePercent, feeBudgets: config.swaps });
    this.creator = new SwapCreator({ pricing, assets, store, clock, flows, journal, unpaidSwaps });
    this.processor = new SwapProcessor(flows, journal, clock, config.swaps);
  }

  createSwap(input: CreateSwapInput): Promise<CreatedSwap> {
    return this.creator.create(input);
  }

  /**
   * The token is checked first, off the lock: a request without it never waits for the swap's node calls, nor makes
   * anyone else wait. The hash never changes, so the check does not need the lock.
   */
  async cancelSwap(id: string, cancelToken: string | undefined): Promise<Swap> {
    this.assertCancelToken(this.requireSwap(id), cancelToken);
    return this.runner.exclusive(id, async () => {
      await this.processor.cancelUnpaid(this.requireSwap(id));
      return this.requireSwap(id);
    });
  }

  getSwap(id: string): Swap | null {
    return this.store.getSwap(id);
  }

  listEvents(swapId: string): SwapEvent[] {
    return this.store.listEvents(swapId);
  }

  /** One step for the swap's current state. Throws NotFoundError for an unknown id; step failures are recorded, not thrown. */
  processSwap(id: string): Promise<void> {
    return this.runner.run(id, () => this.stepOnce(id));
  }

  /** One step for every open swap, side by side, so a slow node call on one swap does not hold up the others. */
  async processOpenSwaps(): Promise<void> {
    const results = await Promise.allSettled(this.store.listOpenSwaps().map((swap) => this.processSwap(swap.id)));
    for (const result of results) {
      if (result.status === "rejected") this.logger.error(`A swap could not be processed: ${describeError(result.reason)}`);
    }
  }

  /** Reads the swap fresh on every run, so a queued run sees what the previous one saved. */
  private async stepOnce(id: string): Promise<void> {
    await this.processor.step(this.requireSwap(id));
  }

  private requireSwap(id: string): Swap {
    const swap = this.store.getSwap(id);
    if (!swap) throw SWAP_ERROR.swapNotFound();
    return swap;
  }

  /** A swap with no hash was made before cancel tokens existed: no token can be right for it. */
  private assertCancelToken(swap: Swap, cancelToken: string | undefined): void {
    const { cancelTokenHash } = swap;
    if (cancelToken === undefined || cancelTokenHash === null || !matchesSecretDigest(cancelToken, cancelTokenHash)) {
      throw SWAP_ERROR.cancelRefused();
    }
  }
}
