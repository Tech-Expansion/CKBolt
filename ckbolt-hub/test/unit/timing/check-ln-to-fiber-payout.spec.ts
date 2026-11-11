import { FIBER_MIN_FINAL_EXPIRY_DELTA_MS } from "../../../src/common/constants/protocol.constants";
import { checkLnToFiberPayout, planLnToFiber } from "../../../src/domain/timing/timing.policy";
import type { TimingProfile } from "../../../src/domain/timing/timing.types";
import {
  autoCancelHeight,
  expectPlan,
  expectRefusal,
  fastBlockMs,
  minutes,
  profile,
  PROFILE_NAMES,
  profileWith,
} from "./timing.fixtures";

/**
 * ln_to_fiber when the incoming HTLC is ACCEPTED (lnd.md 6.4, Direction A, step 1): re-check the real HTLC expiry,
 * not the invoice value. The blocks left before the auto-cancel point, at the fast interval and minus lnMarginBlocks,
 * must cover the payout limit; the limit may shrink as blocks pass.
 */
describe("timing: checkLnToFiberPayout", () => {
  const ACCEPT_HEIGHT = 1_000;

  describe("the hub's payout lock cap (maxPayoutLockMs)", () => {
    it("never returns a limit above the cap, even when the plan and the blocks left allow more", () => {
      // A swap planned at 410 min under a looser cap, checked after the cap was lowered to 405 min.
      const p = profileWith("mutinynet", { maxPayoutLockMs: minutes(405) });
      const result = checkLnToFiberPayout(p, { earliestHtlcExpiryHeight: ACCEPT_HEIGHT + 861, currentHeight: ACCEPT_HEIGHT, plannedTlcExpiryLimitMs: minutes(410) });
      expect(result).toEqual({ ok: true, payoutTlcExpiryLimitMs: minutes(405) });
    });

    it("refuses (the swap is refunded) when the cap is below what the payout invoice needs", () => {
      const p = profileWith("mutinynet", { maxPayoutLockMs: minutes(399) });
      expectRefusal(
        checkLnToFiberPayout(p, { earliestHtlcExpiryHeight: ACCEPT_HEIGHT + 861, currentHeight: ACCEPT_HEIGHT, plannedTlcExpiryLimitMs: minutes(410) }),
      );
    });
  });

  describe("LND's configured holdexpirydelta (LND_HOLD_EXPIRY_DELTA_BLOCKS)", () => {
    const planned = minutes(410);

    it("a hold invoice planned under a 40-block delta gets the planned limit back when accepted", () => {
      // mutinynet, C = 820 + 40 + 20 + 3 = 883: 1883 - 40 - 1000 - 20 = 823 blocks x 30 s = 411.5 min, capped at 410.
      const p = profileWith("mutinynet", { lndHoldExpiryDeltaBlocks: 40 });
      const result = checkLnToFiberPayout(p, { earliestHtlcExpiryHeight: ACCEPT_HEIGHT + 883, currentHeight: ACCEPT_HEIGHT, plannedTlcExpiryLimitMs: planned });
      expect(result).toEqual({ ok: true, payoutTlcExpiryLimitMs: planned });
    });

    it("counts the blocks left before the configured delta, not LND's default 18", () => {
      // An HTLC expiring at 1861 (C = 861, sized for the default). LND set to 40 cancels it at 1821, so at height 1000
      // the payout gets (1821 - 1000 - 20) x 30 s = 400.5 min, not the 410 min the default would leave.
      const p = profileWith("mutinynet", { lndHoldExpiryDeltaBlocks: 40 });
      const check = (currentHeight: number) =>
        checkLnToFiberPayout(p, { earliestHtlcExpiryHeight: ACCEPT_HEIGHT + 861, currentHeight, plannedTlcExpiryLimitMs: planned });

      expect(check(ACCEPT_HEIGHT)).toEqual({ ok: true, payoutTlcExpiryLimitMs: minutes(400.5) });
      expect(check(ACCEPT_HEIGHT + 1)).toEqual({ ok: true, payoutTlcExpiryLimitMs: minutes(400) });
      // 399.5 min no longer covers the payee's 160 min delta plus the 4 h hop: refused (refund) instead of paying out a
      // lock LND would outlive.
      expectRefusal(check(ACCEPT_HEIGHT + 2));
    });
  });

  const plannedFor = (p: TimingProfile) =>
    expectPlan(planLnToFiber(p, { payoutFinalExpiryDeltaMs: FIBER_MIN_FINAL_EXPIRY_DELTA_MS }));

  describe("mutinynet worked example (C = 861, planned limit 410 min, 20 margin blocks, 10 min Fiber margin)", () => {
    const p = profile("mutinynet");
    const planned = minutes(410);
    const earliest = ACCEPT_HEIGHT + 861;
    const check = (currentHeight: number, earliestHtlcExpiryHeight = earliest) =>
      checkLnToFiberPayout(p, { earliestHtlcExpiryHeight, currentHeight, plannedTlcExpiryLimitMs: planned });

    it("a freshly accepted HTLC gets the planned limit back", () => {
      expect(check(ACCEPT_HEIGHT)).toEqual({ ok: true, payoutTlcExpiryLimitMs: planned });
    });

    it("the plan's 3 padding blocks absorb the first 3 blocks mined before payout", () => {
      // 1861 - 18 - 1003 - 20 = 820 blocks x 30 s = 410 min.
      expect(check(ACCEPT_HEIGHT + 3)).toEqual({ ok: true, payoutTlcExpiryLimitMs: planned });
    });

    it("after that the limit shrinks by one fast block per block mined", () => {
      // 819 blocks x 30 s = 24,570,000 ms.
      expect(check(ACCEPT_HEIGHT + 4)).toEqual({ ok: true, payoutTlcExpiryLimitMs: 24_570_000 });
    });

    it("still pays out when only the Fiber margin has been used up (800 blocks = 400 min)", () => {
      expect(check(ACCEPT_HEIGHT + 23)).toEqual({ ok: true, payoutTlcExpiryLimitMs: minutes(400) });
    });

    it("refuses one block later: the payee's delta plus the hop budget no longer fit", () => {
      const reason = expectRefusal(check(ACCEPT_HEIGHT + 24));

      expect(reason).toContain("399.5 minutes");
      expect(reason).toContain("400 minutes");
    });

    it("refuses at and after LND's auto-cancel height, never reporting negative time", () => {
      expectRefusal(check(autoCancelHeight(p, earliest)));
      expect(expectRefusal(check(earliest + 100))).toContain("0 minutes");
    });

    it("does not trust the invoice: an HTLC that expires sooner than the planned CLTV is refused", () => {
      expectRefusal(check(ACCEPT_HEIGHT, ACCEPT_HEIGHT + 500));
    });

    it("never hands out more than the planned limit, however late the HTLC expires", () => {
      expect(check(ACCEPT_HEIGHT, ACCEPT_HEIGHT + 2_000)).toEqual({ ok: true, payoutTlcExpiryLimitMs: planned });
    });

    it("an HTLC carrying LND's 3 extra sender blocks gives 3 more blocks of room", () => {
      expect(check(ACCEPT_HEIGHT + 6, earliest + 3)).toEqual({ ok: true, payoutTlcExpiryLimitMs: planned });
      expect(check(ACCEPT_HEIGHT + 7, earliest + 3)).toEqual({ ok: true, payoutTlcExpiryLimitMs: 24_570_000 });
    });
  });

  describe("mainnet worked example (C = 115, planned 655 min, 450 s fast blocks)", () => {
    const p = profile("mainnet");
    const planned = minutes(655);
    const earliest = 800_000 + 115;
    const check = (currentHeight: number) =>
      checkLnToFiberPayout(p, { earliestHtlcExpiryHeight: earliest, currentHeight, plannedTlcExpiryLimitMs: planned });

    it.each([
      [800_000, minutes(655)],
      [800_003, minutes(655)],
      [800_004, 87 * 450_000],
      [800_005, 86 * 450_000],
    ])("at height %d the payout limit is %d ms", (height, limit) => {
      expect(check(height)).toEqual({ ok: true, payoutTlcExpiryLimitMs: limit });
    });

    it("refuses at height 800,006: 85 blocks (637.5 min) are below 655 - 15 = 640 min", () => {
      expectRefusal(check(800_006));
    });
  });

  describe("Fiber's 160-minute minimum is a hard floor", () => {
    // planned = 160 min = 320 blocks at 30 s; with 20 margin blocks the HTLC must expire 18 + 20 + 320 blocks ahead.
    const p = profile("mutinynet");
    const check = (earliestHtlcExpiryHeight: number) =>
      checkLnToFiberPayout(p, {
        earliestHtlcExpiryHeight,
        currentHeight: ACCEPT_HEIGHT,
        plannedTlcExpiryLimitMs: FIBER_MIN_FINAL_EXPIRY_DELTA_MS,
      });

    it("pays out when exactly 160 minutes fit", () => {
      expect(check(ACCEPT_HEIGHT + 358)).toEqual({ ok: true, payoutTlcExpiryLimitMs: FIBER_MIN_FINAL_EXPIRY_DELTA_MS });
    });

    it("refuses when one block less is left, even though the Fiber margin would allow shrinking", () => {
      expectRefusal(check(ACCEPT_HEIGHT + 357));
    });
  });

  describe("safety over every shipped profile, block by block", () => {
    it.each(PROFILE_NAMES)("%s: an accepted payout always ends lnMarginBlocks before auto-cancel, and refusals stick", (name) => {
      const p = profile(name);
      const plan = plannedFor(p);
      const earliest = ACCEPT_HEIGHT + plan.holdCltvExpiry;
      let previousLimit = Number.POSITIVE_INFINITY;
      let refused = false;

      for (let height = ACCEPT_HEIGHT; height <= earliest + 1; height += 1) {
        const result = checkLnToFiberPayout(p, {
          earliestHtlcExpiryHeight: earliest,
          currentHeight: height,
          plannedTlcExpiryLimitMs: plan.payoutTlcExpiryLimitMs,
        });
        if (!result.ok) {
          refused = true;
          continue;
        }
        const limit = result.payoutTlcExpiryLimitMs;
        const blocksDuringPayout = Math.ceil(limit / fastBlockMs(p));

        expect(refused).toBe(false);
        expect(Number.isInteger(limit)).toBe(true);
        expect(limit).toBeLessThanOrEqual(previousLimit);
        expect(limit).toBeLessThanOrEqual(plan.payoutTlcExpiryLimitMs);
        expect(limit).toBeGreaterThanOrEqual(plan.payoutTlcExpiryLimitMs - p.fiberMarginMs);
        expect(limit).toBeGreaterThanOrEqual(FIBER_MIN_FINAL_EXPIRY_DELTA_MS);
        expect(height + blocksDuringPayout + p.lnMarginBlocks).toBeLessThanOrEqual(autoCancelHeight(p, earliest));
        previousLimit = limit;
      }

      expect(refused).toBe(true);
    });

    it.each(PROFILE_NAMES)("%s: the fresh HTLC and the next 3 blocks get the planned limit", (name) => {
      const p = profile(name);
      const plan = plannedFor(p);
      for (let mined = 0; mined <= 3; mined += 1) {
        expect(
          checkLnToFiberPayout(p, {
            earliestHtlcExpiryHeight: ACCEPT_HEIGHT + plan.holdCltvExpiry,
            currentHeight: ACCEPT_HEIGHT + mined,
            plannedTlcExpiryLimitMs: plan.payoutTlcExpiryLimitMs,
          }),
        ).toEqual({ ok: true, payoutTlcExpiryLimitMs: plan.payoutTlcExpiryLimitMs });
      }
    });

    it("returns whole milliseconds with a fractional fast interval", () => {
      const odd = profileWith("mutinynet", { btcFastBlockSeconds: 0.0333 });
      const result = expectPlan(
        checkLnToFiberPayout(odd, {
          earliestHtlcExpiryHeight: 738_038 + ACCEPT_HEIGHT,
          currentHeight: ACCEPT_HEIGHT,
          plannedTlcExpiryLimitMs: minutes(410),
        }),
      );

      expect(Number.isInteger(result.payoutTlcExpiryLimitMs)).toBe(true);
      expect(result.payoutTlcExpiryLimitMs).toBeLessThan(minutes(410));
    });
  });

  describe("invalid input", () => {
    const valid = { earliestHtlcExpiryHeight: 1_861, currentHeight: 1_000, plannedTlcExpiryLimitMs: minutes(410) };

    it.each(Object.keys(valid))("refuses a NaN or negative %s and names it", (field) => {
      for (const bad of [Number.NaN, -1, Number.NEGATIVE_INFINITY]) {
        const reason = expectRefusal(checkLnToFiberPayout(profile("mutinynet"), { ...valid, [field]: bad }));
        expect(reason).toContain(field);
      }
    });
  });
});
