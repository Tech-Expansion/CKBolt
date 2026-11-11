"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ManualFiberStep, type FiberInvoiceRequest, type FiberWalletApi, type FiberWalletKind } from "../contracts";
import { useFiberBrowserBridge } from "@/components/app/fiber-node/use-fiber-browser-bridge";
import type { BridgeClient } from "@/lib/wallets/fiber-browser/bridge-client";
import { BrowserNodeWallet, type FiberPayRequest } from "@/lib/wallets/fiber-wallet/browser-node-wallet";
import { fiberActionRoute, fiberWalletState, type BrowserNodeView } from "@/lib/wallets/fiber-wallet/state";
import { useRememberedFiberKind } from "./use-remembered-fiber-kind";

export interface FiberWalletController {
  /** What the swap card uses (components/app/swap/contracts.ts). */
  api: FiberWalletApi;
  /** The node tab's last answer and a way to ask again now, for the Fiber wallet dialog. */
  node: { view: BrowserNodeView; check: () => Promise<void> };
  /** The bridge to the node tab, for Pay's own requests (a Fiber invoice, CKB on chain). */
  client: BridgeClient;
}

export interface FiberWalletControllerOptions {
  /** Pay: always the browser node, whatever the swap card chose; choose and disconnect do nothing. */
  fixedKind?: FiberWalletKind;
  /** With a fixed kind: ask the node tab every few seconds only while true (the tab is shown, or a payment runs). */
  active?: boolean;
}

/**
 * The visitor's Fiber wallet: the chosen kind (remembered in this tab), the browser node over the bridge, and the
 * actions the swap card runs. The node tab is asked every few seconds while the browser node is chosen or `watching`
 * (the Fiber dialog is open). Actions read the latest state when called, so a runner holding an older `api` is safe.
 */
export function useFiberWalletController(hubNetwork: string | null, watching: boolean, options: FiberWalletControllerOptions = {}): FiberWalletController {
  const [remembered, setKind] = useRememberedFiberKind();
  const { fixedKind } = options;
  const kind = fixedKind ?? remembered;
  const polling = fixedKind ? (options.active ?? true) : kind === "browser-node";
  const bridge = useFiberBrowserBridge(polling || watching);
  const [wallet] = useState(() => new BrowserNodeWallet(bridge.client));

  const view = useMemo<BrowserNodeView>(() => ({ presence: bridge.presence, checking: bridge.checking }), [bridge.presence, bridge.checking]);
  const state = useMemo(() => fiberWalletState(kind, view, hubNetwork), [kind, view, hubNetwork]);

  const latest = useRef(state);
  useEffect(() => {
    latest.current = state;
  }, [state]);

  const choose = useCallback((next: FiberWalletKind) => !fixedKind && setKind(next), [setKind, fixedKind]);
  const disconnect = useCallback(() => !fixedKind && setKind(null), [setKind, fixedKind]);

  const makeInvoice = useCallback(
    async (request: FiberInvoiceRequest): Promise<string> => {
      const route = fiberActionRoute(latest.current);
      if (route.to === "own-node") throw new ManualFiberStep();
      if (route.to === "nowhere") throw new Error(route.reason);
      return wallet.makeInvoice(request);
    },
    [wallet],
  );

  const payInvoice = useCallback(
    async (request: FiberPayRequest): Promise<void> => {
      // A swap this page already paid gets that payment's answer, even when the node is no longer ready.
      const known = wallet.paymentFor(request.swapId);
      if (known) return known;
      const route = fiberActionRoute(latest.current);
      if (route.to === "own-node") throw new ManualFiberStep();
      if (route.to === "nowhere") throw new Error(route.reason);
      return wallet.payInvoice(request);
    },
    [wallet],
  );

  const api = useMemo<FiberWalletApi>(
    () => ({ ...state, choose, disconnect, makeInvoice, payInvoice }),
    [state, choose, disconnect, makeInvoice, payInvoice],
  );
  const node = useMemo(() => ({ view, check: bridge.check }), [view, bridge.check]);
  return { api, node, client: bridge.client };
}
