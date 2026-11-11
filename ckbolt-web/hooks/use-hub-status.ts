"use client";

import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AssetDto, HealthDto } from "@/lib/hub/contract";
import { HUB_CLIENT_TIMING } from "@/lib/hub/constants";
import { HUB_STATUS_CHECKING, HUB_STATUS_OFF, readHubStatus, type HubLiveState, type HubStatusSnapshot } from "@/lib/hub/status";
import { useHubClient } from "./use-hub-client";

export interface HubStatus {
  state: HubLiveState;
  /** True when the swap form should run live swaps through the hub. */
  live: boolean;
  health: HealthDto | null;
  assets: AssetDto[];
  refresh: () => Promise<void>;
}

const toHubStatus = (snapshot: HubStatusSnapshot, refresh: () => Promise<void>): HubStatus => ({
  state: snapshot.state,
  live: snapshot.state === "live",
  health: snapshot.health,
  assets: snapshot.assets,
  refresh,
});

/** What a part of the page that does not use the hub sees. */
const HUB_OFF: HubStatus = toHubStatus(HUB_STATUS_OFF, async () => {});

/**
 * Whether a CKBolt hub is configured and healthy (GET /v1/health, then GET /v1/assets). Checked when enabled, then
 * again every minute while the hub answers; an unconfigured or unreachable hub is not asked again until reload.
 * `holdState` stops those re-checks, so a running swap keeps the state it started with.
 */
export function useHubStatus(enabled = true, holdState = false): HubStatus {
  const client = useHubClient();
  const [snapshot, setSnapshot] = useState<HubStatusSnapshot>(enabled ? HUB_STATUS_CHECKING : HUB_STATUS_OFF);
  const latest = useRef(0);
  const held = useRef(holdState);
  useEffect(() => {
    held.current = holdState;
  }, [holdState]);

  const refresh = useCallback(async () => {
    const id = ++latest.current;
    const next = await readHubStatus(client);
    if (id === latest.current && !held.current) setSnapshot(next);
  }, [client]);

  useEffect(() => {
    if (!enabled) {
      setSnapshot(HUB_STATUS_OFF);
      return;
    }
    void refresh();
    return () => {
      // An answer that arrives after this point is for a check nobody waits for.
      latest.current += 1;
    };
  }, [enabled, refresh]);

  const answering = snapshot.state === "live" || snapshot.state === "degraded";
  useEffect(() => {
    if (!enabled || !answering || holdState) return;
    const id = setInterval(() => void refresh(), HUB_CLIENT_TIMING.statusRefreshMs);
    return () => clearInterval(id);
  }, [enabled, answering, holdState, refresh]);

  return useMemo(() => toHubStatus(snapshot, refresh), [snapshot, refresh]);
}

interface SharedHubStatus {
  status: HubStatus;
  /** Stops the re-checks until the returned release is called; several holders can hold at once. */
  hold: () => () => void;
}

const HubStatusContext = createContext<SharedHubStatus | null>(null);

/**
 * One hub status for the whole /app page, so the page's intro and the swap form agree and the hub is asked once.
 * Any part below it can hold the state (a running swap does) with `useSharedHubStatus(enabled, holdState)`.
 */
export function HubStatusProvider({ children }: { children: ReactNode }) {
  const [holders, setHolders] = useState(0);
  const status = useHubStatus(true, holders > 0);
  const hold = useCallback(() => {
    setHolders((n) => n + 1);
    return () => setHolders((n) => n - 1);
  }, []);
  const value = useMemo(() => ({ status, hold }), [status, hold]);
  return createElement(HubStatusContext.Provider, { value }, children);
}

/**
 * The page's hub status from the nearest HubStatusProvider; the `off` status when not `enabled` (a tab that does not
 * use the hub). `holdState` keeps the status as it is while true, as `useHubStatus` does.
 */
export function useSharedHubStatus(enabled = true, holdState = false): HubStatus {
  const shared = useContext(HubStatusContext);
  if (!shared) throw new Error("useSharedHubStatus needs a HubStatusProvider above it.");
  const { status, hold } = shared;
  useEffect(() => (enabled && holdState ? hold() : undefined), [enabled, holdState, hold]);
  return enabled ? status : HUB_OFF;
}
