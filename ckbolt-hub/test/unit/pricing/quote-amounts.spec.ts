import {
  amountsFromLegs,
  assertFeeBps,
  fixesLightningLeg,
  hasEmptyLeg,
  legsOf,
  lightningIsIncoming,
  payoutAmount,
  quoteAmounts,
  type ExchangeTerms,
} from "../../../src/domain/pricing";
import type { Direction, QuoteRequest } from "../../../src/domain/types";
import {
  BASE_UNITS_PER_WHOLE,
  BTC_USD,
  CKB_USD,
  ceilDivide,
  floorDiv,
  fractionOf,
  SATS_PER_BTC,
  SHANNONS_PER_SAT,
  seededRandom,
  TOTAL_FEE_BPS,
} from "./pricing.fixtures";

const DECIMALS = 8;
const terms = (patch: Partial<ExchangeTerms> = {}): ExchangeTerms => ({
  btcUsd: BTC_USD,
  assetUsd: CKB_USD,
  assetDecimals: DECIMALS,
  feeBps: TOTAL_FEE_BPS,
  ...patch,
});
const ckbTerms = terms();
const rusdTerms = terms({ assetUsd: 1 });
const cwbtcTerms = terms({ assetUsd: BTC_USD });

type Side = QuoteRequest["side"];
const request = (direction: Direction, side: Side, amount: bigint) => ({ direction, side, amount });

describe("domain pricing: quote amounts", () => {
  describe("hand-worked cases at 1 BTC = $80,000, 1 CKB = $0.002, fee 100 bps (1 sat = 40,000,000 shannons)", () => {
    it.each`
      label                                                    | direction        | side         | amount                | t             | sats        | fiberAmount
      ${"ln_to_fiber pay 10,000 sats: 4,000 CKB less 1 %"}     | ${"ln_to_fiber"} | ${"pay"}     | ${10_000n}            | ${ckbTerms}   | ${10_000n}  | ${396_000_000_000n}
      ${"ln_to_fiber receive 3,960 CKB: exactly 10,000 sats"}  | ${"ln_to_fiber"} | ${"receive"} | ${396_000_000_000n}   | ${ckbTerms}   | ${10_000n}  | ${396_000_000_000n}
      ${"ln_to_fiber receive one shannon more: pays a sat up"} | ${"ln_to_fiber"} | ${"receive"} | ${396_000_000_001n}   | ${ckbTerms}   | ${10_001n}  | ${396_000_000_001n}
      ${"fiber_to_ln pay 4,000 CKB: 10,000 sats less 1 %"}     | ${"fiber_to_ln"} | ${"pay"}     | ${400_000_000_000n}   | ${ckbTerms}   | ${9_900n}   | ${400_000_000_000n}
      ${"fiber_to_ln pay one shannon short of 9,901 sats"}     | ${"fiber_to_ln"} | ${"pay"}     | ${400_040_404_040n}   | ${ckbTerms}   | ${9_900n}   | ${400_040_404_040n}
      ${"fiber_to_ln pay just enough for 9,901 sats"}          | ${"fiber_to_ln"} | ${"pay"}     | ${400_040_404_041n}   | ${ckbTerms}   | ${9_901n}   | ${400_040_404_041n}
      ${"fiber_to_ln receive 9,900 sats: exactly 4,000 CKB"}   | ${"fiber_to_ln"} | ${"receive"} | ${9_900n}             | ${ckbTerms}   | ${9_900n}   | ${400_000_000_000n}
      ${"fiber_to_ln receive 9,901 sats: CKB rounded up"}      | ${"fiber_to_ln"} | ${"receive"} | ${9_901n}             | ${ckbTerms}   | ${9_901n}   | ${400_040_404_041n}
      ${"RUSD ln_to_fiber pay 10,000 sats: $8 less 1 %"}       | ${"ln_to_fiber"} | ${"pay"}     | ${10_000n}            | ${rusdTerms}  | ${10_000n}  | ${792_000_000n}
      ${"RUSD fiber_to_ln pay 8 RUSD: 10,000 sats less 1 %"}   | ${"fiber_to_ln"} | ${"pay"}     | ${800_000_000n}       | ${rusdTerms}  | ${9_900n}   | ${800_000_000n}
      ${"cWBTC ln_to_fiber pay 10,000 sats: 1:1 less 1 %"}     | ${"ln_to_fiber"} | ${"pay"}     | ${10_000n}            | ${cwbtcTerms} | ${10_000n}  | ${9_900n}
      ${"cWBTC fiber_to_ln receive 9,900 sats"}                | ${"fiber_to_ln"} | ${"receive"} | ${9_900n}             | ${cwbtcTerms} | ${9_900n}   | ${10_000n}
      ${"cWBTC fiber_to_ln receive 9,901 sats: rounded up"}    | ${"fiber_to_ln"} | ${"receive"} | ${9_901n}             | ${cwbtcTerms} | ${9_901n}   | ${10_002n}
      ${"cWBTC ln_to_fiber pay 1 sat: rounds down to nothing"} | ${"ln_to_fiber"} | ${"pay"}     | ${1n}                 | ${cwbtcTerms} | ${1n}       | ${0n}
    `("$label", ({ direction, side, amount, t, sats, fiberAmount }) => {
      expect(quoteAmounts(request(direction, side, amount), t)).toEqual({ sats, fiberAmount });
    });

    it("rounds a non-integer payout down: 10,000 sats at CKB $0.0021 is 3771.428571428... CKB", () => {
      expect(quoteAmounts(request("ln_to_fiber", "pay", 10_000n), terms({ assetUsd: 0.0021 }))).toEqual({
        sats: 10_000n,
        fiberAmount: 377_142_857_142n,
      });
    });

    it("with no fee, pays the fair amount", () => {
      expect(quoteAmounts(request("ln_to_fiber", "pay", 10_000n), terms({ feeBps: 0 }))).toEqual({
        sats: 10_000n,
        fiberAmount: 10_000n * SHANNONS_PER_SAT,
      });
      expect(quoteAmounts(request("fiber_to_ln", "pay", 10_000n * SHANNONS_PER_SAT), terms({ feeBps: 0 }))).toEqual({
        sats: 10_000n,
        fiberAmount: 10_000n * SHANNONS_PER_SAT,
      });
    });
  });

  describe("fee applied once", () => {
    it("takes exactly feeBps of the payout, not twice and not compounded", () => {
      const fair = 10_000n * SHANNONS_PER_SAT;
      const { fiberAmount } = quoteAmounts(request("ln_to_fiber", "pay", 10_000n), terms({ feeBps: 100 }));

      expect(fiberAmount).toBe((fair * 99n) / 100n);
      expect(fiberAmount).not.toBe((fair * 98n) / 100n);
      expect(fiberAmount).not.toBe((fair * 99n * 99n) / 10_000n);
    });

    it("costs the user the same whichever side is fixed", () => {
      const paid = quoteAmounts(request("ln_to_fiber", "pay", 50_000n), ckbTerms);
      const received = quoteAmounts(request("ln_to_fiber", "receive", paid.fiberAmount), ckbTerms);

      expect(received).toEqual(paid);
    });

    it("costs more as the fee rises, in both directions and on both sides", () => {
      for (const direction of ["ln_to_fiber", "fiber_to_ln"] as const) {
        const low = terms({ feeBps: 10 });
        const high = terms({ feeBps: 300 });
        const amount = direction === "ln_to_fiber" ? 50_000n : 50_000n * SHANNONS_PER_SAT;

        expect(legsOf(direction, quoteAmounts(request(direction, "pay", amount), high)).outgoing).toBeLessThan(
          legsOf(direction, quoteAmounts(request(direction, "pay", amount), low)).outgoing,
        );
        const out = direction === "ln_to_fiber" ? 400_000_000_000n : 20_000n;
        expect(legsOf(direction, quoteAmounts(request(direction, "receive", out), high)).incoming).toBeGreaterThan(
          legsOf(direction, quoteAmounts(request(direction, "receive", out), low)).incoming,
        );
      }
    });
  });

  describe("both sides: which leg is fixed", () => {
    it.each`
      direction        | side         | fixed
      ${"ln_to_fiber"} | ${"pay"}     | ${"sats"}
      ${"ln_to_fiber"} | ${"receive"} | ${"fiberAmount"}
      ${"fiber_to_ln"} | ${"pay"}     | ${"fiberAmount"}
      ${"fiber_to_ln"} | ${"receive"} | ${"sats"}
    `("$direction side=$side keeps $fixed exactly as asked", ({ direction, side, fixed }) => {
      const amount = 123_457n;
      const amounts = quoteAmounts(request(direction, side, amount), ckbTerms);

      expect(amounts[fixed as "sats" | "fiberAmount"]).toBe(amount);
    });
  });

  describe("rounding in the hub's favour, checked against exact rationals (seeded property test)", () => {
    const random = seededRandom(0xc4b017);
    const int = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));

    /** Prices exact in binary and in at most 12 decimals, so the expected rationals are exact. */
    const cases = Array.from({ length: 400 }, (_, i) => {
      const btcUsd = int(20_000, 150_000) + int(0, 3) / 4;
      const ckbUsd = int(2, 40) / 4_096;
      const assetUsd = [ckbUsd, 1, btcUsd][i % 3] as number;
      const direction: Direction = i % 2 === 0 ? "ln_to_fiber" : "fiber_to_ln";
      const side: Side = Math.floor(i / 2) % 2 === 0 ? "pay" : "receive";
      const feeBps = int(0, 500);
      const satsAmount = BigInt(int(1, 200_000));
      const fiberAmount = BigInt(int(1, 2_000_000)) * BigInt(int(1, 5_000_000));
      return { btcUsd, assetUsd, direction, side, feeBps, satsAmount, fiberAmount };
    });

    it.each(cases.map((c, i) => [i, c] as const))("case %i", (_i, c) => {
      const btc = fractionOf(c.btcUsd);
      const asset = fractionOf(c.assetUsd);
      // Fair Fiber base units per sat = (btcUsd / sats per BTC) / (assetUsd / base units per whole).
      const fairNum = btc.num * asset.den * BASE_UNITS_PER_WHOLE;
      const fairDen = btc.den * asset.num * SATS_PER_BTC;
      const keep = BigInt(10_000 - c.feeBps);
      const whole = 10_000n;
      const t = terms({ btcUsd: c.btcUsd, assetUsd: c.assetUsd, feeBps: c.feeBps });

      const fixedLightning = (c.direction === "ln_to_fiber") === (c.side === "pay");
      const amount = fixedLightning ? c.satsAmount : c.fiberAmount;
      const got = quoteAmounts(request(c.direction, c.side, amount), t);

      if (c.direction === "ln_to_fiber" && c.side === "pay") {
        expect(got).toEqual({ sats: amount, fiberAmount: floorDiv(amount * fairNum * keep, fairDen * whole) });
      } else if (c.direction === "ln_to_fiber") {
        expect(got).toEqual({ sats: ceilDivide(amount * fairDen * whole, fairNum * keep), fiberAmount: amount });
      } else if (c.side === "pay") {
        expect(got).toEqual({ sats: floorDiv(amount * fairDen * keep, fairNum * whole), fiberAmount: amount });
      } else {
        expect(got).toEqual({ sats: amount, fiberAmount: ceilDivide(amount * fairNum * whole, fairDen * keep) });
      }

      // The invariant behind it: the user's payout is never worth more than (1 - fee) of what the user pays.
      if (c.direction === "ln_to_fiber") expect(got.fiberAmount * fairDen * whole).toBeLessThanOrEqual(got.sats * fairNum * keep);
      else expect(got.sats * fairNum * whole).toBeLessThanOrEqual(got.fiberAmount * fairDen * keep);
    });
  });

  describe("rounding in the hub's favour at realistic prices with cents (not exact in binary)", () => {
    // 80000.12 is stored as 80000.1199999999953... in a double. The amounts must still follow the price as stated:
    // 22,523 sats x $80,000.12 / $0.002345 / 0.99 = 776,137,797,058.000...04 shannons, so the user pays ...059.
    it("fiber_to_ln receive 22,523 sats at BTC $80,000.12, CKB $0.002345: the user pays the stated amount rounded up", () => {
      const t = terms({ btcUsd: 80_000.12, assetUsd: 0.002345, feeBps: 100 });

      expect(String(quoteAmounts(request("fiber_to_ln", "receive", 22_523n), t).fiberAmount)).toBe("776137797059");
    });

    it.each([22_523n, 34_477n, 45_046n, 57_000n, 67_569n])("fiber_to_ln receive %s sats at BTC $80,000.12 is never under-charged", (sats) => {
      const btc = fractionOf(80_000.12);
      const ckb = fractionOf(0.002345);
      const keep = 9_900n;
      const exact = ceilDivide(sats * btc.num * ckb.den * 10_000n, btc.den * ckb.num * keep);

      const charged = quoteAmounts(request("fiber_to_ln", "receive", sats), terms({ btcUsd: 80_000.12, assetUsd: 0.002345, feeBps: 100 })).fiberAmount;

      // Compared as strings: jest workers cannot report a failed bigint comparison.
      expect(String(charged)).toBe(String(exact));
    });
  });

  describe("errors and edge cases", () => {
    it.each([0, 1, 100, 9_999])("accepts a total fee of %d bps", (fee) => {
      expect(() => assertFeeBps(fee)).not.toThrow();
    });

    it.each([10_000, 12_000, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("refuses a total fee of %d bps", (fee) => {
      expect(() => assertFeeBps(fee)).toThrow(RangeError);
      expect(() => quoteAmounts(request("ln_to_fiber", "receive", 1_000n), terms({ feeBps: fee }))).toThrow(RangeError);
    });

    it("refuses a negative amount", () => {
      expect(() => quoteAmounts(request("ln_to_fiber", "pay", -1n), ckbTerms)).toThrow(RangeError);
      expect(() => quoteAmounts(request("fiber_to_ln", "receive", -5n), ckbTerms)).toThrow(RangeError);
    });

    it("refuses prices it cannot quote with", () => {
      expect(() => quoteAmounts(request("ln_to_fiber", "pay", 1_000n), terms({ assetUsd: 0 }))).toThrow(RangeError);
      expect(() => quoteAmounts(request("ln_to_fiber", "pay", 1_000n), terms({ btcUsd: Number.NaN }))).toThrow(RangeError);
      expect(() => quoteAmounts(request("ln_to_fiber", "pay", 1_000n), terms({ btcUsd: -80_000 }))).toThrow(RangeError);
    });

    it("keeps exact bigint precision for amounts beyond 2^53", () => {
      const huge = 2n ** 70n;
      const { fiberAmount } = quoteAmounts(request("ln_to_fiber", "pay", huge), terms({ feeBps: 0 }));

      expect(fiberAmount).toBe(huge * SHANNONS_PER_SAT);
    });

    it("hasEmptyLeg flags a quote where either leg is nothing", () => {
      expect(hasEmptyLeg({ sats: 0n, fiberAmount: 5n })).toBe(true);
      expect(hasEmptyLeg({ sats: 5n, fiberAmount: 0n })).toBe(true);
      expect(hasEmptyLeg({ sats: 1n, fiberAmount: 1n })).toBe(false);
      expect(hasEmptyLeg(quoteAmounts(request("fiber_to_ln", "pay", 1n), ckbTerms))).toBe(true);
    });
  });
});

describe("domain pricing: legs", () => {
  const amounts = { sats: 7n, fiberAmount: 9n };

  it("Lightning is the incoming leg only for ln_to_fiber", () => {
    expect(lightningIsIncoming("ln_to_fiber")).toBe(true);
    expect(lightningIsIncoming("fiber_to_ln")).toBe(false);
  });

  it("maps amounts to incoming/outgoing legs and back", () => {
    expect(legsOf("ln_to_fiber", amounts)).toEqual({ incoming: 7n, outgoing: 9n });
    expect(legsOf("fiber_to_ln", amounts)).toEqual({ incoming: 9n, outgoing: 7n });
    for (const direction of ["ln_to_fiber", "fiber_to_ln"] as const) {
      expect(amountsFromLegs(direction, legsOf(direction, amounts))).toEqual(amounts);
    }
  });

  it("pays out on Fiber for ln_to_fiber and on Lightning for fiber_to_ln", () => {
    expect(payoutAmount("ln_to_fiber", amounts)).toBe(9n);
    expect(payoutAmount("fiber_to_ln", amounts)).toBe(7n);
  });

  it.each`
    direction        | side         | fixesLightning
    ${"ln_to_fiber"} | ${"pay"}     | ${true}
    ${"ln_to_fiber"} | ${"receive"} | ${false}
    ${"fiber_to_ln"} | ${"pay"}     | ${false}
    ${"fiber_to_ln"} | ${"receive"} | ${true}
  `("$direction side=$side fixes the Lightning leg: $fixesLightning", ({ direction, side, fixesLightning }) => {
    expect(fixesLightningLeg({ direction, side })).toBe(fixesLightning);
  });
});
