import {
  assetLiquidity,
  availablePayout,
  fiberLiquidity,
  largestPayoutWithin,
  payoutCapacity,
  payoutWithFeeBudget,
  reservedPayouts,
  type ChannelLiquidity,
  type PayoutReservation,
} from "../../../src/domain/pricing";
import { createAssetRegistry, knownUdtAssets } from "../../../src/domain/assets";
import type { FiberAsset, FiberAssetId } from "../../../src/domain/types";
import { ALL_UDT_SCRIPTS, CWBTC_SCRIPT, OTHER_UDT_SCRIPT, RUSD_SCRIPT, RUSD_SCRIPT_UPPER } from "./pricing.fixtures";

const assets = createAssetRegistry("devnet", knownUdtAssets(ALL_UDT_SCRIPTS));
const assetOf = (id: FiberAssetId): FiberAsset => {
  const found = assets.get(id);
  if (!found) throw new Error(`fixture asset ${id} missing`);
  return found;
};

const ch = (patch: Partial<ChannelLiquidity>): ChannelLiquidity => ({ udtTypeScript: null, ready: true, localBalance: 0n, ...patch });

const channels: ChannelLiquidity[] = [
  ch({ localBalance: 1_000n }),
  ch({ localBalance: 2_000n }),
  ch({ localBalance: 50_000n, ready: false }),
  ch({ udtTypeScript: RUSD_SCRIPT, localBalance: 300n }),
  ch({ udtTypeScript: RUSD_SCRIPT_UPPER, localBalance: 30n }),
  ch({ udtTypeScript: RUSD_SCRIPT, localBalance: 9_999n, ready: false }),
  ch({ udtTypeScript: CWBTC_SCRIPT, localBalance: 7n }),
  ch({ udtTypeScript: OTHER_UDT_SCRIPT, localBalance: 123_456n }),
];

describe("domain pricing: liquidity", () => {
  it("counts only ready CKB channels (no type script) for CKB", () => {
    expect(fiberLiquidity(channels, assetOf("CKB"))).toBe(3_000n);
  });

  it("counts only ready channels whose UDT script matches, ignoring hex case", () => {
    expect(fiberLiquidity(channels, assetOf("RUSD"))).toBe(330n);
    expect(fiberLiquidity(channels, assetOf("CWBTC"))).toBe(7n);
  });

  it("is zero with no channels, or none in that asset", () => {
    expect(fiberLiquidity([], assetOf("CKB"))).toBe(0n);
    expect(fiberLiquidity([ch({ udtTypeScript: OTHER_UDT_SCRIPT, localBalance: 5n })], assetOf("RUSD"))).toBe(0n);
    expect(fiberLiquidity([ch({ udtTypeScript: RUSD_SCRIPT, localBalance: 5n })], assetOf("CKB"))).toBe(0n);
  });

  it("does not match a script that differs only in hash type or args", () => {
    const sameCodeOtherType = ch({ udtTypeScript: { ...RUSD_SCRIPT, hashType: "data" }, localBalance: 5n });
    const sameCodeOtherArgs = ch({ udtTypeScript: { ...RUSD_SCRIPT, args: "0x99" }, localBalance: 5n });

    expect(fiberLiquidity([sameCodeOtherType, sameCodeOtherArgs], assetOf("RUSD"))).toBe(0n);
  });

  it("never counts the remote side of a channel", () => {
    const withRemote = [{ ...ch({ localBalance: 10n }), remoteBalance: 1_000_000n }];

    expect(fiberLiquidity(withRemote, assetOf("CKB"))).toBe(10n);
  });

  it("reports both sides for an asset", () => {
    expect(assetLiquidity({ lightningSats: 42n, fiberChannels: channels }, assetOf("RUSD"))).toEqual({
      lightningSats: 42n,
      fiberAmount: 330n,
    });
  });

  it("ln_to_fiber pays out on Fiber; fiber_to_ln pays out on Lightning", () => {
    const liquidity = { lightningSats: 42n, fiberAmount: 330n };

    expect(payoutCapacity("ln_to_fiber", liquidity)).toBe(330n);
    expect(payoutCapacity("fiber_to_ln", liquidity)).toBe(42n);
  });

  describe("reservations and fee budgets", () => {
    const open = (patch: Partial<PayoutReservation>): PayoutReservation => ({
      direction: "fiber_to_ln",
      asset: "CKB",
      state: "pending",
      sats: 1_000n,
      fiberAmount: 400_000n,
      ...patch,
    });

    it("a payout ties up its amount plus its fee budget, rounded up", () => {
      expect(payoutWithFeeBudget(10_000n, 100)).toBe(10_100n);
      expect(payoutWithFeeBudget(1n, 1)).toBe(2n);
      expect(payoutWithFeeBudget(5_000n, 0)).toBe(5_000n);
    });

    it("the largest payout within a balance leaves room for its fee budget", () => {
      expect(largestPayoutWithin(10_100n, 100)).toBe(10_000n);
      expect(largestPayoutWithin(10_099n, 100)).toBe(9_999n);
      expect(largestPayoutWithin(0n, 100)).toBe(0n);
      expect(largestPayoutWithin(-5n, 100)).toBe(0n);
      for (const balance of [1n, 99n, 101n, 12_345n, 999_999n]) {
        const payout = largestPayoutWithin(balance, 37);
        expect(payoutWithFeeBudget(payout, 37)).toBeLessThanOrEqual(balance);
        expect(payoutWithFeeBudget(payout + 1n, 37)).toBeGreaterThan(balance);
      }
    });

    it("reserves Lightning for every fiber_to_ln swap not paid out yet, whatever its asset", () => {
      const swaps = [
        open({ asset: "CKB", state: "pending", sats: 1_000n }),
        open({ asset: "RUSD", state: "incoming_accepted", sats: 2_000n }),
        open({ state: "outgoing_in_flight", sats: 50_000n }),
        open({ state: "outgoing_succeeded", sats: 50_000n }),
        open({ state: "failed", sats: 50_000n }),
        open({ direction: "ln_to_fiber", state: "pending", sats: 50_000n }),
      ];

      expect(reservedPayouts(swaps, { direction: "fiber_to_ln", asset: "CWBTC" }, 100)).toBe(1_010n + 2_020n);
    });

    it("reserves an asset's Fiber channels only for ln_to_fiber swaps in that asset", () => {
      const swaps = [
        open({ direction: "ln_to_fiber", asset: "CKB", fiberAmount: 400_000n }),
        open({ direction: "ln_to_fiber", asset: "RUSD", fiberAmount: 7_000n }),
        open({ direction: "fiber_to_ln", asset: "CKB", fiberAmount: 9_000_000n }),
      ];

      expect(reservedPayouts(swaps, { direction: "ln_to_fiber", asset: "CKB" }, 50)).toBe(402_000n);
      expect(reservedPayouts(swaps, { direction: "ln_to_fiber", asset: "RUSD" }, 50)).toBe(7_035n);
    });

    it("what a new quote can get: the payout side less reservations, after its own fee budget", () => {
      const liquidity = { lightningSats: 30_300n, fiberAmount: 0n };
      const swaps = [open({ sats: 10_000n })];

      expect(availablePayout(liquidity, swaps, { direction: "fiber_to_ln", asset: "CKB" }, 100)).toBe(20_000n);
      expect(availablePayout(liquidity, swaps, { direction: "ln_to_fiber", asset: "CKB" }, 100)).toBe(0n);
      expect(availablePayout({ lightningSats: 5_000n, fiberAmount: 0n }, swaps, { direction: "fiber_to_ln", asset: "CKB" }, 100)).toBe(0n);
    });
  });
});
