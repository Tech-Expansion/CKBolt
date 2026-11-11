/** Timings of Get paid on /app (docs/pay-get-paid.md, part C). */
export const REQUEST_TIMING = {
  /** The Fiber invoice's status is read from the node this often until it is paid, expired or cancelled. */
  statusPollMs: 3_000,
} as const;

/**
 * Get paid's lines in the browser console. A failed cancel is only logged: once the request is paid, the node still
 * cancels the swap's payout invoice, so a late Lightning payer is refunded. A swap is named by its id, never its token.
 */
export const REQUEST_LOG = {
  CANCEL_FAILED: (swapId: string, reason: string) => `[ckbolt get paid] The hub did not cancel swap ${swapId}: ${reason}`,
} as const;
