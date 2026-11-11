"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toHubApiError, type HubApiError, type HubClient } from "@/lib/hub/client";
import type { AssetDto, FiberNodeDto } from "@/lib/hub/contract";

export interface HubFiberNodeState {
  loading: boolean;
  /** GET /v1/fiber/node, or null until it answered. */
  node: FiberNodeDto | null;
  /** GET /v1/assets, for symbols and decimals; empty when unavailable. */
  assets: AssetDto[];
  error: HubApiError | null;
  reload: () => Promise<void>;
}

/** The hub's Fiber node (where to connect, which assets, the inbound policy), read once and on demand. */
export function useHubFiberNode(client: Pick<HubClient, "getFiberNode" | "listAssets">): HubFiberNodeState {
  const [loading, setLoading] = useState(true);
  const [node, setNode] = useState<FiberNodeDto | null>(null);
  const [assets, setAssets] = useState<AssetDto[]>([]);
  const [error, setError] = useState<HubApiError | null>(null);
  const latest = useRef(0);

  const reload = useCallback(async () => {
    const id = ++latest.current;
    setLoading(true);
    try {
      const [fiberNode, listed] = await Promise.all([client.getFiberNode(), client.listAssets().catch(() => [] as AssetDto[])]);
      if (id !== latest.current) return;
      setNode(fiberNode);
      setAssets(listed);
      setError(null);
    } catch (e) {
      if (id === latest.current) setError(toHubApiError(e));
    } finally {
      if (id === latest.current) setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { loading, node, assets, error, reload };
}
