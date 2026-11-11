/** Timings of Pay on /app (docs/pay-get-paid.md, part B). */
export const PAY_TIMING = {
  /** A pasted Fiber invoice is read by the node this long after the last keystroke. */
  readDelayMs: 300,
  /** A Fiber payment's status is read from the node this often until it is paid or failed. */
  statusPollMs: 2_000,
} as const;
