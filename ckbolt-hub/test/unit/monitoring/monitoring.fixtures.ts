import type { HealthReport, HealthService } from "../../../src/application/health/health.contract";
import type { SwapWatchLimits } from "../../../src/application/monitoring/monitor.checks";
import type { Alert, AlertSink } from "../../../src/application/ports/alert-sink.port";
import type { AssetAvailability, PricingService } from "../../../src/application/pricing/pricing.contract";
import { MS_PER_MINUTE, MS_PER_SECOND } from "../../../src/common/constants/protocol.constants";
import { SWAP_DIRECTIONS } from "../../../src/common/constants/swap.constants";
import { assetRegistryOf, loadHubConfig, type HubConfig } from "../../../src/config/hub.config";
import type { AssetLiquidity } from "../../../src/domain/pricing";
import type { FiberAsset, FiberAssetId, Quote } from "../../../src/domain/types";
import { DEVNET_RUSD_SCRIPT } from "../api/api.fixtures";

/**
 * Shared fixtures for the monitoring tests (src/application/monitoring, src/infrastructure/alerts). The monitor's
 * settings are explicit and differ from the env defaults, so a spec shows the monitor reads them from config.
 */

export const minutes = (n: number): number => n * MS_PER_MINUTE;
export const seconds = (n: number): number => n * MS_PER_SECOND;

/** How long a swap may stay in each step before the monitor alerts it (MONITOR_* minutes, as ms). */
export const SWAP_LIMITS: SwapWatchLimits = {
  settleMs: minutes(4),
  payoutInFlightMs: minutes(20),
  payoutStartMs: minutes(6),
  refundMs: minutes(12),
};
export const MONITOR_INTERVAL_MS = seconds(30);
export const ALERT_REPEAT_MS = minutes(45);
export const FAILED_PASSES_ALERT = 3;

/** The default config (devnet, RUSD stand-in) with the monitor on and the settings above. */
export function monitorConfig(patch: Partial<HubConfig["monitoring"]> = {}): HubConfig {
  const base = loadHubConfig({ UDT_RUSD_SCRIPT: JSON.stringify(DEVNET_RUSD_SCRIPT) });
  return {
    ...base,
    monitoring: {
      enabled: true,
      intervalMs: MONITOR_INTERVAL_MS,
      repeatMs: ALERT_REPEAT_MS,
      swapLimits: SWAP_LIMITS,
      failedPassesAlert: FAILED_PASSES_ALERT,
      webhook: null,
      ...patch,
    },
  };
}

/** An AlertSink that keeps every alert it is given. */
export class RecordingAlertSink implements AlertSink {
  readonly sent: Alert[] = [];

  async send(alert: Alert): Promise<void> {
    this.sent.push(alert);
  }

  /** The alerts sent since the last call. */
  takeSent(): Alert[] {
    return this.sent.splice(0);
  }
}

/** A health report: ok unless the patch says otherwise. */
export const healthReport = (patch: Partial<HealthReport> = {}): HealthReport => ({
  status: "ok",
  version: "test",
  lightning: { reachable: true, network: "regtest", synced: true, blockHeight: 100 },
  fiber: { reachable: true, network: "devnet", version: "0.9.1" },
  demo: { enabled: false },
  swaps: { paused: false },
  ...patch,
});

export const DEGRADED_REASON = "The hub's Lightning node does not answer.";
export const degradedReport = (): HealthReport => healthReport({ status: "degraded", reason: DEGRADED_REASON });

/** A HealthService whose answer a spec sets (or makes throw). */
export class StubHealthService implements HealthService {
  readonly check = jest.fn(async (): Promise<HealthReport> => healthReport());
}

/** A PricingService for the monitor: only listAssets is read; it answers [] unless a spec sets it. */
export class StubPricingService implements PricingService {
  readonly listAssets = jest.fn(async (): Promise<AssetAvailability[]> => []);

  createQuote(): Promise<Quote> {
    return Promise.reject(new Error("The monitor never creates quotes."));
  }

  getQuote(): Quote | null {
    return null;
  }

  verifyQuote(): boolean {
    return false;
  }

  liquidityFor(): Promise<AssetLiquidity> {
    return Promise.reject(new Error("The monitor never asks for one asset's liquidity."));
  }
}

/* --------------------------------------------------------------------------------------------- availability */

export const MIN_SATS = 1_000n;
export const MAX_SATS = 100_000n;
/** Base units of one whole asset (CKB and the RUSD stand-in have 8 decimals). */
export const ONE_WHOLE = 100_000_000n;

const ASSETS = assetRegistryOf(monitorConfig());

export function servedAsset(id: FiberAssetId): FiberAsset {
  const asset = ASSETS.get(id);
  if (!asset) throw new Error(`test setup: asset ${id} is not served`);
  return asset;
}

/** What GET /v1/assets would say of `id`: plenty of liquidity on both sides unless the patch says otherwise. */
export function availability(
  id: FiberAssetId,
  patch: { minSats?: bigint; maxSats?: bigint; lightningSats?: bigint; fiberAmount?: bigint } = {},
): AssetAvailability {
  return {
    asset: servedAsset(id),
    directions: [...SWAP_DIRECTIONS],
    minSats: patch.minSats ?? MIN_SATS,
    maxSats: patch.maxSats ?? MAX_SATS,
    liquidity: { lightningSats: patch.lightningSats ?? MAX_SATS, fiberAmount: patch.fiberAmount ?? ONE_WHOLE },
  };
}
