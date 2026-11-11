"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { BrowserNodeConfig } from "@/lib/wallets/fiber-browser/config";
import { loadFiber } from "@/lib/wallets/fiber-browser/fiber-loader";
import { BrowserNodeController, type NodeState } from "@/lib/wallets/fiber-browser/node-controller";
import { acquireNodeLock } from "@/lib/wallets/fiber-browser/node-lock";

/** The page's one node controller and its state. The node stops when the page unmounts. */
export function useNodeController(config: BrowserNodeConfig): { controller: BrowserNodeController; state: NodeState } {
  const [controller] = useState(() => new BrowserNodeController({ config, load: loadFiber, lock: (name) => acquireNodeLock(name) }));
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  useEffect(
    () => () => {
      void controller.stop();
    },
    [controller],
  );
  return { controller, state };
}
