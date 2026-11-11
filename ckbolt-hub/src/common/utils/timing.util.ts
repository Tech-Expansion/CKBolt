import {
  FIBER_EPOCH_MS,
  FIBER_HELD_TLC_CHECK_INTERVAL_MS,
  FIBER_HELD_TLC_EARLY_FAIL_SHARE,
  MS_PER_MINUTE,
} from "../constants/protocol.constants";

/** Decimals shown when a duration is written in minutes for people. */
const MINUTES_DISPLAY_DECIMALS = 1;

/** Blocks needed so that `durationMs` cannot run out early when a block arrives every `blockMs` (rounds up). */
export const blocksCoveringMs = (durationMs: number, blockMs: number): number => Math.ceil(durationMs / blockMs);

/** Whole blocks that fit inside `durationMs` when a block arrives every `blockMs` (rounds down). */
export const blocksWithinMs = (durationMs: number, blockMs: number): number => Math.floor(durationMs / blockMs);

/** Time that `blocks` blocks take when a block arrives every `blockMs`. */
export const blocksToMs = (blocks: number, blockMs: number): number => blocks * blockMs;

/**
 * How long before its expiry fnn fails a held incoming TLC that arrived over a channel with this commitment delay:
 * floor(epochs x epoch length x 2 / 3), as fnn's tlc_expiry_delay computes it, plus one held-TLC check interval.
 */
export const fiberHeldTlcEarlyFailMs = (commitmentDelayEpochs: number): number =>
  Math.floor((commitmentDelayEpochs * FIBER_EPOCH_MS * FIBER_HELD_TLC_EARLY_FAIL_SHARE.numerator) / FIBER_HELD_TLC_EARLY_FAIL_SHARE.denominator) +
  FIBER_HELD_TLC_CHECK_INTERVAL_MS;

/** A duration in minutes for messages: "160 minutes", "9.5 minutes", "1 minute". */
export const formatMinutes = (durationMs: number): string => {
  const minutes = Number((durationMs / MS_PER_MINUTE).toFixed(MINUTES_DISPLAY_DECIMALS));
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
};
