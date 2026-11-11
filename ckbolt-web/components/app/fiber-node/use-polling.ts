"use client";

import { useEffect, useRef } from "react";

/** Runs `task` now and then every `intervalMs` while `enabled`; the latest `task` is used, so callers need not memoize it. */
export function usePolling(task: () => unknown, intervalMs: number, enabled: boolean): void {
  const latest = useRef(task);
  useEffect(() => {
    latest.current = task;
  });
  useEffect(() => {
    if (!enabled) return;
    void latest.current();
    const id = setInterval(() => void latest.current(), intervalMs);
    return () => clearInterval(id);
  }, [enabled, intervalMs]);
}
