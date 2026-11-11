"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FiberNodeDto } from "@/lib/hub/contract";
import { dialHub, hubDialAddresses, isHubConnected } from "@/lib/wallets/fiber-browser/hub-link";
import { needsTlsPeers } from "@/lib/wallets/fiber-browser/node-config";
import type { BrowserFiberNode } from "@/lib/wallets/fiber-browser/node-port";

export interface HubLink {
  /** The hub's WebSocket addresses this page can dial. */
  addresses: string[];
  connected: boolean;
  dialing: boolean;
  error: string | null;
  dial: () => Promise<void>;
}

/** The hub's addresses this page can dial: on an https page only TLS ones. */
export const pageDialAddresses = (hubNode: FiberNodeDto | null): string[] =>
  hubDialAddresses(hubNode, typeof location !== "undefined" && needsTlsPeers(location));

/** Connects the running node to the hub's node once it runs, and on demand; `peers` says whether it still is. */
export function useHubLink(node: BrowserFiberNode | null, hubNode: FiberNodeDto | null, peers: readonly string[], onDialed: () => void): HubLink {
  const addresses = useMemo(() => pageDialAddresses(hubNode), [hubNode]);
  const [dialing, setDialing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connected = isHubConnected(peers, hubNode?.nodeId);
  const afterDial = useRef(onDialed);
  useEffect(() => {
    afterDial.current = onDialed;
  });

  const dial = useCallback(async () => {
    if (!node || !hubNode) return;
    setDialing(true);
    const result = await dialHub(node, addresses);
    setError(result.error);
    setDialing(false);
    afterDial.current();
  }, [node, hubNode, addresses]);

  // Dial as soon as both the node and the hub's addresses are known.
  useEffect(() => {
    void dial();
  }, [dial]);

  return { addresses, connected, dialing, error, dial };
}
