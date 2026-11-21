import {
  LND_DEFAULT_HOLD_EXPIRY_DELTA_BLOCKS,
  LDK_SHADOW_ROUTE_RESERVE_BLOCKS,
  LND_DEFAULT_TIME_LOCK_DELTA_BLOCKS,
  LSP_TIME_LOCK_DELTA_BLOCKS,
  MS_PER_HOUR,
  MS_PER_MINUTE,
  PAYER_MAX_CLTV_LDK,
} from "./protocol.constants";
import type { TimingProfile } from "../../domain/timing/timing.types";

/** Lightning route budgets: room for this many forwarding hops at LND's default CLTV delta each. */
const ONE_HOP_ROUTE_BLOCKS = LND_DEFAULT_TIME_LOCK_DELTA_BLOCKS;
const TWO_HOP_ROUTE_BLOCKS = 2 * LND_DEFAULT_TIME_LOCK_DELTA_BLOCKS;
/**
 * Payer route budgets: LDK's shadow-route reserve, plus room for this many forwarding hops between the payer and the hub
 * at an LSP's delta each (none: the payer has a channel with the hub).
 */
const DIRECT_PAYER_BLOCKS = LDK_SHADOW_ROUTE_RESERVE_BLOCKS;
const TWO_PAYER_HOP_BLOCKS = LDK_SHADOW_ROUTE_RESERVE_BLOCKS + 2 * LSP_TIME_LOCK_DELTA_BLOCKS;

/**
 * Mutinynet's Lightning margin: 60 blocks, so LND gives an ln_to_fiber hold back about 30 minutes after the Fiber
 * payout's TLC expires at Mutinynet's 30-second blocks (a run of faster blocks shortens it). A payee that withholds the
 * preimage can still claim that TLC on chain after its expiry, until the hub's timeout claim confirms
 * (FIBER_PAYOUT_GUARD), and the hub must then still settle the hold: CKB's median time (37 blocks, about 3 minutes)
 * gates the timeout claim, fnn's watchtower runs every 60 s, and the hub needs about 2 to 3 minutes to see a claim and
 * settle. The rest is room for an outage of the hub's fnn or CKB RPC around the expiry.
 * Each block of margin takes 30 s from the payout invoice's final expiry delta under LDK's 1,008-block payer cap: with
 * 60 blocks the hub takes payout invoices of 160 to 173 minutes (fnn and fiber-js default to 160).
 */
const MUTINYNET_LN_MARGIN_BLOCKS = 60;

/**
 * Default timing profiles per Bitcoin network. Config picks one by name (TIMING_PROFILE) and may override fields.
 * Fast/slow intervals follow docs/research/lnd.md 6.4 (Boltz adds 25 % for cross-chain swaps). The Lightning route
 * budget is one hop on regtest (the devnet pays over a direct channel) and two hops on public networks. Every profile
 * assumes LND's default hold-invoice auto-cancel delta; LND_HOLD_EXPIRY_DELTA_BLOCKS overrides it to match lnd.conf.
 *
 * A payer of an ln_to_fiber hold invoice gets LDK's 80-block shadow-route reserve and, where blocks take minutes, room
 * for two LSP hops. Where they come every 30 seconds (regtest and Mutinynet) fnn locks a payout for at least 400 minutes
 * (160 for the invoice plus a 4 h random expiry reserve), about 800 such blocks, which leaves an LDK payer (Alby Hub)
 * no room for a hop: it must have a channel with the hub's LND. LND payers (2016 blocks) can come through hops.
 *
 * The payout lock cap leaves room for an invoice CLTV of 80 blocks (LND's default) on regtest and 144 blocks elsewhere,
 * with LND's padding and the route budget at the slow interval (regtest 40.75 h, Mutinynet 3.8 h, testnet and mainnet
 * 76.75 h), far below what the payer limits alone allow (up to 14 days). The option premium must cover holding a payout
 * that long.
 */
export const TIMING_PROFILES = {
  regtest: {
    name: "regtest",
    btcBlockSeconds: 600,
    btcFastBlockSeconds: 30,
    btcSlowBlockSeconds: 900,
    lndHoldExpiryDeltaBlocks: LND_DEFAULT_HOLD_EXPIRY_DELTA_BLOCKS,
    lnMarginBlocks: 6,
    lnRouteBudgetBlocks: ONE_HOP_ROUTE_BLOCKS,
    payerMaxCltv: PAYER_MAX_CLTV_LDK,
    payerRouteBudgetBlocks: DIRECT_PAYER_BLOCKS,
    fiberMarginMs: 10 * MS_PER_MINUTE,
    maxFiberHops: 1,
    maxPayoutLockMs: 48 * MS_PER_HOUR,
  },
  mutinynet: {
    name: "mutinynet",
    btcBlockSeconds: 30,
    btcFastBlockSeconds: 30,
    btcSlowBlockSeconds: 45,
    lndHoldExpiryDeltaBlocks: LND_DEFAULT_HOLD_EXPIRY_DELTA_BLOCKS,
    lnMarginBlocks: MUTINYNET_LN_MARGIN_BLOCKS,
    lnRouteBudgetBlocks: TWO_HOP_ROUTE_BLOCKS,
    payerMaxCltv: PAYER_MAX_CLTV_LDK,
    payerRouteBudgetBlocks: DIRECT_PAYER_BLOCKS,
    fiberMarginMs: 10 * MS_PER_MINUTE,
    maxFiberHops: 1,
    maxPayoutLockMs: 12 * MS_PER_HOUR,
  },
  testnet: {
    name: "testnet",
    btcBlockSeconds: 600,
    btcFastBlockSeconds: 450,
    btcSlowBlockSeconds: 900,
    lndHoldExpiryDeltaBlocks: LND_DEFAULT_HOLD_EXPIRY_DELTA_BLOCKS,
    lnMarginBlocks: 6,
    lnRouteBudgetBlocks: TWO_HOP_ROUTE_BLOCKS,
    payerMaxCltv: PAYER_MAX_CLTV_LDK,
    payerRouteBudgetBlocks: TWO_PAYER_HOP_BLOCKS,
    fiberMarginMs: 15 * MS_PER_MINUTE,
    maxFiberHops: 2,
    maxPayoutLockMs: 96 * MS_PER_HOUR,
  },
  mainnet: {
    name: "mainnet",
    btcBlockSeconds: 600,
    btcFastBlockSeconds: 450,
    btcSlowBlockSeconds: 900,
    lndHoldExpiryDeltaBlocks: LND_DEFAULT_HOLD_EXPIRY_DELTA_BLOCKS,
    lnMarginBlocks: 6,
    lnRouteBudgetBlocks: TWO_HOP_ROUTE_BLOCKS,
    payerMaxCltv: PAYER_MAX_CLTV_LDK,
    payerRouteBudgetBlocks: TWO_PAYER_HOP_BLOCKS,
    fiberMarginMs: 15 * MS_PER_MINUTE,
    maxFiberHops: 2,
    maxPayoutLockMs: 96 * MS_PER_HOUR,
  },
} as const satisfies Record<string, TimingProfile>;

export type TimingProfileName = keyof typeof TIMING_PROFILES;

/**
 * ln_to_fiber payouts after a force close (fnn v0.9.1 and its commitment lock, docs/research/fiber-node.md section 9):
 * the peer holding the hub's TLC can claim it with the preimage once 1/3 of the commitment delay has passed, with no
 * expiry check, until the hub's timeout claim confirms; that claim needs 2/3 of the delay and CKB's median time past the
 * TLC's expiry, and fnn's watchtower sends it as soon as both hold. fnn force-closes by itself 2/3 of the delay (counted
 * at a fixed 4 hours an epoch) before the expiry, so its timeout path opens at the expiry, or 2/3 of any epoch overrun
 * later. The hub closes the channel earlier when the peer has not settled (domain/timing fiberPayoutForceCloseAt): the
 * timeout path then opens at the expiry even with long epochs, and nothing depends on fnn's own close. What remains,
 * a claim in the minutes between the expiry and the hub's timeout claim, is what the Lightning margin covers (each
 * profile's lnMarginBlocks). Only a public channel the hub opened to a router that is not the payee stays open
 * (LnToFiberFlow.guardPayout).
 */
export const FIBER_PAYOUT_GUARD = {
  /**
   * CKB epochs aim at 4 hours but some run longer: the commitment delay is counted this much longer. The guard counts
   * the whole delay, although the timeout path needs only 2/3 of it: with the margin below, a 1-epoch channel's timeout
   * path still opens by the expiry when its epoch lasts up to about 8 hours.
   */
  epochSlackPercent: 25,
  /** The timeout path opens at least this long before the TLC expires. */
  marginMs: 30 * MS_PER_MINUTE,
  /** Never closes sooner than this after the payout was sent: an honest payee settles within seconds. */
  settleGraceMs: 10 * MS_PER_MINUTE,
} as const;
