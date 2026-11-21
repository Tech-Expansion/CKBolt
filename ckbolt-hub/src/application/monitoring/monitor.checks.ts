import { MS_PER_MINUTE } from "../../common/constants/protocol.constants";
import { SWAP_STATE } from "../../common/constants/swap.constants";
import { needsRefund } from "../../domain/swap";
import type { Swap } from "../../domain/types";
import type { HealthReport } from "../health/health.contract";
import type { AssetAvailability } from "../pricing/pricing.contract";
import type { Alert } from "../ports/alert-sink.port";

/**
 * What the hub's monitor watches, as pure functions of what it read: each returns the conditions that hold now. The
 * monitor (hub-monitor.service.ts) alerts a condition when it starts, reminds while it lasts, and says when it clears.
 */

/** A condition that holds now. */
export type Condition = Omit<Alert, "level"> & { level: "critical" | "warning" };

/** How long a swap may stay in a step before the operator hears of it, ms (MONITOR_* settings). */
export interface SwapWatchLimits {
  /** The payout succeeded but the incoming payment is not collected yet: money at risk if it lasts. */
  settleMs: number;
  /** A payout is still in flight. */
  payoutInFlightMs: number;
  /** The incoming payment is held but the payout has not started. */
  payoutStartMs: number;
  /** A failed swap whose incoming payment is not given back yet. */
  refundMs: number;
}

const minutes = (ms: number): number => Math.floor(ms / MS_PER_MINUTE);

/** Swaps that have stayed too long in a step where money waits on the hub. */
export function swapConditions(swaps: readonly Swap[], now: number, limits: SwapWatchLimits): Condition[] {
  return swaps.flatMap((swap): Condition[] => {
    const age = now - swap.updatedAt;
    const label = `Swap ${swap.id} (${swap.direction}, ${swap.asset})`;
    if (swap.state === SWAP_STATE.OUTGOING_SUCCEEDED && age > limits.settleMs) {
      return [
        {
          key: `swap:${swap.id}:settle`,
          level: "critical",
          title: "Payout sent, incoming payment not collected",
          detail: `${label}: the payout succeeded ${minutes(age)} min ago and the hub has not settled the incoming payment yet. It keeps trying; if the incoming hold expires first, the hub loses the payout.`,
        },
      ];
    }
    if (swap.state === SWAP_STATE.OUTGOING_IN_FLIGHT && age > limits.payoutInFlightMs) {
      return [
        {
          key: `swap:${swap.id}:in-flight`,
          level: "warning",
          title: "Payout still in flight",
          detail: `${label}: the payout has been in flight for ${minutes(age)} min.`,
        },
      ];
    }
    if (swap.state === SWAP_STATE.INCOMING_ACCEPTED && age > limits.payoutStartMs) {
      return [
        {
          key: `swap:${swap.id}:start`,
          level: "warning",
          title: "Payment held, payout not started",
          detail: `${label}: the hub has held the payment for ${minutes(age)} min without starting the payout.`,
        },
      ];
    }
    if (needsRefund(swap) && age > limits.refundMs) {
      return [
        {
          key: `swap:${swap.id}:refund`,
          level: "warning",
          title: "Refund not done",
          detail: `${label}: the swap failed ${minutes(age)} min ago and the incoming payment is not given back yet.`,
        },
      ];
    }
    return [];
  });
}

/** The hub's own health check: degraded, or unreadable. */
export function healthConditions(report: HealthReport | null, error: string | null): Condition[] {
  if (report === null) {
    return [{ key: "health", level: "critical", title: "Health check failed", detail: error ?? "The health check did not answer." }];
  }
  if (report.status === "ok") return [];
  return [{ key: "health", level: "critical", title: "Hub degraded", detail: report.reason ?? "The hub reports itself degraded." }];
}

/**
 * Payout liquidity: Lightning (shared by every asset's CKB or token to BTC swaps) below the largest swap or below the
 * smallest, and an asset whose Fiber channels can pay out nothing (BTC to that asset).
 */
export function liquidityConditions(assets: readonly AssetAvailability[]): Condition[] {
  if (assets.length === 0) return [];
  const lightningSats = assets[0]?.liquidity.lightningSats ?? 0n;
  const largest = assets.reduce((max, a) => (a.maxSats > max ? a.maxSats : max), 0n);
  const smallest = assets.reduce((min, a) => (a.minSats < min ? a.minSats : min), largest);
  const conditions: Condition[] = [];
  if (lightningSats < smallest) {
    conditions.push({
      key: "liquidity:lightning",
      level: "critical",
      title: "No Lightning payout liquidity",
      detail: `The hub can pay out ${lightningSats} sats on Lightning, less than the smallest swap (${smallest}): swaps to BTC fail.`,
    });
  } else if (lightningSats < largest) {
    conditions.push({
      key: "liquidity:lightning",
      level: "warning",
      title: "Low Lightning payout liquidity",
      detail: `The hub can pay out ${lightningSats} sats on Lightning, less than the largest swap (${largest}).`,
    });
  }
  for (const { asset, liquidity } of assets) {
    if (liquidity.fiberAmount > 0n) continue;
    conditions.push({
      key: `liquidity:fiber:${asset.id}`,
      level: "critical",
      title: `No ${asset.symbol} payout liquidity`,
      detail: `The hub's Fiber channels can pay out no ${asset.symbol}: swaps from BTC to ${asset.symbol} fail.`,
    });
  }
  return conditions;
}

/** The scheduler's passes have failed `failed` times in a row. */
export function passConditions(failed: number, threshold: number, lastError: string | null): Condition[] {
  if (failed < threshold) return [];
  return [
    {
      key: "swap-pass",
      level: "critical",
      title: "Swap processing failing",
      detail: `The last ${failed} passes over open swaps failed${lastError ? `: ${lastError}` : ""}.`,
    },
  ];
}
