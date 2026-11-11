/**
 * Inputs to the expiry maths. The protocol facts (Fiber's 160-minute minimum, LND's block padding...) are in
 * common/constants/protocol.constants.ts; this profile holds the network's block pacing, the hub LND's auto-cancel
 * setting and the hub's own margins, which come from config.
 */
export interface TimingProfile {
  name: string;
  /** Nominal seconds per Bitcoin block. */
  btcBlockSeconds: number;
  /** Pessimistic fast interval, used when converting a time budget into blocks that must not run out early. */
  btcFastBlockSeconds: number;
  /** Pessimistic slow interval, used when converting blocks into time that must not be overestimated. */
  btcSlowBlockSeconds: number;
  /**
   * The hub LND's `invoices.holdexpirydelta`: it cancels an accepted hold invoice this many blocks before the earliest
   * HTLC expires. Must equal lnd.conf; at least LND_MIN_HOLD_EXPIRY_DELTA_BLOCKS.
   */
  lndHoldExpiryDeltaBlocks: number;
  /** Extra Lightning blocks kept on top of LND's auto-cancel margin (ln_to_fiber settles inside them). */
  lnMarginBlocks: number;
  /**
   * CLTV blocks a Lightning payout (fiber_to_ln) may spend on route hops beyond the invoice's final CLTV and LND's
   * padding. The Fiber hold invoice is sized so this much fits at the slow block interval.
   */
  lnRouteBudgetBlocks: number;
  /** Longest total CLTV the hub will ask a payer to accept. */
  payerMaxCltv: number;
  /**
   * CLTV blocks kept free under payerMaxCltv for the route between a payer and the hub (ln_to_fiber): LDK's shadow-route
   * reserve, plus the delta of every node that forwards the payment. The hold invoice's CLTV plus this budget must fit
   * the payer's limit.
   */
  payerRouteBudgetBlocks: number;
  /** Extra Fiber time kept on top of fnn's early-fail margin, ms. */
  fiberMarginMs: number;
  /** Most Fiber hops the hub budgets for when paying out on Fiber. */
  maxFiberHops: number;
  /**
   * Longest the hub lets one payout lock its funds, ms: the user decides how long to hold the payout, and the hub's
   * option premium only covers so long. Caps the Fiber `tlc_expiry_limit` and the Lightning `cltv_limit` (counted at the
   * slow block interval); a payout invoice that needs a longer lock is refused when the swap is created.
   */
  maxPayoutLockMs: number;
}

export type TimingResult<T> = ({ ok: true } & T) | { ok: false; reason: string };
