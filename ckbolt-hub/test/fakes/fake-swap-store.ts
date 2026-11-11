import type { SwapStore, SwapTransitionPatch, SwapUpdatePatch } from "../../src/application/ports/swap-store.port";
import { RESOURCE_NAME } from "../../src/common/constants/api.constants";
import { OPEN_SWAP_STATES, SWAP_STATE } from "../../src/common/constants/swap.constants";
import { DuplicateHashError, NotFoundError, QuoteAlreadyUsedError } from "../../src/common/errors/hub.error";
import type { Hex32, Quote, Swap, SwapEvent, SwapState } from "../../src/domain/types";
import type { FakeClock } from "./fake-clock";

/** The patch's defined fields only: like the SQLite store, a field given as undefined keeps its stored value. */
const definedFields = <T extends object>(patch: T): Partial<T> =>
  Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<T>;

/**
 * In-memory SwapStore with the same semantics as the SQLite one (compare-and-set transitions, unique hashes, one swap
 * per quote, undefined patch fields left unchanged, NotFoundError for unknown swaps).
 */
export class FakeSwapStore implements SwapStore {
  private readonly quotes = new Map<string, Quote>();
  private readonly swaps = new Map<string, Swap>();
  private readonly events: SwapEvent[] = [];

  constructor(private readonly clock: FakeClock) {}

  saveQuote(quote: Quote): void {
    this.quotes.set(quote.id, { ...quote });
  }

  getQuote(id: string): Quote | null {
    const q = this.quotes.get(id);
    return q ? { ...q } : null;
  }

  createSwap(swap: Swap): void {
    if (this.find((s) => s.paymentHash === swap.paymentHash)) throw new DuplicateHashError();
    if (this.find((s) => s.quoteId === swap.quoteId)) throw new QuoteAlreadyUsedError();
    this.swaps.set(swap.id, { ...swap });
  }

  getSwap(id: string): Swap | null {
    const s = this.swaps.get(id);
    return s ? { ...s } : null;
  }

  getSwapByHash(paymentHash: Hex32): Swap | null {
    return this.find((s) => s.paymentHash === paymentHash);
  }

  getSwapByQuoteId(quoteId: string): Swap | null {
    return this.find((s) => s.quoteId === quoteId);
  }

  listOpenSwaps(): Swap[] {
    return [...this.swaps.values()]
      .filter((s) => OPEN_SWAP_STATES.includes(s.state) || (s.state === SWAP_STATE.FAILED && !s.refunded))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((s) => ({ ...s }));
  }

  transition(id: string, from: SwapState, patch: SwapTransitionPatch): Swap | null {
    const s = this.swaps.get(id);
    if (!s || s.state !== from) return null;
    return this.save({ ...s, ...definedFields(patch) });
  }

  update(id: string, patch: SwapUpdatePatch): Swap {
    const s = this.swaps.get(id);
    if (!s) throw new NotFoundError(RESOURCE_NAME.SWAP);
    return this.save({ ...s, ...definedFields(patch), state: s.state });
  }

  addEvent(event: SwapEvent): void {
    if (!this.swaps.has(event.swapId)) throw new NotFoundError(RESOURCE_NAME.SWAP);
    this.events.push({ ...event });
  }

  listEvents(swapId: string): SwapEvent[] {
    return this.events.filter((e) => e.swapId === swapId).map((e) => ({ ...e }));
  }

  close(): void {}

  private find(match: (swap: Swap) => boolean): Swap | null {
    const s = [...this.swaps.values()].find(match);
    return s ? { ...s } : null;
  }

  /** Every write bumps updatedAt from the clock. */
  private save(swap: Swap): Swap {
    const next: Swap = { ...swap, updatedAt: this.clock.now() };
    this.swaps.set(next.id, next);
    return { ...next };
  }
}
