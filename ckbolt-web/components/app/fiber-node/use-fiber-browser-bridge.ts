"use client";

import { useCallback, useRef, useState } from "react";
import { BridgeClient, nextPresenceRead, NO_PRESENCE, type PresenceRead } from "@/lib/wallets/fiber-browser/bridge-client";
import type { NodePresence } from "@/lib/wallets/fiber-browser/bridge-protocol";
import { BRIDGE_TIMING } from "@/lib/wallets/fiber-browser/constants";
import { usePolling } from "./use-polling";

export interface FiberBrowserBridge {
  /** The best answer of the open node tabs, or null when none answered. */
  presence: NodePresence | null;
  /** No answer window has closed yet. */
  checking: boolean;
  check: () => Promise<void>;
  client: BridgeClient;
}

/**
 * The swap form's view of the visitor's node tab, asked again every few seconds while `active`. A busy or hidden tab can
 * answer after the status window: its late answer still counts, and a node that misses one window keeps its last
 * answer (nextPresenceRead), so the card does not flicker to "Open your Fiber node" or send its button to Home.
 */
export function useFiberBrowserBridge(active: boolean): FiberBrowserBridge {
  const [client] = useState(() => new BridgeClient());
  const [read, setRead] = useState<PresenceRead>(NO_PRESENCE);
  const [checking, setChecking] = useState(true);
  // Each request is numbered; an answer never replaces one to a newer request.
  const asked = useRef(0);
  const applied = useRef(0);

  const check = useCallback(async () => {
    const n = ++asked.current;
    const apply = (answer: NodePresence | null) => {
      if (n < applied.current) return;
      applied.current = n;
      setRead((previous) => nextPresenceRead(previous, answer));
    };
    apply(await client.status(apply));
    setChecking(false);
  }, [client]);

  usePolling(check, BRIDGE_TIMING.statusRefreshMs, active);
  return { presence: read.presence, checking, check, client };
}
