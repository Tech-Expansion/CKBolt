import { PAYER_MAX_CLTV_LND } from "../../../src/common/constants/protocol.constants";
import { lnPayoutCltvLimit } from "../../../src/domain/timing/timing.policy";
import {
  days,
  expectPlan,
  expectRefusal,
  failsAtOnDefaultChannel,
  fiberHoldReserve,
  hours,
  minutes,
  payableCltvLimit,
  profile,
  PROFILE_NAMES,
  profileWith,
  slowBlockMs,
} from "./timing.fixtures";

/**
 * fiber_to_ln when the incoming Fiber TLC is held (lnd.md 6.4, Direction B, step 2):
 *   cltv_limit = floor((heldTlcFailsAt - now - fiberMarginMs) / t_slow)
 * where heldTlcFailsAt is the TLC's expiry less fnn's early-fail margin for its channel (FIBER_HELD_TLC_EARLY_FAIL_MS on
 * a channel with the default commitment delay), refused when it is below what the payout invoice needs (the smallest
 * limit LND takes: its CLTV plus LND's 3 padding blocks, plus one), capped at LND's 2016 and at the profile's payout
 * lock cap.
 */
describe("timing: lnPayoutCltvLimit", () => {
  const NOW = Date.UTC(2026, 9, 23, 12);
  const limitFor = (name: "mutinynet" | "regtest" | "mainnet", holdLeftMs: number, payoutCltvExpiry: number) =>
    lnPayoutCltvLimit(profile(name), { heldTlcFailsAt: failsAtOnDefaultChannel(NOW + holdLeftMs), now: NOW, payoutCltvExpiry });

  describe("worked examples", () => {
    it("mutinynet, 6 h left: (360 - 161 - 10) min / 45 s = 252 blocks", () => {
      expect(limitFor("mutinynet", hours(6), 80)).toEqual({ ok: true, cltvLimit: 252 });
    });

    it("regtest, 1506 min left: 89 blocks, 5 spare after CLTV 80, the padding and LND's extra block", () => {
      expect(limitFor("regtest", minutes(1506), 80)).toEqual({ ok: true, cltvLimit: 89 });
    });

    it("regtest, 6 h left: only 12 slow blocks, enough for CLTV 8 (8 + 3 + 1) and not for CLTV 9", () => {
      // (360 - 171) min = 11,340 s / 900 s = 12.6 -> 12.
      expect(limitFor("regtest", hours(6), 8)).toEqual({ ok: true, cltvLimit: 12 });
      expectRefusal(limitFor("regtest", hours(6), 9));
    });
  });

  describe("the payout invoice's requirement", () => {
    it("accepts when the limit is one block above the invoice CLTV plus LND's 3 padding blocks (LND's smallest)", () => {
      expect(payableCltvLimit(248)).toBe(252);
      expect(limitFor("mutinynet", hours(6), 248)).toEqual({ ok: true, cltvLimit: 252 });
    });

    it("refuses one block short, where LND would refuse the limit (252 is not above 249 + 3), naming both numbers", () => {
      const reason = expectRefusal(limitFor("mutinynet", hours(6), 249));

      expect(reason).toContain("252");
      expect(reason).toContain("253");
    });

    it("refuses an invoice whose CLTV alone is above the limit", () => {
      expectRefusal(limitFor("mutinynet", hours(6), 400));
    });
  });

  describe("rounding and caps", () => {
    it("rounds down: 252.99 blocks give 252", () => {
      expect(limitFor("mutinynet", hours(6) + 44_999, 80)).toEqual({ ok: true, cltvLimit: 252 });
      expect(limitFor("mutinynet", hours(6) + 45_000, 80)).toEqual({ ok: true, cltvLimit: 253 });
    });

    it("caps the limit at LND's max-cltv-expiry of 2016 blocks", () => {
      // 14 days - 171 min at 45 s would be 26,652 blocks; the payout lock cap is lifted to 14 days to reach LND's cap.
      const p = profileWith("mutinynet", { maxPayoutLockMs: days(14) });
      const limit = lnPayoutCltvLimit(p, { heldTlcFailsAt: failsAtOnDefaultChannel(NOW + days(14)), now: NOW, payoutCltvExpiry: 80 });
      expect(limit).toEqual({ ok: true, cltvLimit: PAYER_MAX_CLTV_LND });
    });

    it("caps the limit at the profile's payout lock cap, counted in slow blocks (mutinynet: 12 h / 45 s = 960)", () => {
      expect(limitFor("mutinynet", days(14), 80)).toEqual({ ok: true, cltvLimit: 960 });
      const p = profileWith("mutinynet", { maxPayoutLockMs: hours(2) + 44_999 });
      const limit = lnPayoutCltvLimit(p, { heldTlcFailsAt: failsAtOnDefaultChannel(NOW + days(14)), now: NOW, payoutCltvExpiry: 80 });
      expect(limit).toEqual({ ok: true, cltvLimit: 160 });
    });

    it("refuses an invoice whose CLTV does not fit under the payout lock cap however long the hold is", () => {
      const p = profileWith("mutinynet", { maxPayoutLockMs: hours(1) });
      // 1 h / 45 s = 80 blocks, and CLTV 80 needs 84.
      expectRefusal(lnPayoutCltvLimit(p, { heldTlcFailsAt: failsAtOnDefaultChannel(NOW + days(14)), now: NOW, payoutCltvExpiry: 80 }));
    });

    it("returns a whole number of blocks for an odd remaining time", () => {
      const result = expectPlan(limitFor("mainnet", hours(30) + 123.456, 80));
      expect(Number.isInteger(result.cltvLimit)).toBe(true);
    });
  });

  describe("not enough time left", () => {
    it("refuses when the held TLC is already inside fnn's early-fail window, never reporting negative blocks", () => {
      const reason = expectRefusal(limitFor("mutinynet", minutes(161), 0));

      expect(reason).toContain("0 blocks");
    });

    it("refuses when the held TLC has already expired", () => {
      expectRefusal(lnPayoutCltvLimit(profile("mutinynet"), { heldTlcFailsAt: failsAtOnDefaultChannel(NOW - minutes(5)), now: NOW, payoutCltvExpiry: 80 }));
    });

    it("refuses on every profile when only the reserve is left", () => {
      for (const name of PROFILE_NAMES) {
        const p = profile(name);
        expectRefusal(lnPayoutCltvLimit(p, { heldTlcFailsAt: failsAtOnDefaultChannel(NOW + fiberHoldReserve(p)), now: NOW, payoutCltvExpiry: 0 }));
      }
    });
  });

  describe("safety: the Lightning payout resolves before fnn early-fails the held TLC", () => {
    it.each(PROFILE_NAMES)("%s: now + cltvLimit slow blocks + reserve <= held TLC expiry, shrinking as time passes", (name) => {
      const p = profile(name);
      const heldTlcExpiresAt = NOW + hours(30);
      let previous = Number.POSITIVE_INFINITY;
      let refused = false;

      for (let now = NOW; now <= heldTlcExpiresAt; now += minutes(7)) {
        const result = lnPayoutCltvLimit(p, { heldTlcFailsAt: failsAtOnDefaultChannel(heldTlcExpiresAt), now, payoutCltvExpiry: 18 });
        if (!result.ok) {
          refused = true;
          continue;
        }
        expect(refused).toBe(false);
        expect(result.cltvLimit).toBeLessThanOrEqual(previous);
        expect(result.cltvLimit).toBeLessThanOrEqual(PAYER_MAX_CLTV_LND);
        expect(now + result.cltvLimit * slowBlockMs(p) + fiberHoldReserve(p)).toBeLessThanOrEqual(heldTlcExpiresAt);
        previous = result.cltvLimit;
      }

      expect(refused).toBe(true);
    });
  });

  describe("invalid input", () => {
    const valid = { heldTlcFailsAt: failsAtOnDefaultChannel(NOW + hours(6)), now: NOW, payoutCltvExpiry: 80 };

    it.each(Object.keys(valid))("refuses a NaN, infinite or negative %s and names it", (field) => {
      for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
        const reason = expectRefusal(lnPayoutCltvLimit(profile("mutinynet"), { ...valid, [field]: bad }));
        expect(reason).toContain(field);
      }
    });
  });
});
