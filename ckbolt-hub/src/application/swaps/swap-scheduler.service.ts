import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { describeError } from "../../common/utils/error.util";
import type { HubConfig } from "../../config/hub.config";
import { hasSwapProgressed, isSwapOpen, MAX_SWAP_PROGRESS_STEPS } from "../../domain/swap";
import type { Hex32 } from "../../domain/types";
import type { FiberPort } from "../ports/fiber.port";
import type { LightningPort } from "../ports/lightning.port";
import type { SwapStore } from "../ports/swap-store.port";
import { FIBER, HUB_CONFIG, LIGHTNING, SWAP_STORE } from "../ports/tokens";
import { SWAP_ENGINE, type SwapEngine } from "./swap-engine.contract";

/**
 * Keeps swaps moving. On start-up it runs one pass over every open swap (recovery after a restart), then one pass every
 * `config.swaps.pollIntervalMs`. Node push hints (onUpdate, when the adapter offers it) move the matching swap at once,
 * as far as it can go. Stops cleanly: no new work after shutdown starts, and running work is awaited.
 */
@Injectable()
export class SwapSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SwapSchedulerService.name);
  private readonly unsubscribers: Array<() => void> = [];
  private readonly activeWork = new Set<Promise<void>>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(SWAP_ENGINE) private readonly engine: SwapEngine,
    @Inject(SWAP_STORE) private readonly store: SwapStore,
    @Inject(LIGHTNING) private readonly lightning: LightningPort,
    @Inject(FIBER) private readonly fiber: FiberPort,
    @Inject(HUB_CONFIG) private readonly config: HubConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    this.running = true;
    this.subscribeToNodes();
    await this.track(this.runPass());
    this.scheduleNextPass();
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    await Promise.allSettled([...this.activeWork]);
  }

  private subscribeToNodes(): void {
    const nodes: ReadonlyArray<LightningPort | FiberPort> = [this.lightning, this.fiber];
    for (const node of nodes) {
      const unsubscribe = node.onUpdate?.((paymentHash) => this.onNodeUpdate(paymentHash));
      if (unsubscribe) this.unsubscribers.push(unsubscribe);
    }
  }

  private scheduleNextPass(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => this.onTimer(), this.config.swaps.pollIntervalMs);
    // Shutdown clears the timer; unref keeps a forgotten one from holding the process open.
    this.timer.unref?.();
  }

  private onTimer(): void {
    this.timer = null;
    void this.track(this.runPass()).finally(() => this.scheduleNextPass());
  }

  private async runPass(): Promise<void> {
    try {
      await this.engine.processOpenSwaps();
    } catch (error) {
      this.logger.error(`Swap pass failed: ${describeError(error)}`);
    }
  }

  /** Called by the node adapters, possibly from inside their own calls: it must return at once and never throw. */
  private onNodeUpdate(paymentHash: Hex32): void {
    if (!this.running) return;
    void this.track(this.advanceSwapWithHash(paymentHash));
  }

  private async advanceSwapWithHash(paymentHash: Hex32): Promise<void> {
    try {
      const swap = this.store.getSwapByHash(paymentHash);
      if (swap && isSwapOpen(swap)) await this.advanceSwap(swap.id);
    } catch (error) {
      this.logger.error(`Could not process the update for hash ${paymentHash}: ${describeError(error)}`);
    }
  }

  /** Steps one swap until a step changes nothing, bounded by the most changes a swap can go through. */
  private async advanceSwap(id: string): Promise<void> {
    let before = this.engine.getSwap(id);
    for (let step = 0; before && step < MAX_SWAP_PROGRESS_STEPS; step += 1) {
      await this.engine.processSwap(id);
      const after = this.engine.getSwap(id);
      if (!after || !hasSwapProgressed(before, after)) return;
      before = after;
    }
  }

  private track(work: Promise<void>): Promise<void> {
    this.activeWork.add(work);
    return work.finally(() => this.activeWork.delete(work));
  }
}
