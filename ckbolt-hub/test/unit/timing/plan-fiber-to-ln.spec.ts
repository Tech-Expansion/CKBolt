import {
  FIBER_HELD_TLC_EARLY_FAIL_MS,
  FIBER_MAX_TLC_EXPIRY_LIMIT_MS,
  FIBER_MIN_FINAL_EXPIRY_DELTA_MS,
  PAYER_MAX_CLTV_LND,
} from "../../../src/common/constants/protocol.constants";
import { lnPayoutCltvLimit, planFiberToLn } from "../../../src/domain/timing/timing.policy";
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
 * fiber_to_ln at swap creation (fiber-node.md 7.1: "set final_expiry_delta to the hold time you need plus 160 min plus a
 * margin"; lnd.md 6.4 Direction B): the configured hold delta, raised when the Lightning payout (the smallest cltv_limit
 * LND takes, payee CLTV + LND's 3 padding blocks + 1, plus lnRouteBudgetBlocks of route, at the slow interval) would not
 * fit after fnn's early-fail margin.
 * Route budgets of the shipped profiles: regtest 80 blocks (one LND hop), the others 160 (two hops).
 */
describe("timing: planFiberToLn", () => {
  const SIX_HOURS = hours(6);

  describe("worked examples", () => {
    it("mutinynet: the configured 6 h hold is kept for a CLTV-80 invoice", () => {
      // (80 + 3 + 1 + 160) x 45 s = 183 min; + 161 min + 10 min = 354 min < 360 min.
      expect(planFiberToLn(profile("mutinynet"), { payoutCltvExpiry: 80, configuredHoldFinalExpiryDeltaMs: SIX_HOURS })).toEqual({
        ok: true,
        holdFinalExpiryDeltaMs: SIX_HOURS,
      });
    });

    it("mutinynet: CLTV 88 is the largest invoice the 6 h hold fits exactly", () => {
      // (88 + 3 + 1 + 160) = 252 blocks x 45 s = 189 min; + 171 min = 360 min.
      expect(planFiberToLn(profile("mutinynet"), { payoutCltvExpiry: 88, configuredHoldFinalExpiryDeltaMs: SIX_HOURS })).toEqual({
        ok: true,
        holdFinalExpiryDeltaMs: SIX_HOURS,
      });
    });

    it("mutinynet: CLTV 89 raises the hold by one slow block", () => {
      expect(planFiberToLn(profile("mutinynet"), { payoutCltvExpiry: 89, configuredHoldFinalExpiryDeltaMs: SIX_HOURS })).toEqual({
        ok: true,
        holdFinalExpiryDeltaMs: SIX_HOURS + 45_000,
      });
    });

    it("regtest: the 900 s slow interval raises the hold to 2631 min for a CLTV-80 invoice", () => {
      // (80 + 3 + 1 + 80) x 15 min = 2460 min; + 161 + 10 = 2631 min (about 43.9 h).
      expect(planFiberToLn(profile("regtest"), { payoutCltvExpiry: 80, configuredHoldFinalExpiryDeltaMs: SIX_HOURS })).toEqual({
        ok: true,
        holdFinalExpiryDeltaMs: minutes(2631),
      });
    });

    it("regtest: a CLTV-40 invoice (the fake node's default) needs 2031 min", () => {
      // (40 + 84) x 15 min = 1860 min; + 171 = 2031 min.
      expect(planFiberToLn(profile("regtest"), { payoutCltvExpiry: 40, configuredHoldFinalExpiryDeltaMs: SIX_HOURS })).toEqual({
        ok: true,
        holdFinalExpiryDeltaMs: minutes(2031),
      });
    });

    it("mainnet: a CLTV-80 invoice needs 3836 min with the 15 min Fiber margin", () => {
      // (80 + 3 + 1 + 160) = 244 x 15 min = 3660 min; + 161 + 15 = 3836 min.
      expect(planFiberToLn(profile("mainnet"), { payoutCltvExpiry: 80, configuredHoldFinalExpiryDeltaMs: SIX_HOURS })).toEqual({
        ok: true,
        holdFinalExpiryDeltaMs: minutes(3836),
      });
    });
  });

  describe("route budget", () => {
    it("sizes the route with lnRouteBudgetBlocks, not lnMarginBlocks", () => {
      const plan = (patch: Parameters<typeof profileWith>[1]) =>
        expectPlan(planFiberToLn(profileWith("regtest", patch), { payoutCltvExpiry: 40, configuredHoldFinalExpiryDeltaMs: SIX_HOURS }));

      expect(plan({ lnMarginBlocks: 500 })).toEqual(expectPlan(planFiberToLn(profile("regtest"), { payoutCltvExpiry: 40, configuredHoldFinalExpiryDeltaMs: SIX_HOURS })));
      // Ten more blocks of route budget, ten more slow blocks of hold: (40 + 3 + 1 + 90) x 15 + 171 = 2181 min.
      expect(plan({ lnRouteBudgetBlocks: 90 }).holdFinalExpiryDeltaMs).toBe(minutes(2181));
    });

    it("a zero budget plans for the smallest cltv_limit LND takes for the invoice only", () => {
      // (40 + 3 + 1) x 15 + 171 = 831 min.
      expect(
        planFiberToLn(profileWith("regtest", { lnRouteBudgetBlocks: 0 }), { payoutCltvExpiry: 40, configuredHoldFinalExpiryDeltaMs: SIX_HOURS }),
      ).toEqual({ ok: true, holdFinalExpiryDeltaMs: minutes(831) });
    });
  });

  describe("lower bounds", () => {
    it("never goes below fnn's early-fail margin plus the Fiber margin, nor Fiber's 160-minute minimum", () => {
      const result = expectPlan(
        planFiberToLn(profile("mutinynet"), { payoutCltvExpiry: 0, configuredHoldFinalExpiryDeltaMs: minutes(1) }),
      );

      expect(result.holdFinalExpiryDeltaMs).toBeGreaterThanOrEqual(FIBER_MIN_FINAL_EXPIRY_DELTA_MS);
      expect(result.holdFinalExpiryDeltaMs).toBeGreaterThan(FIBER_HELD_TLC_EARLY_FAIL_MS + minutes(10));
    });

    it("a larger configured hold always wins", () => {
      expect(planFiberToLn(profile("regtest"), { payoutCltvExpiry: 80, configuredHoldFinalExpiryDeltaMs: hours(48) })).toEqual({
        ok: true,
        holdFinalExpiryDeltaMs: hours(48),
      });
    });
  });

  describe("upper bounds", () => {
    /** A shipped profile with the hub's payout lock cap lifted, so LND's and Fiber's own limits are what refuse. */
    const uncapped = (name: "mutinynet" | "mainnet") => profileWith(name, { maxPayoutLockMs: days(30) });

    it("accepts CLTV 2012, whose smallest limit (2012 + 3 padding + 1) is exactly LND's 2016 maximum", () => {
      expectPlan(planFiberToLn(uncapped("mutinynet"), { payoutCltvExpiry: 2012, configuredHoldFinalExpiryDeltaMs: SIX_HOURS }));
    });

    it("refuses CLTV 2013: LND will not pay with a cltv_limit above 2016", () => {
      const reason = expectRefusal(
        planFiberToLn(profile("mutinynet"), { payoutCltvExpiry: 2013, configuredHoldFinalExpiryDeltaMs: SIX_HOURS }),
      );

      expect(reason).toContain("2017");
      expect(reason).toContain(String(PAYER_MAX_CLTV_LND));
    });

    it("mainnet: CLTV 1168 is the most a 14-day Fiber hold can cover; 1169 is refused", () => {
      // (1168 + 3 + 1 + 160) x 900 s + 161 + 15 min = 1,209,360,000 ms <= 14 days; 1333 blocks overshoot by 660,000 ms.
      const plan = (payoutCltvExpiry: number) =>
        planFiberToLn(uncapped("mainnet"), { payoutCltvExpiry, configuredHoldFinalExpiryDeltaMs: SIX_HOURS });

      expect(plan(1168)).toEqual({ ok: true, holdFinalExpiryDeltaMs: 1_209_360_000 });
      expectRefusal(plan(1169));
    });

    it("refuses a configured hold above Fiber's 14-day maximum", () => {
      expectRefusal(planFiberToLn(profile("mutinynet"), { payoutCltvExpiry: 80, configuredHoldFinalExpiryDeltaMs: days(15) }));
    });

    it("accepts a configured hold of exactly 14 days", () => {
      expect(
        planFiberToLn(profile("mutinynet"), { payoutCltvExpiry: 80, configuredHoldFinalExpiryDeltaMs: FIBER_MAX_TLC_EXPIRY_LIMIT_MS }),
      ).toEqual({ ok: true, holdFinalExpiryDeltaMs: FIBER_MAX_TLC_EXPIRY_LIMIT_MS });
    });
  });

  describe("the hub's payout lock cap (maxPayoutLockMs)", () => {
    const uncappedMainnet = profileWith("mainnet", { maxPayoutLockMs: days(30) });

    it("regtest (48 h / 900 s = 192 blocks): accepts CLTV 108, whose limit with padding and route budget is 192", () => {
      // (108 + 3 + 1 + 80) blocks fit; the hold is 192 x 15 min + 171 min.
      expect(planFiberToLn(profile("regtest"), { payoutCltvExpiry: 108, configuredHoldFinalExpiryDeltaMs: SIX_HOURS })).toEqual({
        ok: true,
        holdFinalExpiryDeltaMs: minutes(192 * 15 + 171),
      });
    });

    it("regtest: refuses CLTV 109, which would let the payee hold the hub's payout longer than 48 h", () => {
      const reason = expectRefusal(planFiberToLn(profile("regtest"), { payoutCltvExpiry: 109, configuredHoldFinalExpiryDeltaMs: SIX_HOURS }));
      expect(reason).toContain("193");
      expect(reason).toContain("192");
    });

    it("mainnet: refuses a CLTV of 1000 blocks, which LND and a 14-day hold could still carry", () => {
      expectPlan(planFiberToLn(uncappedMainnet, { payoutCltvExpiry: 1_000, configuredHoldFinalExpiryDeltaMs: SIX_HOURS }));
      expectRefusal(planFiberToLn(profile("mainnet"), { payoutCltvExpiry: 1_000, configuredHoldFinalExpiryDeltaMs: SIX_HOURS }));
    });

    it("every shipped profile accepts an LND invoice's default CLTV of 80 blocks", () => {
      for (const name of PROFILE_NAMES) expectPlan(planFiberToLn(profile(name), { payoutCltvExpiry: 80, configuredHoldFinalExpiryDeltaMs: SIX_HOURS }));
    });
  });

  describe("rounding", () => {
    it("rounds a fractional hold up to whole ms, so the hold is never shorter than needed", () => {
      // (80 + 3 + 1 + 160) x 45 s = 10,980,000; + 9,660,000 + 0.4 = 20,640,000.4 -> 20,640,001.
      const fractional = profileWith("mutinynet", { fiberMarginMs: 0.4 });

      expect(planFiberToLn(fractional, { payoutCltvExpiry: 80, configuredHoldFinalExpiryDeltaMs: minutes(1) })).toEqual({
        ok: true,
        holdFinalExpiryDeltaMs: 20_640_001,
      });
    });

    it("rounds a fractional configured hold up too", () => {
      expect(
        planFiberToLn(profile("mutinynet"), { payoutCltvExpiry: 80, configuredHoldFinalExpiryDeltaMs: SIX_HOURS + 0.2 }),
      ).toEqual({ ok: true, holdFinalExpiryDeltaMs: SIX_HOURS + 1 });
    });
  });

  describe("safety: a fresh hold always leaves room for the planned Lightning payout", () => {
    const cltvs = [9, 18, 24, 40, 80, 144, 200, 500, 1000, 1323, 2013];
    const NOW = Date.UTC(2026, 9, 23, 12);

    it.each(PROFILE_NAMES)("%s: lnPayoutCltvLimit at hold time covers the smallest payable limit + route budget", (name) => {
      const p = profile(name);
      let accepted = 0;
      for (const payoutCltvExpiry of cltvs) {
        const plan = planFiberToLn(p, { payoutCltvExpiry, configuredHoldFinalExpiryDeltaMs: SIX_HOURS });
        if (!plan.ok) continue;
        accepted += 1;

        expect(Number.isInteger(plan.holdFinalExpiryDeltaMs)).toBe(true);
        expect(plan.holdFinalExpiryDeltaMs).toBeLessThanOrEqual(FIBER_MAX_TLC_EXPIRY_LIMIT_MS);
        const windowMs = plan.holdFinalExpiryDeltaMs - fiberHoldReserve(p);
        const routeBlocks = Math.min(payableCltvLimit(payoutCltvExpiry) + p.lnRouteBudgetBlocks, PAYER_MAX_CLTV_LND);
        expect(windowMs).toBeGreaterThanOrEqual(routeBlocks * slowBlockMs(p));

        const limit = expectPlan(
          lnPayoutCltvLimit(p, { heldTlcFailsAt: failsAtOnDefaultChannel(NOW + plan.holdFinalExpiryDeltaMs), now: NOW, payoutCltvExpiry }),
        );
        expect(limit.cltvLimit).toBeGreaterThanOrEqual(routeBlocks);
      }
      expect(accepted).toBeGreaterThan(0);
    });

    it("the hold grows with the payout CLTV", () => {
      const p = profile("regtest");
      const hold = (payoutCltvExpiry: number) =>
        expectPlan(planFiberToLn(p, { payoutCltvExpiry, configuredHoldFinalExpiryDeltaMs: SIX_HOURS })).holdFinalExpiryDeltaMs;

      expect(hold(81)).toBeGreaterThan(hold(80));
      expect(hold(81) - hold(80)).toBe(slowBlockMs(p));
    });
  });

  describe("invalid input", () => {
    const valid = { payoutCltvExpiry: 80, configuredHoldFinalExpiryDeltaMs: SIX_HOURS };

    it.each(Object.keys(valid))("refuses a NaN, infinite or negative %s and names it", (field) => {
      for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
        const reason = expectRefusal(planFiberToLn(profile("mutinynet"), { ...valid, [field]: bad }));
        expect(reason).toContain(field);
      }
    });
  });
});
