import { baseUnitsPerWhole, formatBaseUnits, median, roundToDecimals, toScaledInteger } from "../../../src/common/utils/pricing.util";

describe("pricing utils", () => {
  describe("median", () => {
    it.each([
      [[5], 5],
      [[3, 1, 2], 2],
      [[80_000, 90_000, 81_000], 81_000],
      [[1, 4], 2.5],
      [[4, 1, 3, 2], 2.5],
      [[0.002, 0.0021, 0.0019], 0.002],
    ])("median of %j is %d", (values, expected) => {
      expect(median(values)).toBeCloseTo(expected, 12);
    });

    it("does not reorder the caller's list", () => {
      const values = [3, 1, 2];
      median(values);
      expect(values).toEqual([3, 1, 2]);
    });

    it("refuses an empty list instead of returning NaN", () => {
      expect(() => median([])).toThrow(RangeError);
    });

    it("sorts numerically, not as strings", () => {
      expect(median([100, 9, 20])).toBe(20);
    });
  });

  describe("roundToDecimals", () => {
    it("removes float noise below the kept digits", () => {
      expect(roundToDecimals(0.1 + 0.2, 12)).toBe(0.3);
      expect(roundToDecimals(0.0020499999999999997, 12)).toBe(0.00205);
    });
  });

  describe("baseUnitsPerWhole", () => {
    it("is 10^decimals as bigint", () => {
      expect(baseUnitsPerWhole(8)).toBe(100_000_000n);
      expect(baseUnitsPerWhole(0)).toBe(1n);
    });
  });

  describe("toScaledInteger", () => {
    it.each([
      [0.0021, 6, 2_100n],
      [80_000, 12, 80_000_000_000_000_000n],
      [0.002, 12, 2_000_000_000n],
      [1, 0, 1n],
      [0, 4, 0n],
    ])("%d scaled by 10^%d is %s", (value, decimals, expected) => {
      expect(toScaledInteger(value, decimals)).toBe(expected);
    });

    it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, -0.000001])("refuses %d", (value) => {
      expect(() => toScaledInteger(value, 6)).toThrow(RangeError);
    });
  });

  describe("formatBaseUnits", () => {
    it.each([
      [150_000_000n, 8, "1.5"],
      [100_000_000n, 8, "1"],
      [1n, 8, "0.00000001"],
      [0n, 8, "0"],
      [396_000_000_000n, 8, "3960"],
      [123_456_789_012n, 8, "1234.56789012"],
    ])("%s base units with %d decimals reads %s", (amount, decimals, expected) => {
      expect(formatBaseUnits(amount, decimals)).toBe(expected);
    });
  });
});
