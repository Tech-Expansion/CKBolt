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
    lnMarginBlocks: 20,
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
 * ln_to_fiber payouts: fnn lets the peer holding the hub's TLC claim it on chain with the preimage even after its
 * expiry, and the on-chain settlement opens only once the channel's commitment delay has passed after a force close.
 * fnn closes 2/3 of that delay before expiry, so the claim can come about a third of the delay after it, past the point
 * where LND gives the Lightning hold back. The hub closes the channel itself, earlier (domain/timing
 * fiberPayoutForceCloseAt), when the peer has not settled: settlement then opens before the TLC expires, while the hold
 * still stands, and a preimage revealed on chain still collects it. Only a public channel the hub opened to a router
 * that is not the payee stays open (LnToFiberFlow.guardPayout).
 */
export const FIBER_PAYOUT_GUARD = {
  /** CKB epochs aim at 4 hours but some run longer: the commitment delay is counted this much longer. */
  epochSlackPercent: 25,
  /** On-chain settlement opens at least this long before the TLC expires. */
  marginMs: 30 * MS_PER_MINUTE,
  /** Never closes sooner than this after the payout was sent: an honest payee settles within seconds. */
  settleGraceMs: 10 * MS_PER_MINUTE,
} as const;
