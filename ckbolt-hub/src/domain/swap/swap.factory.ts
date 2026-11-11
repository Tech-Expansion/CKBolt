import type { Hex32, Quote, Swap } from "../types";
import { INITIAL_SWAP_STATE } from "./swap.state-machine";

/** Timing values fixed when the swap is created (see Swap for their meaning per direction). */
export type SwapTiming = Pick<Swap, "holdCltvExpiry" | "holdFinalExpiryDeltaMs" | "payoutLockLimit">;

export interface NewSwapInput {
  id: string;
  quote: Quote;
  paymentHash: Hex32;
  payoutInvoice: string;
  holdInvoice: string;
  timing: SwapTiming;
  cancelTokenHash: Hex32;
  demo: boolean;
  now: number;
}

/** A new swap waiting for its hold invoice to be paid. Amounts, direction and asset come from the quote. */
export function createPendingSwap(input: NewSwapInput): Swap {
  const { quote, timing } = input;
  return {
    id: input.id,
    quoteId: quote.id,
    direction: quote.direction,
    asset: quote.asset,
    paymentHash: input.paymentHash,
    sats: quote.sats,
    fiberAmount: quote.fiberAmount,
    payoutInvoice: input.payoutInvoice,
    holdInvoice: input.holdInvoice,
    state: INITIAL_SWAP_STATE,
    preimage: null,
    failureReason: null,
    refunded: false,
    holdCltvExpiry: timing.holdCltvExpiry,
    holdFinalExpiryDeltaMs: timing.holdFinalExpiryDeltaMs,
    payoutLockLimit: timing.payoutLockLimit,
    quoteExpiresAt: quote.expiresAt,
    cancelTokenHash: input.cancelTokenHash,
    demo: input.demo,
    createdAt: input.now,
    updatedAt: input.now,
  };
}
