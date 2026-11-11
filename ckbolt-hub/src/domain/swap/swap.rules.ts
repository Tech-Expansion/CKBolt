import type { Swap } from "../types";
import { SWAP_REASON } from "./swap.reasons";
import { SWAP_STATE } from "./swap.state-machine";

/** Decisions the engine takes on facts it has read. Pure: time is passed in. */

/** The swap waits for the user's payment: nothing is held yet, but its payout is reserved and its hold invoice is open. */
export const isAwaitingPayment = (swap: Pick<Swap, "state">): boolean => swap.state === SWAP_STATE.PENDING;

/** The swap's creator cancelled it: a second cancel only reads the same answer. */
export const isCancelledOnRequest = (swap: Pick<Swap, "state" | "failureReason">): boolean =>
  swap.state === SWAP_STATE.FAILED && swap.failureReason === SWAP_REASON.cancelledOnRequest;

/** A quote is honoured up to, not including, its expiry instant. */
export const isQuoteExpired = (quoteExpiresAt: number, now: number): boolean => now >= quoteExpiresAt;

/**
 * True once an unpaid hold invoice the node released counts as expired with its quote. The hold invoice expires with
 * the quote in whole seconds by the node's clock, so the node may let it go up to `toleranceMs` before the hub's clock
 * reaches the quote's expiry.
 */
export const isHoldInvoiceExpiryDue = (quoteExpiresAt: number, now: number, toleranceMs: number): boolean =>
  isQuoteExpired(quoteExpiresAt - toleranceMs, now);

/** Why a held payment cannot fund the payout, or null when it covers the quote. Amounts in the leg's base units. */
export function heldPaymentProblem(heldAmount: bigint, expectedAmount: bigint): string | null {
  if (heldAmount === 0n) return SWAP_REASON.nothingHeld;
  if (heldAmount < expectedAmount) return SWAP_REASON.underpaid(heldAmount, expectedAmount);
  return null;
}
