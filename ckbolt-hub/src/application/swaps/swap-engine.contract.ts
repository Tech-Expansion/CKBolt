import type { Swap, SwapEvent } from "../../domain/types";

export interface CreateSwapInput {
  quoteId: string;
  /** Where the hub pays out: a Fiber invoice (ln_to_fiber) or a BOLT11 invoice (fiber_to_ln). */
  payoutInvoice: string;
  /** The payout invoice is the hub-run demo wallet's own, as DemoWallet.receivesPayout found it (never the request). */
  demo: boolean;
  /** Who asks: the HTTP layer's client key, the one the rate limiter counts. Caps the swaps a client leaves unpaid. */
  clientKey: string;
}

/** A swap as POST /v1/swaps answers it: the only time its cancel token exists outside the caller's hands. */
export interface CreatedSwap extends Swap {
  cancelToken: string;
}

/**
 * Runs swaps: validates the payout invoice against the quote, issues the hold invoice, then drives each swap through
 * pending -> incoming_accepted -> outgoing_in_flight -> outgoing_succeeded -> succeeded (or failed with a refund).
 * Implemented in src/application/swaps.
 */
export interface SwapEngine {
  /** Throws HubError (expired quote, wrong invoice, duplicate hash, timing out of range, too many unpaid swaps...). */
  createSwap(input: CreateSwapInput): Promise<CreatedSwap>;
  /**
   * Cancels a swap nobody has paid, for whoever holds its cancel token, on the per-swap lock, and returns it as saved.
   * Asking again returns the same answer. Throws 404 for an unknown id; 403 cancel_refused without the right token; 409
   * conflict when a payment arrived or the swap has moved on; 503 when the node cannot say what it holds.
   */
  cancelSwap(id: string, cancelToken: string | undefined): Promise<Swap>;
  getSwap(id: string): Swap | null;
  listEvents(swapId: string): SwapEvent[];
  /** One pass of the state machine for one swap. Safe to call any time, any number of times. */
  processSwap(id: string): Promise<void>;
  /** One pass over every open swap; called on a timer and at start-up (recovery). */
  processOpenSwaps(): Promise<void>;
}

export const SWAP_ENGINE = Symbol("SWAP_ENGINE");
