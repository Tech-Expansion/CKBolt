import type { HubClient } from "./client";
import type { AssetDto, HealthDto } from "./contract";

/**
 * Whether the swap form can use the hub.
 * - `off`: not asked (another tab). `checking`: first answer pending.
 * - `live`: healthy, with at least one asset to swap.
 * - `degraded`: reachable but unhealthy or without assets; the app's tabs say the hub is not taking swaps.
 * - `offline`: not configured or unreachable; the app's tabs say the hub is not available.
 */
export type HubLiveState = "off" | "checking" | "live" | "degraded" | "offline";

export interface HubStatusSnapshot {
  state: HubLiveState;
  health: HealthDto | null;
  /** Assets with at least one direction; empty unless live. */
  assets: AssetDto[];
}

export const HUB_STATUS_OFF: HubStatusSnapshot = { state: "off", health: null, assets: [] };
export const HUB_STATUS_CHECKING: HubStatusSnapshot = { state: "checking", health: null, assets: [] };

/** Asks the hub for its health, then its assets, and sums them up as one state. */
export async function readHubStatus(client: Pick<HubClient, "health" | "listAssets">): Promise<HubStatusSnapshot> {
  let health: HealthDto;
  try {
    health = await client.health();
  } catch {
    return { state: "offline", health: null, assets: [] };
  }
  if (health.status !== "ok") return { state: "degraded", health, assets: [] };
  try {
    const assets = (await client.listAssets()).filter((a) => a.directions.length > 0);
    return { state: assets.length > 0 ? "live" : "degraded", health, assets };
  } catch {
    return { state: "degraded", health, assets: [] };
  }
}
