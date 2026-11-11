import { PERCENT_PER_WHOLE } from "../../common/constants/pricing.constants";
import {
  FIBER_DEFAULT_COMMITMENT_DELAY_EPOCHS,
  FIBER_DEFAULT_HOP_EXPIRY_DELTA_MS,
  FIBER_EPOCH_MS,
  LND_BLOCK_PADDING_BLOCKS,
} from "../../common/constants/protocol.constants";
import { FIBER_PAYOUT_GUARD } from "../../common/constants/timing.constants";
import { secondsToMs } from "../../common/utils/time.util";
import { blocksCoveringMs, blocksToMs, blocksWithinMs, fiberHeldTlcEarlyFailMs } from "../../common/utils/timing.util";
import type { TimingProfile } from "./timing.types";

/**
 * Named pieces of the expiry maths in timing.policy.ts (docs/research/lnd.md section 6.4), so the policy reads like the
 * rules and each term is written once.
 */

/** Pessimistic fast block interval: turns a time budget into blocks that must not run out early. */
export const fastBlockMs = (profile: TimingProfile): number => secondsToMs(profile.btcFastBlockSeconds);

/** Pessimistic slow block interval: turns blocks into the longest time they can take. */
export const slowBlockMs = (profile: TimingProfile): number => secondsToMs(profile.btcSlowBlockSeconds);

/**
 * Height at which LND cancels an accepted hold invoice by itself: its holdexpirydelta before the earliest HTLC expiry
 * (tested with the default 18: expiry 150 -> cancelled at 132).
 */
export const lnAutoCancelHeight = (profile: TimingProfile, earliestHtlcExpiryHeight: number): number =>
  earliestHtlcExpiryHeight - profile.lndHoldExpiryDeltaBlocks;

/**
 * `cltv_expiry` a Lightning hold invoice needs so that a Fiber lock of `lockMs` ends before LND's auto-cancel point
 * with the hub's margin to spare, even if LND's block padding is mined before the payout starts.
 */
export const lnHoldCltvCovering = (profile: TimingProfile, lockMs: number): number =>
  blocksCoveringMs(lockMs, fastBlockMs(profile)) +
  profile.lndHoldExpiryDeltaBlocks +
  profile.lnMarginBlocks +
  LND_BLOCK_PADDING_BLOCKS;

/** Longest Fiber lock that still ends `lnMarginBlocks` before LND's auto-cancel point, counted at the fast interval. */
export const fiberLockBeforeLnAutoCancelMs = (
  profile: TimingProfile,
  earliestHtlcExpiryHeight: number,
  currentHeight: number,
): number => {
  const blocksBeforeAutoCancel = lnAutoCancelHeight(profile, earliestHtlcExpiryHeight) - currentHeight;
  return blocksToMs(blocksBeforeAutoCancel - profile.lnMarginBlocks, fastBlockMs(profile));
};

/** Longest a Fiber payout may lock funds: the payee's final delta, `maxFiberHops` hop deltas and the hub's margin. */
export const fiberPayoutLockMs = (profile: TimingProfile, payoutFinalExpiryDeltaMs: number): number =>
  payoutFinalExpiryDeltaMs + profile.maxFiberHops * FIBER_DEFAULT_HOP_EXPIRY_DELTA_MS + profile.fiberMarginMs;

/**
 * Time at the end of a held Fiber TLC the Lightning payout may not use, when planning the hold invoice: fnn's early-fail
 * margin on a channel with this commitment delay (fnn's default on the hub's own channels) plus the hub's margin.
 */
export const fiberHoldReserveMs = (profile: TimingProfile, commitmentDelayEpochs = FIBER_DEFAULT_COMMITMENT_DELAY_EPOCHS): number =>
  fiberHeldTlcEarlyFailMs(commitmentDelayEpochs) + profile.fiberMarginMs;

/**
 * When fnn fails a held TLC (ms): its expiry less the early-fail margin of the channel it arrived on, which grows with
 * that channel's commitment delay.
 */
export const fiberHeldTlcFailsAt = (expiresAt: number, commitmentDelayEpochs: number): number =>
  expiresAt - fiberHeldTlcEarlyFailMs(commitmentDelayEpochs);

/** Largest `cltv_limit` whose blocks cannot outlast the profile's payout lock cap, even at the slow interval. */
export const maxPayoutCltvLimit = (profile: TimingProfile): number => blocksWithinMs(profile.maxPayoutLockMs, slowBlockMs(profile));

/** Name of the first input field that is not a finite, non-negative number; null when all are valid. */
export const findInvalidField = (input: Readonly<Record<string, number>>): string | null => {
  const invalid = Object.entries(input).find(([, value]) => !Number.isFinite(value) || value < 0);
  return invalid ? invalid[0] : null;
};

/** A commitment delay in ms, counted FIBER_PAYOUT_GUARD.epochSlackPercent longer than 4-hour epochs. */
export const slowCommitmentDelayMs = (commitmentDelayEpochs: number): number =>
  (commitmentDelayEpochs * FIBER_EPOCH_MS * (PERCENT_PER_WHOLE + FIBER_PAYOUT_GUARD.epochSlackPercent)) / PERCENT_PER_WHOLE;

/**
 * When the hub force-closes the private channel of an ln_to_fiber payout whose payee has not settled the hub's TLC
 * (constants FIBER_PAYOUT_GUARD): early enough that the channel's on-chain settlement, open once the commitment has
 * waited out the channel's delay, starts FIBER_PAYOUT_GUARD.marginMs before the TLC expires; never sooner than the grace
 * after the payout was sent. With fnn's default delay (1 epoch) that is 5.5 hours before the expiry.
 */
export const fiberPayoutForceCloseAt = (tlc: { expiresAt: number; commitmentDelayEpochs: number; sentAt: number }): number =>
  Math.max(
    tlc.expiresAt - slowCommitmentDelayMs(tlc.commitmentDelayEpochs) - FIBER_PAYOUT_GUARD.marginMs,
    tlc.sentAt + FIBER_PAYOUT_GUARD.settleGraceMs,
  );
