"use client";

import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { RateSnapshot } from "@/lib/quote";

export type RateState = {
  rate: RateSnapshot | null;
  /** Last fetch error; kept even while an older price is still shown. */
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
};

const RateContext = createContext<RateState | null>(null);

function useRateSource(enabled: boolean, refreshMs: number): RateState {
  const [rate, setRate] = useState<RateSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/rate", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Market rate is unavailable.");
      setRate(json as RateSnapshot);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Market rate is unavailable.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    refresh();
    const id = setInterval(refresh, refreshMs);
    return () => clearInterval(id);
  }, [enabled, refresh, refreshMs]);

  return useMemo(() => ({ rate, error, loading, refresh }), [rate, error, loading, refresh]);
}

/** One shared price feed for everything below it, instead of one poll per component. */
export function RateProvider({ children, refreshMs = 30_000 }: { children: ReactNode; refreshMs?: number }) {
  const value = useRateSource(true, refreshMs);
  return createElement(RateContext.Provider, { value }, children);
}

/** Reference prices, refreshed every 30 seconds. Uses the nearest RateProvider when there is one. */
export function useRate(refreshMs = 30_000): RateState {
  const shared = useContext(RateContext);
  const own = useRateSource(shared === null, refreshMs);
  return shared ?? own;
}
