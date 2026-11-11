import { Logger } from "@nestjs/common";
import type { SwapEventType } from "../../common/constants/swap.constants";
import { assertTransition } from "../../domain/swap";
import type { Swap, SwapEvent, SwapState } from "../../domain/types";
import type { Clock } from "../ports/clock.port";
import type { SwapStore, SwapUpdatePatch } from "../ports/swap-store.port";

/**
 * Durable record of what happens to a swap: state transitions (saved before the engine acts on them) and the event
 * log users read. Repeated problems are written once, so a node outage does not flood the log.
 */
export class SwapJournal {
  private readonly logger = new Logger(SwapJournal.name);

  constructor(
    private readonly store: SwapStore,
    private readonly clock: Clock,
  ) {}

  /**
   * Saves the transition if the swap is still in the state it was read in (compare-and-set), then records `event`.
   * Returns the saved swap, or null when another pass moved it first (nothing is then done for this one).
   */
  advance(swap: Swap, to: SwapState, event: SwapEventType, detail: string, patch: SwapUpdatePatch = {}): Swap | null {
    assertTransition(swap.state, to);
    const next = this.store.transition(swap.id, swap.state, { ...patch, state: to });
    if (!next) {
      this.logger.warn(`Swap ${swap.id} left ${swap.state} before it could move to ${to}; nothing done.`);
      return null;
    }
    this.record(swap.id, event, detail);
    this.logger.log(`Swap ${swap.id}: ${swap.state} -> ${to}`);
    return next;
  }

  /** Saves fields that do not change the state (e.g. refunded, payoutLockLimit). */
  update(swap: Swap, patch: SwapUpdatePatch): Swap {
    return this.store.update(swap.id, patch);
  }

  record(swapId: string, type: SwapEventType, detail: string): void {
    this.store.addEvent({ swapId, at: this.clock.now(), type, detail });
  }

  /** The swap's events of the given types, oldest first. */
  eventsOf(swapId: string, types: readonly SwapEventType[]): SwapEvent[] {
    return this.store.listEvents(swapId).filter((event) => (types as readonly string[]).includes(event.type));
  }

  /**
   * Records a problem unless it is already the swap's latest event, so a retry every poll does not repeat it.
   * Returns true when it was recorded (a new problem).
   */
  recordIssue(swapId: string, type: SwapEventType, detail: string): boolean {
    const latest = this.store.listEvents(swapId).at(-1);
    if (latest?.type === type && latest.detail === detail) return false;
    this.record(swapId, type, detail);
    return true;
  }
}
