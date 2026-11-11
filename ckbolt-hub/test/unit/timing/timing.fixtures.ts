import {
  FIBER_DEFAULT_HOP_EXPIRY_DELTA_MS,
  FIBER_HELD_TLC_EARLY_FAIL_MS,
  MS_PER_DAY,
  MS_PER_HOUR,
  MS_PER_MINUTE,
  MS_PER_SECOND,
} from "../../../src/common/constants/protocol.constants";
import { TIMING_PROFILES, type TimingProfileName } from "../../../src/common/constants/timing.constants";
import type { TimingProfile, TimingResult } from "../../../src/domain/timing/timing.types";

/**
 * Shared fixtures for the timing policy tests. Expected values in the specs are worked out by hand from
 * docs/research/lnd.md 6.4 and fiber-node.md 7.1-7.2; these helpers only restate the rules' terms so the specs read like
 * the formulas. They deliberately do not import the implementation's own helpers (timing.budget.ts), so the tests stay an
 * independent check.
 */

/** LND's sender adds this many blocks to the payee's final CLTV, and they count against cltv_limit (lnd.md 2.4). */
export const LND_SENDER_BLOCK_PADDING = 3;

/**
 * Smallest cltv_limit LND pays an invoice with: LND refuses a limit that is not above the final CLTV plus its padding
 * (routing.ValidateCLTVLimit, "cltv limit X should be greater than Y"), so one block more than the sum.
 */
export const payableCltvLimit = (payoutCltvExpiry: number): number => payoutCltvExpiry + LND_SENDER_BLOCK_PADDING + 1;

export const PROFILE_NAMES = Object.keys(TIMING_PROFILES) as TimingProfileName[];

export const profile = (name: TimingProfileName): TimingProfile => ({ ...TIMING_PROFILES[name] });

/** A profile based on a named one with some fields changed, for edge cases the shipped profiles never reach. */
export const profileWith = (base: TimingProfileName, patch: Partial<TimingProfile>): TimingProfile => ({
  ...TIMING_PROFILES[base],
  ...patch,
  name: `${base}-custom`,
});

export const seconds = (n: number): number => n * MS_PER_SECOND;
export const minutes = (n: number): number => n * MS_PER_MINUTE;
export const hours = (n: number): number => n * MS_PER_HOUR;
export const days = (n: number): number => n * MS_PER_DAY;

export const fastBlockMs = (p: TimingProfile): number => seconds(p.btcFastBlockSeconds);
export const slowBlockMs = (p: TimingProfile): number => seconds(p.btcSlowBlockSeconds);

/** F_max of lnd.md 6.4 before rounding: the payee's final delta, the budgeted hop deltas and the hub's Fiber margin. */
export const fiberPayoutLock = (p: TimingProfile, finalExpiryDeltaMs: number): number =>
  finalExpiryDeltaMs + p.maxFiberHops * FIBER_DEFAULT_HOP_EXPIRY_DELTA_MS + p.fiberMarginMs;

/** Time at the end of a held Fiber TLC the Lightning payout may not use (fnn early fail plus the hub's margin). */
export const fiberHoldReserve = (p: TimingProfile): number => FIBER_HELD_TLC_EARLY_FAIL_MS + p.fiberMarginMs;

/** When fnn fails a held TLC that expires at `expiresAt` and came over a channel with the default commitment delay. */
export const failsAtOnDefaultChannel = (expiresAt: number): number => expiresAt - FIBER_HELD_TLC_EARLY_FAIL_MS;

/** Height at which LND cancels an accepted hold invoice by itself: its holdexpirydelta before the earliest HTLC expiry. */
export const autoCancelHeight = (p: TimingProfile, earliestHtlcExpiryHeight: number): number =>
  earliestHtlcExpiryHeight - p.lndHoldExpiryDeltaBlocks;

/** Narrows a TimingResult to its success branch, failing the test with the refusal's reason otherwise. */
export function expectPlan<T extends object>(result: TimingResult<T>): { ok: true } & T {
  if (!result.ok) throw new Error(`Expected a timing plan, got a refusal: ${result.reason}`);
  return result;
}

/** Asserts a refusal shaped exactly { ok: false, reason } with a plain sentence, and returns the reason. */
export function expectRefusal<T extends object>(result: TimingResult<T>): string {
  if (result.ok) throw new Error(`Expected a refusal, got a plan: ${JSON.stringify(result)}`);
  expect(Object.keys(result).sort()).toEqual(["ok", "reason"]);
  expectPlainSentence(result.reason);
  return result.reason;
}

/** A sentence a person can read: starts with a capital, ends with a full stop, no leaked JS values. */
export function expectPlainSentence(text: string): void {
  expect(text).toMatch(/^[A-Z][\s\S]*\.$/);
  expect(text).not.toMatch(/NaN|undefined|null|Infinity|\[object/);
}
