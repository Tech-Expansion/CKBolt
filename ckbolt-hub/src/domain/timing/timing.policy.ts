import {
  FIBER_DEFAULT_COMMITMENT_DELAY_EPOCHS,
  FIBER_MAX_TLC_EXPIRY_LIMIT_MS,
  FIBER_MIN_FINAL_EXPIRY_DELTA_MS,
  LND_MAX_CLTV_LIMIT,
  LND_MIN_INVOICE_CLTV_EXPIRY,
} from "../../common/constants/protocol.constants";
import { minLnCltvLimit } from "../../common/utils/lightning.util";
import { blocksToMs, blocksWithinMs } from "../../common/utils/timing.util";
import {
  fiberHoldReserveMs,
  fiberLockBeforeLnAutoCancelMs,
  fiberPayoutLockMs,
  findInvalidField,
  lnAutoCancelHeight,
  lnHoldCltvCovering,
  maxPayoutCltvLimit,
  slowBlockMs,
} from "./timing.budget";
import { TIMING_REASON } from "./timing.reasons";
import { timingFail, timingOk } from "./timing.result";
import type { TimingProfile, TimingResult } from "./timing.types";

/**
 * Expiry maths for both swap directions. Pure functions: no I/O, no clock reads (time is passed in).
 * Rules: docs/research/lnd.md section 6.4 and docs/research/cch.md sections 1.9 and 3.2; protocol facts in
 * common/constants/protocol.constants.ts. Signatures are part of the contract.
 *
 * Like CCH, the outgoing leg's lock is capped (Fiber `tlc_expiry_limit`, LND `cltv_limit`) so that it ends inside the
 * remaining incoming window, and the cap is recomputed from the real incoming deadline just before paying out. CCH
 * converts blocks at a nominal 10 minutes and halves the window to absorb block-time variance; the hub converts with
 * the profile's pessimistic fast and slow intervals and keeps explicit margins instead.
 */

/**
 * ln_to_fiber, at swap creation. The user pays a Lightning hold invoice; the hub pays the user's Fiber invoice.
 * Returns the hold invoice's `cltv_expiry` (blocks) and the `tlc_expiry_limit` (ms) for the Fiber payout, so that the
 * worst-case Fiber lock ends before LND's auto-cancel point:
 *   holdCltvExpiry >= ceil(payoutTlcExpiryLimitMs / fastBlockMs) + lndHoldExpiryDeltaBlocks + lnMarginBlocks + 3
 * where payoutTlcExpiryLimitMs covers the payout invoice's final expiry delta plus maxFiberHops hop deltas plus margin.
 * Fails when the payout invoice's delta is below Fiber's minimum, when the payout could lock the hub's funds longer than
 * the profile's maxPayoutLockMs, or when the cltv plus the payer's route budget exceeds payerMaxCltv (each node between
 * the payer and the hub adds its delta, and a payer such as LDK refuses a route whose total is above its limit).
 */
export function planLnToFiber(
  profile: TimingProfile,
  input: { payoutFinalExpiryDeltaMs: number },
): TimingResult<{ holdCltvExpiry: number; payoutTlcExpiryLimitMs: number }> {
  const invalidField = findInvalidField(input);
  if (invalidField) return timingFail(TIMING_REASON.invalidInput(invalidField));

  const { payoutFinalExpiryDeltaMs } = input;
  if (payoutFinalExpiryDeltaMs < FIBER_MIN_FINAL_EXPIRY_DELTA_MS) {
    return timingFail(TIMING_REASON.payoutDeltaBelowFiberMinimum(payoutFinalExpiryDeltaMs));
  }

  const payoutTlcExpiryLimitMs = Math.floor(fiberPayoutLockMs(profile, payoutFinalExpiryDeltaMs));
  if (payoutTlcExpiryLimitMs > FIBER_MAX_TLC_EXPIRY_LIMIT_MS) {
    return timingFail(TIMING_REASON.payoutLockAboveFiberMaximum(payoutTlcExpiryLimitMs));
  }
  if (payoutTlcExpiryLimitMs > profile.maxPayoutLockMs) {
    return timingFail(TIMING_REASON.fiberPayoutLockAboveHubMaximum(payoutTlcExpiryLimitMs, profile.maxPayoutLockMs));
  }

  const holdCltvExpiry = Math.max(lnHoldCltvCovering(profile, payoutTlcExpiryLimitMs), LND_MIN_INVOICE_CLTV_EXPIRY);
  if (holdCltvExpiry + profile.payerRouteBudgetBlocks > profile.payerMaxCltv) {
    return timingFail(TIMING_REASON.holdCltvAbovePayerMaximum(holdCltvExpiry, profile.payerRouteBudgetBlocks, profile.payerMaxCltv));
  }

  return timingOk({ holdCltvExpiry, payoutTlcExpiryLimitMs });
}

/**
 * ln_to_fiber, when the incoming HTLC is ACCEPTED: is there still time to pay out on Fiber? Converts the blocks left
 * before the earliest HTLC's auto-cancel point into time with the fast interval and requires it to cover the payout
 * limit. Returns the payout limit to use now (it may shrink as blocks pass).
 *
 * lnMarginBlocks stay free before the auto-cancel point so the hub can settle. A freshly accepted HTLC with the planned
 * CLTV gets the planned limit back, and LND's block padding in the plan absorbs the first blocks mined before paying
 * out. After that the limit shrinks with every block; it may lose the plan's fiberMarginMs but never the payout
 * invoice's final delta and hop budget, below which the payout cannot route. It never exceeds maxPayoutLockMs, so a
 * swap planned under a looser cap is refunded rather than paid with a longer lock.
 */
export function checkLnToFiberPayout(
  profile: TimingProfile,
  input: { earliestHtlcExpiryHeight: number; currentHeight: number; plannedTlcExpiryLimitMs: number },
): TimingResult<{ payoutTlcExpiryLimitMs: number }> {
  const invalidField = findInvalidField(input);
  if (invalidField) return timingFail(TIMING_REASON.invalidInput(invalidField));

  const { earliestHtlcExpiryHeight, currentHeight, plannedTlcExpiryLimitMs } = input;
  const availableMs = fiberLockBeforeLnAutoCancelMs(profile, earliestHtlcExpiryHeight, currentHeight);
  const payoutTlcExpiryLimitMs = Math.floor(Math.min(plannedTlcExpiryLimitMs, availableMs, profile.maxPayoutLockMs));
  const neededMs = Math.max(plannedTlcExpiryLimitMs - profile.fiberMarginMs, FIBER_MIN_FINAL_EXPIRY_DELTA_MS);
  if (payoutTlcExpiryLimitMs < neededMs) {
    return timingFail(TIMING_REASON.notEnoughTimeForFiberPayout(payoutTlcExpiryLimitMs, neededMs));
  }

  return timingOk({ payoutTlcExpiryLimitMs });
}

/**
 * fiber_to_ln, at swap creation. The user pays a Fiber hold invoice; the hub pays the user's Lightning invoice.
 * Returns the hold invoice's `final_expiry_delta` (ms): the configured value, raised if needed so the Lightning payout
 * (payee's min_final_cltv plus route) fits inside the hold window after fnn's early-fail margin. Fails when even the
 * maximum would not fit.
 *
 * The payout needs the smallest cltv_limit LND takes for the invoice (its CLTV plus LND's padding, plus one block) and
 * lnRouteBudgetBlocks of room for route hops, counted at the slow interval because the Lightning HTLC can stay locked
 * that long. Fails too when those blocks could lock the hub's funds longer than the profile's maxPayoutLockMs.
 *
 * The hold is sized for a payment that arrives over a channel with `inboundCommitmentDelayEpochs`: fnn's default (the
 * hub's own channels) unless the asset takes channels nodes open with a delay of their choosing, which the caller then
 * passes as the longest it assumes. lnPayoutCltvLimit checks the real early-fail point of what is held before paying out.
 */
export function planFiberToLn(
  profile: TimingProfile,
  input: { payoutCltvExpiry: number; configuredHoldFinalExpiryDeltaMs: number; inboundCommitmentDelayEpochs?: number },
): TimingResult<{ holdFinalExpiryDeltaMs: number }> {
  const checked = { ...input, inboundCommitmentDelayEpochs: input.inboundCommitmentDelayEpochs ?? FIBER_DEFAULT_COMMITMENT_DELAY_EPOCHS };
  const invalidField = findInvalidField(checked);
  if (invalidField) return timingFail(TIMING_REASON.invalidInput(invalidField));

  const minCltvLimit = minLnCltvLimit(input.payoutCltvExpiry);
  if (minCltvLimit > LND_MAX_CLTV_LIMIT) return timingFail(TIMING_REASON.payoutCltvAboveLndMaximum(minCltvLimit));
  const routedCltvLimit = minCltvLimit + profile.lnRouteBudgetBlocks;
  const maxCltvLimit = maxPayoutCltvLimit(profile);
  if (routedCltvLimit > maxCltvLimit) {
    return timingFail(TIMING_REASON.lnPayoutLockAboveHubMaximum(routedCltvLimit, maxCltvLimit, profile.maxPayoutLockMs));
  }

  const payoutWindowMs = blocksToMs(routedCltvLimit, slowBlockMs(profile));
  const holdFinalExpiryDeltaMs = Math.ceil(
    Math.max(
      input.configuredHoldFinalExpiryDeltaMs,
      payoutWindowMs + fiberHoldReserveMs(profile, checked.inboundCommitmentDelayEpochs),
      FIBER_MIN_FINAL_EXPIRY_DELTA_MS,
    ),
  );
  if (holdFinalExpiryDeltaMs > FIBER_MAX_TLC_EXPIRY_LIMIT_MS) {
    return timingFail(TIMING_REASON.holdDeltaAboveFiberMaximum(holdFinalExpiryDeltaMs));
  }

  return timingOk({ holdFinalExpiryDeltaMs });
}

/**
 * fiber_to_ln, when the incoming Fiber TLC is held: the `cltv_limit` for the Lightning payout,
 *   floor((heldTlcFailsAt - now - fiberMarginMs) / slowBlockMs)
 * where heldTlcFailsAt is when fnn fails the earliest held TLC: its expiry less the early-fail margin of the channel it
 * arrived on (fiberHeldTlcFailsAt), which the channel's opener sets through its commitment delay.
 * Fails when it is below the payout invoice's own cltv requirement (then the hub must not pay and should refund).
 *
 * The requirement is the smallest limit LND takes: above the final CLTV plus the 3 blocks LND adds to it, which count
 * against `cltv_limit` (minLnCltvLimit). The limit is also capped at LND's `max-cltv-expiry`, above which LND refuses
 * the payment, and at the profile's payout lock cap.
 */
export function lnPayoutCltvLimit(
  profile: TimingProfile,
  input: { heldTlcFailsAt: number; now: number; payoutCltvExpiry: number },
): TimingResult<{ cltvLimit: number }> {
  const invalidField = findInvalidField(input);
  if (invalidField) return timingFail(TIMING_REASON.invalidInput(invalidField));

  const payoutWindowMs = input.heldTlcFailsAt - input.now - profile.fiberMarginMs;
  const cltvLimit = Math.min(
    blocksWithinMs(payoutWindowMs, slowBlockMs(profile)),
    LND_MAX_CLTV_LIMIT,
    maxPayoutCltvLimit(profile),
  );
  const minCltvLimit = minLnCltvLimit(input.payoutCltvExpiry);
  if (cltvLimit < minCltvLimit) return timingFail(TIMING_REASON.notEnoughTimeForLnPayout(cltvLimit, minCltvLimit));

  return timingOk({ cltvLimit });
}

/** ln_to_fiber: the last height at which the hub can still settle the incoming HTLC (LND auto-cancels after). */
export function lnSettleDeadlineHeight(profile: TimingProfile, earliestHtlcExpiryHeight: number): number {
  return lnAutoCancelHeight(profile, earliestHtlcExpiryHeight) - 1;
}
