import { healthConditions, liquidityConditions, passConditions, swapConditions } from "../../../src/application/monitoring/monitor.checks";
import type { SwapState } from "../../../src/domain/types";
import { FakeClock } from "../../fakes";
import { makeSwap } from "../persistence/persistence.fixtures";
import {
  availability,
  DEGRADED_REASON,
  degradedReport,
  FAILED_PASSES_ALERT,
  healthReport,
  MAX_SATS,
  MIN_SATS,
  minutes,
  SWAP_LIMITS,
} from "./monitoring.fixtures";

/**
 * The monitor's checks (monitor.checks.ts): pure functions of what the monitor read, each returning the conditions that
 * hold now (docs/monitoring.md, "What it alerts").
 */

describe("swapConditions", () => {
  const clock = new FakeClock();
  /** A swap that entered `state` `ageMs` ago (every write sets updatedAt), seen at the clock's now. */
  const swapAged = (state: SwapState, ageMs: number, refunded = false) =>
    makeSwap(clock, { state, refunded, updatedAt: clock.now() - ageMs });
  const conditionsOf = (...swaps: ReturnType<typeof swapAged>[]) => swapConditions(swaps, clock.now(), SWAP_LIMITS);

  const RULES = [
    {
      state: "outgoing_succeeded" as SwapState,
      limitMs: SWAP_LIMITS.settleMs,
      suffix: "settle",
      level: "critical",
      title: "Payout sent, incoming payment not collected",
    },
    {
      state: "outgoing_in_flight" as SwapState,
      limitMs: SWAP_LIMITS.payoutInFlightMs,
      suffix: "in-flight",
      level: "warning",
      title: "Payout still in flight",
    },
    {
      state: "incoming_accepted" as SwapState,
      limitMs: SWAP_LIMITS.payoutStartMs,
      suffix: "start",
      level: "warning",
      title: "Payment held, payout not started",
    },
  ];

  describe.each(RULES)("a swap in $state", ({ state, limitMs, suffix, level, title }) => {
    it(`raises nothing at exactly its limit`, () => {
      expect(conditionsOf(swapAged(state, limitMs))).toEqual([]);
    });

    it(`raises a ${level} "${title}" one millisecond past its limit, keyed by the swap`, () => {
      const swap = swapAged(state, limitMs + 1);
      expect(conditionsOf(swap)).toEqual([{ key: `swap:${swap.id}:${suffix}`, level, title, detail: expect.stringContaining(swap.id) }]);
    });

    it("says in the detail which swap it is (direction, asset) and how many whole minutes it has waited", () => {
      const WAITED_MINUTES = 90;
      // A minute less a millisecond past it still counts as the whole minutes waited.
      const swap = swapAged(state, minutes(WAITED_MINUTES + 1) - 1);
      const [condition] = conditionsOf(swap);
      expect(condition?.detail).toContain(`Swap ${swap.id} (${swap.direction}, ${swap.asset})`);
      expect(condition?.detail).toContain(`${WAITED_MINUTES} min`);
    });
  });

  describe("a failed swap", () => {
    it("whose incoming payment is not refunded raises a warning \"Refund not done\" past the refund limit", () => {
      const swap = swapAged("failed", SWAP_LIMITS.refundMs + 1);
      expect(conditionsOf(swap)).toEqual([
        { key: `swap:${swap.id}:refund`, level: "warning", title: "Refund not done", detail: expect.stringContaining(swap.id) },
      ]);
    });

    it("raises nothing at exactly the refund limit", () => {
      expect(conditionsOf(swapAged("failed", SWAP_LIMITS.refundMs))).toEqual([]);
    });

    it("raises nothing once refunded, however old", () => {
      expect(conditionsOf(swapAged("failed", SWAP_LIMITS.refundMs * 10, true))).toEqual([]);
    });
  });

  it.each<SwapState>(["pending", "succeeded"])("raises nothing for a swap in %s, however old", (state) => {
    expect(conditionsOf(swapAged(state, SWAP_LIMITS.payoutInFlightMs * 10))).toEqual([]);
  });

  it("raises nothing while every swap is below its threshold", () => {
    const swaps = RULES.map(({ state, limitMs }) => swapAged(state, limitMs - 1));
    expect(conditionsOf(...swaps, swapAged("failed", SWAP_LIMITS.refundMs - 1))).toEqual([]);
  });

  it("uses each state's own limit: a swap past the shortest limit only is alerted only in that state", () => {
    const age = SWAP_LIMITS.settleMs + 1;
    expect(SWAP_LIMITS.payoutStartMs).toBeGreaterThan(age);
    const settling = swapAged("outgoing_succeeded", age);
    expect(conditionsOf(settling, swapAged("incoming_accepted", age), swapAged("outgoing_in_flight", age)).map((c) => c.key)).toEqual([
      `swap:${settling.id}:settle`,
    ]);
  });

  it("raises one condition per late swap", () => {
    const late = [swapAged("outgoing_succeeded", SWAP_LIMITS.settleMs + 1), swapAged("outgoing_succeeded", SWAP_LIMITS.settleMs + 1)];
    expect(conditionsOf(...late).map((c) => c.key)).toEqual(late.map((swap) => `swap:${swap.id}:settle`));
  });
});

describe("healthConditions", () => {
  it("raises a critical \"Health check failed\" with the error when the check throws", () => {
    expect(healthConditions(null, "connect ECONNREFUSED")).toEqual([
      { key: "health", level: "critical", title: "Health check failed", detail: "connect ECONNREFUSED" },
    ]);
  });

  it("says the check did not answer when there is neither a report nor an error", () => {
    expect(healthConditions(null, null)).toEqual([
      { key: "health", level: "critical", title: "Health check failed", detail: "The health check did not answer." },
    ]);
  });

  it("raises a critical \"Hub degraded\" with the report's reason", () => {
    expect(healthConditions(degradedReport(), null)).toEqual([{ key: "health", level: "critical", title: "Hub degraded", detail: DEGRADED_REASON }]);
  });

  it("says the hub reports itself degraded when the report gives no reason", () => {
    expect(healthConditions(healthReport({ status: "degraded" }), null)).toEqual([
      { key: "health", level: "critical", title: "Hub degraded", detail: "The hub reports itself degraded." },
    ]);
  });

  it("raises nothing when the hub is ok", () => {
    expect(healthConditions(healthReport(), null)).toEqual([]);
  });
});

describe("liquidityConditions", () => {
  it("raises nothing for no assets", () => {
    expect(liquidityConditions([])).toEqual([]);
  });

  it("raises nothing when Lightning covers the largest swap and every asset can pay out", () => {
    expect(liquidityConditions([availability("CKB", { lightningSats: MAX_SATS }), availability("RUSD", { lightningSats: MAX_SATS })])).toEqual([]);
  });

  it("raises a critical \"No Lightning payout liquidity\" below the smallest swap", () => {
    expect(liquidityConditions([availability("CKB", { lightningSats: MIN_SATS - 1n })])).toEqual([
      {
        key: "liquidity:lightning",
        level: "critical",
        title: "No Lightning payout liquidity",
        detail: `The hub can pay out ${MIN_SATS - 1n} sats on Lightning, less than the smallest swap (${MIN_SATS}): swaps to BTC fail.`,
      },
    ]);
  });

  it("raises a warning \"Low Lightning payout liquidity\" at the smallest swap and below the largest", () => {
    for (const lightningSats of [MIN_SATS, MAX_SATS - 1n]) {
      expect(liquidityConditions([availability("CKB", { lightningSats })])).toEqual([
        {
          key: "liquidity:lightning",
          level: "warning",
          title: "Low Lightning payout liquidity",
          detail: `The hub can pay out ${lightningSats} sats on Lightning, less than the largest swap (${MAX_SATS}).`,
        },
      ]);
    }
  });

  it("raises a critical \"No Lightning payout liquidity\" with none at all", () => {
    expect(liquidityConditions([availability("CKB", { lightningSats: 0n })]).map((c) => [c.key, c.level])).toEqual([["liquidity:lightning", "critical"]]);
  });

  it("takes the smallest and largest swap over every asset", () => {
    const LOW_MIN = 500n;
    const HIGH_MAX = 200_000n;
    const assets = [availability("CKB", { minSats: LOW_MIN, lightningSats: MIN_SATS }), availability("RUSD", { maxSats: HIGH_MAX, lightningSats: MIN_SATS })];
    expect(liquidityConditions(assets)).toEqual([expect.objectContaining({ level: "warning", detail: expect.stringContaining(`largest swap (${HIGH_MAX})`) })]);

    const short = assets.map((a) => ({ ...a, liquidity: { ...a.liquidity, lightningSats: LOW_MIN - 1n } }));
    expect(liquidityConditions(short)).toEqual([expect.objectContaining({ level: "critical", detail: expect.stringContaining(`smallest swap (${LOW_MIN})`) })]);
  });

  it("raises a critical \"No <symbol> payout liquidity\" for an asset whose Fiber channels pay out nothing, and only for it", () => {
    const conditions = liquidityConditions([availability("CKB"), availability("RUSD", { fiberAmount: 0n })]);
    expect(conditions).toEqual([
      {
        key: "liquidity:fiber:RUSD",
        level: "critical",
        title: "No RUSD payout liquidity",
        detail: "The hub's Fiber channels can pay out no RUSD: swaps from BTC to RUSD fail.",
      },
    ]);
  });

  it("raises nothing for an asset with one base unit of payout liquidity", () => {
    expect(liquidityConditions([availability("CKB", { fiberAmount: 1n })])).toEqual([]);
  });

  it("raises the Lightning and the asset conditions together", () => {
    const conditions = liquidityConditions([availability("CKB", { lightningSats: 0n, fiberAmount: 0n }), availability("RUSD", { lightningSats: 0n, fiberAmount: 0n })]);
    expect(conditions.map((c) => c.key)).toEqual(["liquidity:lightning", "liquidity:fiber:CKB", "liquidity:fiber:RUSD"]);
  });
});

describe("passConditions", () => {
  const LAST_ERROR = "database is locked";

  it("raises nothing one failed pass below the threshold", () => {
    expect(passConditions(FAILED_PASSES_ALERT - 1, FAILED_PASSES_ALERT, LAST_ERROR)).toEqual([]);
  });

  it("raises a critical \"Swap processing failing\" at the threshold, with the count and the last error", () => {
    expect(passConditions(FAILED_PASSES_ALERT, FAILED_PASSES_ALERT, LAST_ERROR)).toEqual([
      {
        key: "swap-pass",
        level: "critical",
        title: "Swap processing failing",
        detail: `The last ${FAILED_PASSES_ALERT} passes over open swaps failed: ${LAST_ERROR}.`,
      },
    ]);
  });

  it("keeps raising it above the threshold", () => {
    expect(passConditions(FAILED_PASSES_ALERT + 1, FAILED_PASSES_ALERT, LAST_ERROR)).toHaveLength(1);
  });

  it("leaves the error out of the detail when none is known", () => {
    expect(passConditions(FAILED_PASSES_ALERT, FAILED_PASSES_ALERT, null)[0]?.detail).toBe(`The last ${FAILED_PASSES_ALERT} passes over open swaps failed.`);
  });
});
