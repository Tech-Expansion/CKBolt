import type { BtcNetwork, CkbNetwork } from "../../domain/types";

/**
 * The hub's health. `network` is what each node itself reports (null when it does not answer, or names a chain the hub
 * does not know), so a node on another network than the hub's configuration shows up as `degraded`.
 */
export interface HealthReport {
  status: "ok" | "degraded";
  /** Why the hub is degraded: one plain sentence per problem. Absent when it is ok. */
  reason?: string;
  version: string;
  lightning: { reachable: boolean; network: BtcNetwork | null; synced: boolean; blockHeight: number | null };
  fiber: { reachable: boolean; network: CkbNetwork | null; version: string | null };
  demo: { enabled: boolean };
  /** SWAPS_PAUSED: the hub takes no new quote or swap (503 maintenance) while the running swaps finish. */
  swaps: { paused: boolean };
}

export interface HealthService {
  check(): Promise<HealthReport>;
}

export const HEALTH_SERVICE = Symbol("HEALTH_SERVICE");
