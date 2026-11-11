"use client";

import { useCallback, useState } from "react";
import { fiberErrorMessage } from "@/lib/wallets/fiber-browser/errors";

export interface NodeAction {
  /** The key of the action running now, or null. */
  working: string | null;
  /** The key of the last action started, so its notice can show next to it. */
  lastKey: string | null;
  /** What the last action did. */
  notice: string | null;
  error: string | null;
  /**
   * Runs one action at a time; its sentence becomes the notice, a throw the error. An action that shows its own outcome
   * (the hub's channels, run row by row) returns null: no notice.
   */
  run: (key: string, action: () => Promise<string | null>) => Promise<void>;
}

/** One action on the node at a time (ask the hub for a channel, close one, open one), with its notice or error. */
export function useNodeAction(onDone: () => void): NodeAction {
  const [working, setWorking] = useState<string | null>(null);
  const [lastKey, setLastKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(
    async (key: string, action: () => Promise<string | null>) => {
      setWorking(key);
      setLastKey(key);
      setError(null);
      setNotice(null);
      try {
        setNotice(await action());
        onDone();
      } catch (e) {
        setError(fiberErrorMessage(e));
      } finally {
        setWorking(null);
      }
    },
    [onDone],
  );
  return { working, lastKey, notice, error, run };
}
