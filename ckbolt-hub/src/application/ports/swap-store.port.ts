import type { Hex32, Quote, Swap, SwapEvent, SwapState } from "../../domain/types";

/** Fields a transition may change: everything but the swap's identity, creation time and cancel token's hash. */
export type SwapTransitionPatch = Partial<Omit<Swap, "id" | "createdAt" | "cancelTokenHash">>;
/** Fields an update may change: a transition's fields without the state. */
export type SwapUpdatePatch = Omit<SwapTransitionPatch, "state">;

/**
 * Durable storage for quotes, swaps and their event log. Synchronous (SQLite through better-sqlite3).
 * The engine saves every transition before it acts on it, so a crash at any point can resume.
 *
 * Patches: a field that is absent or `undefined` in a patch means "leave unchanged"; to clear a nullable field, pass
 * `null`. Every write bumps `updatedAt` to the store's clock.
 */
export interface SwapStore {
  saveQuote(quote: Quote): void;
  getQuote(id: string): Quote | null;

  /**
   * Throws DuplicateHashError when a swap with the same payment hash exists, and QuoteAlreadyUsedError when the quote
   * already has a swap (one swap per quote).
   */
  createSwap(swap: Swap): void;
  getSwap(id: string): Swap | null;
  getSwapByHash(paymentHash: Hex32): Swap | null;
  /** The swap that redeemed this quote, or null when the quote has none. */
  getSwapByQuoteId(quoteId: string): Swap | null;
  /** Swaps not yet succeeded or failed, plus failed swaps whose incoming leg is not yet cancelled. Oldest first. */
  listOpenSwaps(): Swap[];

  /**
   * Compare-and-set: applies `patch` (and bumps updatedAt) only if the swap is still in state `from`.
   * Returns the updated swap, or null when the state had already changed (or the swap does not exist).
   */
  transition(id: string, from: SwapState, patch: SwapTransitionPatch): Swap | null;
  /** Updates fields without a state check (e.g. refunded, failureReason). Returns the updated swap; NotFoundError if none. */
  update(id: string, patch: SwapUpdatePatch): Swap;

  /** NotFoundError when the swap does not exist. */
  addEvent(event: SwapEvent): void;
  /** Oldest first. */
  listEvents(swapId: string): SwapEvent[];

  close(): void;
}
