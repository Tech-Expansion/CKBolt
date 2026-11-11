import {
  FIBER_MAX_TLC_EXPIRY_LIMIT_MS,
  FIBER_MIN_FINAL_EXPIRY_DELTA_MS,
  LDK_SHADOW_ROUTE_RESERVE_BLOCKS,
  LND_MIN_INVOICE_CLTV_EXPIRY,
  LSP_TIME_LOCK_DELTA_BLOCKS,
  PAYER_MAX_CLTV_LDK,
  PAYER_MAX_CLTV_LND,
} from "../../../src/common/constants/protocol.constants";
import { planLnToFiber } from "../../../src/domain/timing/timing.policy";
import {
  days,
  expectPlan,
  expectRefusal,
  fastBlockMs,
  fiberPayoutLock,
  hours,
  LND_SENDER_BLOCK_PADDING,
  minutes,
  profile,
  PROFILE_NAMES,
  profileWith,
  seconds,
} from "./timing.fixtures";

/**
 * ln_to_fiber at swap creation (lnd.md 6.4, Direction A, step 2):
 *   C >= ceil(F_max / t_fast) + holdexpirydelta(18) + m_ln + 3, F_max = final delta + hops x 4 h + Fiber margin,
 * refused when the payout delta is below Fiber's 160-minute minimum or C plus the payer's route budget (LDK's 80-block
 * shadow-route reserve; on testnet and mainnet also two 144-block LSP hops) is above payerMaxCltv.
 */
describe("timing: planLnToFiber", () => {
  describe("worked examples", () => {
    it("mutinynet: a 160-minute payout delta plus one 4 h hop fits an LDK payer with a channel to the hub (C = 861)", () => {
      // F_max = 160 + 240 + 10 = 410 min; 410 min / 30 s = 820 blocks; 820 + 18 + 20 + 3 = 861; 861 + 80 = 941 <= 1008.
      const plan = expectPlan(planLnToFiber(profile("mutinynet"), { payoutFinalExpiryDeltaMs: minutes(160) }));

      expect(plan).toEqual({ ok: true, holdCltvExpiry: 861, payoutTlcExpiryLimitMs: minutes(410) });
      expect(plan.holdCltvExpiry + LDK_SHADOW_ROUTE_RESERVE_BLOCKS).toBeLessThanOrEqual(PAYER_MAX_CLTV_LDK);
    });

    it("mutinynet: an LDK payer one LSP hop away cannot fit, so only LDK's reserve is budgeted", () => {
      // What Alby Hub met with a channel from Megalith: 861 + 80 + 144 = 1085 > 1008 (RouteNotFound).
      expect(profile("mutinynet").payerRouteBudgetBlocks).toBe(LDK_SHADOW_ROUTE_RESERVE_BLOCKS);
      expect(861 + LDK_SHADOW_ROUTE_RESERVE_BLOCKS + LSP_TIME_LOCK_DELTA_BLOCKS).toBeGreaterThan(PAYER_MAX_CLTV_LDK);
    });

    it("mutinynet: two 4 h hops need 1341 blocks and are refused with a reason naming the numbers", () => {
      // F_max = 160 + 480 + 10 = 650 min = 1300 blocks; 1300 + 41 = 1341; with LDK's 80-block reserve 1421 > 1008.
      const twoHops = profileWith("mutinynet", { maxFiberHops: 2 });
      const reason = expectRefusal(planLnToFiber(twoHops, { payoutFinalExpiryDeltaMs: minutes(160) }));

      expect(reason).toContain("1341");
      expect(reason).toContain("1421");
      expect(reason).toContain(String(PAYER_MAX_CLTV_LDK));
    });

    it("regtest defaults: C = 847, under every payer cap, so the devnet's LND payer can pay it", () => {
      // 820 blocks at the 30 s fast interval + 18 + 6 + 3 = 847.
      const plan = expectPlan(planLnToFiber(profile("regtest"), { payoutFinalExpiryDeltaMs: FIBER_MIN_FINAL_EXPIRY_DELTA_MS }));

      expect(plan).toEqual({ ok: true, holdCltvExpiry: 847, payoutTlcExpiryLimitMs: minutes(410) });
      expect(plan.holdCltvExpiry).toBeLessThanOrEqual(PAYER_MAX_CLTV_LDK);
      expect(plan.holdCltvExpiry).toBeLessThanOrEqual(PAYER_MAX_CLTV_LND);
    });

    it("regtest with LND's holdexpirydelta set to 40: C = 869, 22 blocks more than with LND's default 18", () => {
      // 820 blocks at the 30 s fast interval + 40 + 6 + 3 = 869; the payout limit itself does not change.
      const p = profileWith("regtest", { lndHoldExpiryDeltaBlocks: 40 });
      const plan = expectPlan(planLnToFiber(p, { payoutFinalExpiryDeltaMs: FIBER_MIN_FINAL_EXPIRY_DELTA_MS }));

      expect(plan).toEqual({ ok: true, holdCltvExpiry: 869, payoutTlcExpiryLimitMs: minutes(410) });
    });

    it("mutinynet with LND's holdexpirydelta set to 85: C = 928 still fits LDK's reserve under 1008 blocks, 86 would not", () => {
      // 820 + 85 + 20 + 3 = 928, + 80 = 1008; with 86: 929 + 80 = 1009 > 1008.
      expect(expectPlan(planLnToFiber(profileWith("mutinynet", { lndHoldExpiryDeltaBlocks: 85 }), { payoutFinalExpiryDeltaMs: minutes(160) })).holdCltvExpiry).toBe(928);
      expect(expectRefusal(planLnToFiber(profileWith("mutinynet", { lndHoldExpiryDeltaBlocks: 86 }), { payoutFinalExpiryDeltaMs: minutes(160) }))).toContain("1009");
    });

    it.each(["mainnet", "testnet"] as const)("%s: 160 min + two hops + 15 min margin gives C = 115", (name) => {
      // F_max = 160 + 480 + 15 = 655 min = 39,300 s; / 450 s = 87.33 -> 88 blocks (rounded up); 88 + 18 + 6 + 3 = 115.
      const plan = expectPlan(planLnToFiber(profile(name), { payoutFinalExpiryDeltaMs: minutes(160) }));

      expect(plan).toEqual({ ok: true, holdCltvExpiry: 115, payoutTlcExpiryLimitMs: minutes(655) });
    });

    it("mainnet: a payout invoice with Fiber's 24 h default delta still fits (C = 285)", () => {
      // F_max = 1440 + 480 + 15 = 1935 min = 116,100 s = exactly 258 fast blocks; 258 + 27 = 285.
      const plan = expectPlan(planLnToFiber(profile("mainnet"), { payoutFinalExpiryDeltaMs: hours(24) }));

      expect(plan).toEqual({ ok: true, holdCltvExpiry: 285, payoutTlcExpiryLimitMs: minutes(1935) });
    });

    it("a direct channel (maxFiberHops 0) budgets no hop delta", () => {
      // F_max = 160 + 10 = 170 min = 340 blocks; 340 + 41 = 381.
      const direct = profileWith("mutinynet", { maxFiberHops: 0 });

      expect(planLnToFiber(direct, { payoutFinalExpiryDeltaMs: minutes(160) })).toEqual({
        ok: true,
        holdCltvExpiry: 381,
        payoutTlcExpiryLimitMs: minutes(170),
      });
    });
  });

  describe("Fiber's minimum final expiry delta", () => {
    it("accepts a payout delta of exactly 160 minutes", () => {
      expectPlan(planLnToFiber(profile("mutinynet"), { payoutFinalExpiryDeltaMs: FIBER_MIN_FINAL_EXPIRY_DELTA_MS }));
    });

    it("refuses a payout delta 1 ms below 160 minutes, naming Fiber's minimum", () => {
      const reason = expectRefusal(
        planLnToFiber(profile("mutinynet"), { payoutFinalExpiryDeltaMs: FIBER_MIN_FINAL_EXPIRY_DELTA_MS - 1 }),
      );

      expect(reason).toContain("160 minutes");
    });

    it.each([0, minutes(1), minutes(159)])("refuses a payout delta of %d ms on every profile", (delta) => {
      for (const name of PROFILE_NAMES) expectRefusal(planLnToFiber(profile(name), { payoutFinalExpiryDeltaMs: delta }));
    });
  });

  describe("payer CLTV cap", () => {
    // mutinynet: C = ceil(F / 30 s) + 41, and C + 80 <= 1008 -> F <= 887 blocks x 30 s = 26,610 s; F = delta + 250 min.
    const largestDeltaMs = 887 * fastBlockMs(profile("mutinynet")) - minutes(250);

    it("accepts the largest payout delta whose C plus the payer's route budget equals payerMaxCltv exactly", () => {
      const plan = expectPlan(planLnToFiber(profile("mutinynet"), { payoutFinalExpiryDeltaMs: largestDeltaMs }));

      expect(plan.holdCltvExpiry).toBe(928);
      expect(plan.holdCltvExpiry + profile("mutinynet").payerRouteBudgetBlocks).toBe(PAYER_MAX_CLTV_LDK);
    });

    it("refuses 1 ms more, which needs one more block than payers accept", () => {
      const reason = expectRefusal(planLnToFiber(profile("mutinynet"), { payoutFinalExpiryDeltaMs: largestDeltaMs + 1 }));

      expect(reason).toContain("1009");
    });

    it("follows the profile's payerMaxCltv (a config tunable), not a fixed number", () => {
      const lndPayers = profileWith("mutinynet", { maxFiberHops: 2, payerMaxCltv: PAYER_MAX_CLTV_LND });
      const strictPayers = profileWith("mutinynet", { payerMaxCltv: 940 });

      expect(expectPlan(planLnToFiber(lndPayers, { payoutFinalExpiryDeltaMs: minutes(160) })).holdCltvExpiry).toBe(1341);
      expect(expectRefusal(planLnToFiber(strictPayers, { payoutFinalExpiryDeltaMs: minutes(160) }))).toContain("941");
    });

    it("follows the profile's payerRouteBudgetBlocks (PAYER_ROUTE_BUDGET_BLOCKS), not a fixed number", () => {
      // C = 861 on mutinynet: a 147-block budget makes exactly 1008, 148 makes 1009.
      expectPlan(planLnToFiber(profileWith("mutinynet", { payerRouteBudgetBlocks: 147 }), { payoutFinalExpiryDeltaMs: minutes(160) }));
      const reason = expectRefusal(planLnToFiber(profileWith("mutinynet", { payerRouteBudgetBlocks: 148 }), { payoutFinalExpiryDeltaMs: minutes(160) }));
      expect(reason).toContain("148 blocks for the payer's route");
      expect(reason).toContain("1009");
    });
  });

  describe("Fiber's maximum tlc_expiry_limit", () => {
    // One block a day keeps C tiny, so only the 14-day Fiber limit can refuse.
    // The hub's payout lock cap is lifted here, so Fiber's own 14-day limit is what refuses.
    const slowChain = profileWith("mutinynet", { btcFastBlockSeconds: 86_400, payerMaxCltv: PAYER_MAX_CLTV_LND, maxPayoutLockMs: days(15) });
    const deltaAtLimit = FIBER_MAX_TLC_EXPIRY_LIMIT_MS - minutes(250);

    it("accepts a payout lock of exactly 14 days", () => {
      const plan = expectPlan(planLnToFiber(slowChain, { payoutFinalExpiryDeltaMs: deltaAtLimit }));

      expect(plan.payoutTlcExpiryLimitMs).toBe(FIBER_MAX_TLC_EXPIRY_LIMIT_MS);
    });

    it("refuses a payout lock 1 ms above 14 days", () => {
      expectRefusal(planLnToFiber(slowChain, { payoutFinalExpiryDeltaMs: deltaAtLimit + 1 }));
    });

    it("refuses a 14-day payout delta on every shipped profile", () => {
      for (const name of PROFILE_NAMES) expectRefusal(planLnToFiber(profile(name), { payoutFinalExpiryDeltaMs: days(14) }));
    });
  });

  describe("the hub's payout lock cap (maxPayoutLockMs)", () => {
    // Payer limits out of the way, so only the cap can refuse: the lock is delta + 1 hop x 4 h + 10 min.
    const roomyPayers = (maxPayoutLockMs: number) =>
      profileWith("mutinynet", { btcFastBlockSeconds: 86_400, payerMaxCltv: PAYER_MAX_CLTV_LND, maxPayoutLockMs });

    it("accepts a payout lock exactly at the cap", () => {
      const plan = expectPlan(planLnToFiber(roomyPayers(hours(10)), { payoutFinalExpiryDeltaMs: hours(10) - minutes(250) }));
      expect(plan.payoutTlcExpiryLimitMs).toBe(hours(10));
    });

    it("refuses a payout lock 1 ms above the cap, naming both durations", () => {
      const reason = expectRefusal(planLnToFiber(roomyPayers(hours(10)), { payoutFinalExpiryDeltaMs: hours(10) - minutes(250) + 1 }));
      expect(reason).toContain("600 minutes");
      expect(reason).toMatch(/limit/);
    });

    it("refuses on the testnet profile a 5-day lock its 1008-block payer cap would still allow", () => {
      // (1008 - 27) blocks x 450 s = 122.6 h of Fiber lock fits the payer cap; the 96 h payout cap does not.
      // No payer route budget, so the payer cap alone would allow it.
      const testnet = profileWith("testnet", { payerRouteBudgetBlocks: 0 });
      const lockMs = days(5);
      const delta = lockMs - testnet.maxFiberHops * hours(4) - testnet.fiberMarginMs;
      expect(Math.ceil(lockMs / seconds(testnet.btcFastBlockSeconds)) + 27).toBeLessThanOrEqual(testnet.payerMaxCltv);
      expectRefusal(planLnToFiber(testnet, { payoutFinalExpiryDeltaMs: delta }));
    });
  });

  describe("rounding and integer results", () => {
    it("rounds blocks up, so the hold never runs out before the Fiber lock (7 s fast blocks)", () => {
      // 410 min = 24,600 s / 7 s = 3514.29 -> 3515 blocks; 3515 + 18 + 20 + 3 = 3556.
      const odd = profileWith("mutinynet", { btcFastBlockSeconds: 7, payerMaxCltv: 10_000 });

      expect(expectPlan(planLnToFiber(odd, { payoutFinalExpiryDeltaMs: minutes(160) })).holdCltvExpiry).toBe(3556);
    });

    it("rounds the payout limit down to whole ms and sizes C from that limit", () => {
      // F = 400 min + 10.7 ms -> 24,000,010 ms; ceil(24,000,010 / 30,000) = 801; 801 + 41 = 842.
      const fractional = profileWith("mutinynet", { fiberMarginMs: 10.7 });

      expect(planLnToFiber(fractional, { payoutFinalExpiryDeltaMs: minutes(160) })).toEqual({
        ok: true,
        holdCltvExpiry: 842,
        payoutTlcExpiryLimitMs: 24_000_010,
      });
    });

    it("never asks for less than LND's minimum invoice cltv_expiry", () => {
      // One block a day: ceil(160 min / 1 day) = 1; 1 + 18 + 0 + 3 = 22 -> raised to 24.
      const tiny = profileWith("mutinynet", { btcFastBlockSeconds: 86_400, lnMarginBlocks: 0, fiberMarginMs: 0, maxFiberHops: 0 });

      expect(expectPlan(planLnToFiber(tiny, { payoutFinalExpiryDeltaMs: minutes(160) })).holdCltvExpiry).toBe(
        LND_MIN_INVOICE_CLTV_EXPIRY,
      );
    });

    it("returns whole numbers for odd inputs", () => {
      const odd = profileWith("testnet", { btcFastBlockSeconds: 0.7, fiberMarginMs: 1234.567, payerMaxCltv: 10_000_000 });
      const plan = expectPlan(planLnToFiber(odd, { payoutFinalExpiryDeltaMs: minutes(160) + 0.3 }));

      expect(Number.isInteger(plan.holdCltvExpiry)).toBe(true);
      expect(Number.isInteger(plan.payoutTlcExpiryLimitMs)).toBe(true);
    });
  });

  describe("safety: the worst-case Fiber lock ends before LND's auto-cancel point", () => {
    const deltas = [minutes(160), minutes(200), hours(4), hours(6), hours(12), hours(24), hours(48)];

    it.each(PROFILE_NAMES)("%s: every accepted plan covers F_max at the fast interval plus 18 + margin + 3 blocks", (name) => {
      const p = profile(name);
      let accepted = 0;
      for (const delta of deltas) {
        const result = planLnToFiber(p, { payoutFinalExpiryDeltaMs: delta });
        if (!result.ok) continue;
        accepted += 1;

        const spareBlocks = result.holdCltvExpiry - p.lndHoldExpiryDeltaBlocks - p.lnMarginBlocks - LND_SENDER_BLOCK_PADDING;
        expect(spareBlocks * fastBlockMs(p)).toBeGreaterThanOrEqual(result.payoutTlcExpiryLimitMs);
        expect(result.payoutTlcExpiryLimitMs).toBeLessThanOrEqual(fiberPayoutLock(p, delta));
        expect(result.payoutTlcExpiryLimitMs).toBeGreaterThan(fiberPayoutLock(p, delta) - 1);
        expect(result.payoutTlcExpiryLimitMs).toBeLessThanOrEqual(FIBER_MAX_TLC_EXPIRY_LIMIT_MS);
        expect(result.holdCltvExpiry + p.payerRouteBudgetBlocks).toBeLessThanOrEqual(p.payerMaxCltv);
      }
      expect(accepted).toBeGreaterThan(0);
    });

    it("C grows with the payout delta and the hop budget, never shrinks", () => {
      const p = profileWith("mutinynet", { payerMaxCltv: PAYER_MAX_CLTV_LND });
      const cltvFor = (delta: number, hops: number) =>
        expectPlan(planLnToFiber({ ...p, maxFiberHops: hops }, { payoutFinalExpiryDeltaMs: delta })).holdCltvExpiry;

      expect(cltvFor(minutes(161), 1)).toBeGreaterThanOrEqual(cltvFor(minutes(160), 1));
      expect(cltvFor(minutes(160), 2)).toBeGreaterThan(cltvFor(minutes(160), 1));
    });
  });

  describe("invalid input", () => {
    it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])("refuses payoutFinalExpiryDeltaMs = %p and names the field", (bad) => {
      const reason = expectRefusal(planLnToFiber(profile("mutinynet"), { payoutFinalExpiryDeltaMs: bad }));

      expect(reason).toContain("payoutFinalExpiryDeltaMs");
    });
  });
});
