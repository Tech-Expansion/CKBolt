import {
  FIBER_DEFAULT_COMMITMENT_DELAY_EPOCHS,
  FIBER_HELD_TLC_EARLY_FAIL_MS,
  FIBER_MAX_COMMITMENT_DELAY_EPOCHS,
} from "../../../src/common/constants/protocol.constants";
import {
  blocksCoveringMs,
  blocksToMs,
  blocksWithinMs,
  fiberHeldTlcEarlyFailMs,
  formatMinutes,
} from "../../../src/common/utils/timing.util";
import { hours, minutes, seconds } from "./timing.fixtures";

/** Block/time conversions shared by the timing policy (common/utils/timing.util.ts). */
describe("common: timing.util", () => {
  const BLOCK = seconds(30);

  it("blocksCoveringMs rounds up, so a time budget never runs out early", () => {
    expect(blocksCoveringMs(0, BLOCK)).toBe(0);
    expect(blocksCoveringMs(1, BLOCK)).toBe(1);
    expect(blocksCoveringMs(BLOCK, BLOCK)).toBe(1);
    expect(blocksCoveringMs(BLOCK + 1, BLOCK)).toBe(2);
  });

  it("blocksWithinMs rounds down, so a limit never overshoots", () => {
    expect(blocksWithinMs(BLOCK - 1, BLOCK)).toBe(0);
    expect(blocksWithinMs(2 * BLOCK - 1, BLOCK)).toBe(1);
    expect(blocksWithinMs(2 * BLOCK, BLOCK)).toBe(2);
    expect(blocksWithinMs(-1, BLOCK)).toBe(-1);
  });

  it("blocksToMs multiplies blocks by the interval", () => {
    expect(blocksToMs(820, BLOCK)).toBe(minutes(410));
    expect(blocksToMs(0, BLOCK)).toBe(0);
  });

  describe("fiberHeldTlcEarlyFailMs: 2/3 of the inbound channel's commitment delay (4 h epochs) plus fnn's 60 s check", () => {
    it("is 160 min + 60 s for fnn's default delay of 1 epoch, the constant the hub plans its own channels with", () => {
      expect(fiberHeldTlcEarlyFailMs(FIBER_DEFAULT_COMMITMENT_DELAY_EPOCHS)).toBe(minutes(161));
      expect(fiberHeldTlcEarlyFailMs(FIBER_DEFAULT_COMMITMENT_DELAY_EPOCHS)).toBe(FIBER_HELD_TLC_EARLY_FAIL_MS);
    });

    it("is 224 h + 60 s for the longest delay fnn accepts from an opener (84 epochs = 14 days)", () => {
      expect(fiberHeldTlcEarlyFailMs(FIBER_MAX_COMMITMENT_DELAY_EPOCHS)).toBe(hours(224) + seconds(60));
    });

    it("grows with the delay: 2 epochs = 320 min + 60 s", () => {
      expect(fiberHeldTlcEarlyFailMs(2)).toBe(minutes(321));
    });
  });

  it.each([
    [minutes(160), "160 minutes"],
    [seconds(570), "9.5 minutes"],
    [minutes(1), "1 minute"],
    [0, "0 minutes"],
    [minutes(20_160), "20160 minutes"],
  ])("formatMinutes(%d) is %p", (ms, text) => {
    expect(formatMinutes(ms)).toBe(text);
  });
});
