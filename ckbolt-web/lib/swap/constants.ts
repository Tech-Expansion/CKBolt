import type { Direction } from "@/lib/hub/contract";

/** Tunables of the live swap card (docs/live-swap-ui.md). */
export const SWAP_CARD = {
  /** The direction the card opens with: BTC on Lightning to a Fiber asset. */
  defaultDirection: "ln_to_fiber" as Direction,
  /** The quote timer and the run's expiry checks tick this often. */
  clockTickMs: 1_000,
  /** Fraction digits of a compact rate, such as "54.56M". */
  compactRateFractionDigits: 2,
  /** A receive amount longer than this many characters is shown one size smaller, so it fits a phone. */
  longAmountChars: 12,
  /** Characters kept at each end of a shortened hash or id. */
  shortHashChars: 10,
} as const;

/** The two directions, each the other's flip. */
export const FLIPPED: Readonly<Record<Direction, Direction>> = { ln_to_fiber: "fiber_to_ln", fiber_to_ln: "ln_to_fiber" };

/** Hub swap states at which the hub holds the user's payment (the run's step 3 is done). */
export const FUNDED_STATES = ["incoming_accepted", "outgoing_in_flight", "outgoing_succeeded", "succeeded"] as const;

/** Hub swap states at which the payout has gone through (the run's step 4 is done). */
export const PAID_OUT_STATES = ["outgoing_succeeded", "succeeded"] as const;
