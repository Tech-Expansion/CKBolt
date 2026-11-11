import {
  FIBER_MAX_TLC_EXPIRY_LIMIT_MS,
  FIBER_MIN_FINAL_EXPIRY_DELTA_MS,
  LND_MAX_CLTV_LIMIT,
} from "../../common/constants/protocol.constants";
import { formatMinutes } from "../../common/utils/timing.util";

/** Plain sentences for every timing plan the hub refuses. The only place these messages are written. */
export const TIMING_REASON = {
  invalidInput: (field: string): string => `The timing input ${field} must be a finite number that is not negative.`,

  payoutDeltaBelowFiberMinimum: (finalExpiryDeltaMs: number): string =>
    `The Fiber invoice's final expiry delta is ${formatMinutes(finalExpiryDeltaMs)}, below Fiber's minimum of ` +
    `${formatMinutes(FIBER_MIN_FINAL_EXPIRY_DELTA_MS)}. Make a new invoice with a longer final expiry delta.`,

  payoutLockAboveFiberMaximum: (lockMs: number): string =>
    `Paying this Fiber invoice could lock funds for ${formatMinutes(lockMs)}, above Fiber's limit of ` +
    `${formatMinutes(FIBER_MAX_TLC_EXPIRY_LIMIT_MS)}. Make a new invoice with a shorter final expiry delta.`,

  fiberPayoutLockAboveHubMaximum: (lockMs: number, maxLockMs: number): string =>
    `Paying this Fiber invoice could lock the hub's funds for ${formatMinutes(lockMs)}, above the hub's limit of ` +
    `${formatMinutes(maxLockMs)}. Make a new invoice with a shorter final expiry delta.`,

  holdCltvAbovePayerMaximum: (holdCltvExpiry: number, payerRouteBudgetBlocks: number, payerMaxCltv: number): string =>
    `The Lightning hold invoice would need a CLTV expiry of ${holdCltvExpiry} blocks; with ${payerRouteBudgetBlocks} blocks ` +
    `for the payer's route that is ${holdCltvExpiry + payerRouteBudgetBlocks}, above the ${payerMaxCltv} blocks payers ` +
    `accept. Make a new Fiber invoice with a shorter final expiry delta.`,

  notEnoughTimeForFiberPayout: (usableMs: number, neededMs: number): string =>
    `The Fiber payout can lock funds for at most ${formatMinutes(Math.max(usableMs, 0))} before the Lightning payment ` +
    `must be settled, and it needs ${formatMinutes(neededMs)}.`,

  payoutCltvAboveLndMaximum: (minCltvLimit: number): string =>
    `This Lightning invoice needs a CLTV limit of ${minCltvLimit} blocks, above the ${LND_MAX_CLTV_LIMIT} blocks LND ` +
    `will pay. Make a new invoice with a smaller CLTV expiry.`,

  lnPayoutLockAboveHubMaximum: (routedCltvLimit: number, maxCltvLimit: number, maxLockMs: number): string =>
    `Paying this Lightning invoice needs a CLTV limit of ${routedCltvLimit} blocks with its route, above the ` +
    `${maxCltvLimit} blocks (${formatMinutes(maxLockMs)}) the hub locks a payout for. Make a new invoice with a ` +
    `smaller CLTV expiry.`,

  holdDeltaAboveFiberMaximum: (holdFinalExpiryDeltaMs: number): string =>
    `The Fiber hold invoice would need a final expiry delta of ${formatMinutes(holdFinalExpiryDeltaMs)}, above ` +
    `Fiber's maximum of ${formatMinutes(FIBER_MAX_TLC_EXPIRY_LIMIT_MS)}. Make a new Lightning invoice with a smaller ` +
    `CLTV expiry.`,

  notEnoughTimeForLnPayout: (cltvLimit: number, minCltvLimit: number): string =>
    `The held Fiber payment leaves room for a Lightning payout of ${Math.max(cltvLimit, 0)} blocks, and this ` +
    `Lightning invoice needs ${minCltvLimit}.`,
} as const;
