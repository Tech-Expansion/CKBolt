"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { CKB_ASSET } from "@/lib/wallets/fiber-browser/channels";
import { walletStateBadge } from "@/lib/wallets/fiber-popup/button-view";
import { WALLET_PAGES, type WalletPage } from "@/lib/wallets/fiber-popup/constants";
import type { WalletRelayStatus } from "@/lib/wallets/fiber-popup/relay";
import { ConfirmRequest } from "../fiber-node/confirm-request";
import { historyNames, type HistoryTarget } from "../fiber-node/history-list";
import { shownPhase } from "../fiber-node/node-status-notice";
import { SecretResetProvider } from "../fiber-node/secret-reset";
import type { NodeWorkspace } from "../fiber-node/use-node-workspace";
import { StatusNotice } from "../status";
import { ChannelsPage } from "./channels-page";
import { PAGES_NEEDING_NODE, WALLET_CHROME, WALLET_PAGE_TITLE } from "./copy";
import { AddFundsPage, WithdrawPage } from "./funds-pages";
import { HistoryPage } from "./history-page";
import { HomePage } from "./home-page";
import { SettingsPage } from "./settings-page";
import { backButton, pageBar } from "./styles";
import { TestnetBadge, WalletStateBadge } from "./wallet-heading";
import { useParentRelay } from "./use-parent-relay";

/** What the header button shows: the phase, whether a key exists, and the CKB a swap can send. Nothing secret. */
function relayStatus(ws: NodeWorkspace): WalletRelayStatus {
  const running = ws.state.phase === "running";
  return {
    isolated: true,
    phase: shownPhase(ws.state, ws.otherTabHolds),
    hasKey: ws.nodeKey.record !== null,
    sendCkb: running ? (ws.liquidity[CKB_ASSET]?.send ?? BigInt(0)).toString() : null,
  };
}

/** The node's title bar when it runs in a window of its own (inside the popover, the popover has one). */
export function WalletTitleBar({ status }: { status?: WalletRelayStatus }) {
  return (
    <header className="flex items-center justify-between gap-3 border-b border-foreground/10 px-4 py-3">
      <div className="flex min-w-0 items-center gap-2">
        <h1 className="font-display text-2xl leading-none whitespace-nowrap">{WALLET_CHROME.TITLE}</h1>
        {status && <WalletStateBadge state={walletStateBadge(status, "live")} />}
      </div>
      <TestnetBadge />
    </header>
  );
}

/** Where focus goes once a page shows: its heading (opened from a button), back to the opener (Back), or nowhere (the header asked). */
type FocusAfter = "heading" | "opener" | null;

/**
 * The Fiber node: Home with its large buttons, and a sub-page per button with Back and its title, as in a wallet
 * extension. Every page stays mounted (hidden when not shown), so what was typed survives going back; passwords typed
 * in it are cleared on every page change, when the popover hides, and when the browser tab is hidden. Pages that need
 * the running node say so until it runs.
 */
export function WalletShell({ ws, framed }: { ws: NodeWorkspace; framed: boolean }) {
  const [nav, setNav] = useState<{ page: WalletPage; focus: FocusAfter; from: WalletPage }>({ page: "home", focus: null, from: "home" });
  const { page } = nav;
  const running = ws.state.phase === "running";
  const rootRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const homeHeadingRef = useRef<HTMLHeadingElement>(null);
  /** The Home button that opened the sub-page shown, to focus again on Back. */
  const opener = useRef<HTMLElement | null>(null);
  const pageRef = useRef(page);
  useEffect(() => {
    pageRef.current = page;
  });

  const [resets, setResets] = useState(0);
  const resetSecrets = useCallback(() => setResets((n) => n + 1), []);

  const go = useCallback(
    (next: WalletPage, focus: FocusAfter) => {
      const from = pageRef.current;
      if (next !== from) resetSecrets();
      if (from === "home" && next !== "home") {
        const active = document.activeElement;
        opener.current = active instanceof HTMLElement && rootRef.current?.contains(active) ? active : null;
      }
      setNav({ page: next, focus, from });
    },
    [resetSecrets],
  );
  const open = useCallback((next: WalletPage) => go(next, next === "home" ? "opener" : "heading"), [go]);
  const back = useCallback(() => go("home", "opener"), [go]);

  useEffect(() => {
    if (nav.focus === "heading") headingRef.current?.focus();
    if (nav.focus !== "opener") return;
    const shown = (el: HTMLElement | null | undefined): el is HTMLElement => !!el && el.isConnected && el.getClientRects().length > 0;
    const own = opener.current;
    const fallback = rootRef.current?.querySelector<HTMLElement>(`[data-opens="${nav.from}"]`);
    (shown(own) ? own : shown(fallback) ? fallback : homeHeadingRef.current)?.focus();
    opener.current = null;
  }, [nav]);

  const status = relayStatus(ws);
  // The app's "View in History": History, open on that entry.
  const [target, setTarget] = useState<HistoryTarget | null>(null);
  // The header opens the popup on a page (the swap card's "Ask the hub for a channel" on Channels) or on an entry of
  // History; the popover moves focus.
  useParentRelay(status, {
    onHidden: resetSecrets,
    onNavigate: (next) => go(next, null),
    onOpenEntry: (ref) => {
      go("history", null);
      setTarget({ ref, at: Date.now() });
    },
  });
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") resetSecrets();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [resetSecrets]);

  // A request from Pay opens Confirm by itself, in the popup and in a window of its own: the visitor answers it there.
  const pendingId = ws.confirmations.pending?.id ?? null;
  const shownRequest = useRef<number | null>(null);
  useEffect(() => {
    if (pendingId === null || shownRequest.current === pendingId) return;
    shownRequest.current = pendingId;
    go("confirm", "heading");
  }, [pendingId, go]);

  const names = useMemo(() => historyNames(ws.decimalsOf, ws.symbolOf, ws.hubNodeIds, ws.lookOf), [ws.decimalsOf, ws.symbolOf, ws.hubNodeIds, ws.lookOf]);
  const pages: Record<WalletPage, ReactNode> = {
    home: <HomePage ws={ws} names={names} onOpen={open} />,
    "add-funds": <AddFundsPage ws={ws} />,
    channels: <ChannelsPage ws={ws} />,
    withdraw: <WithdrawPage ws={ws} onOpen={open} />,
    settings: <SettingsPage ws={ws} />,
    history: <HistoryPage ws={ws} names={names} onOpen={open} target={target} />,
    confirm: <ConfirmRequest confirmations={ws.confirmations} names={names} />,
  };

  return (
    <SecretResetProvider value={resets}>
      <div ref={rootRef} className="flex h-dvh flex-col bg-background" data-testid="fiber-wallet" data-page={page}>
        {!framed && <WalletTitleBar status={status} />}
        {page !== "home" && (
          <div className={pageBar} data-testid="fiber-wallet-page-bar">
            <button type="button" onClick={back} className={backButton} data-testid="fiber-wallet-back">
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              {WALLET_CHROME.BACK}
            </button>
            <h2 ref={headingRef} tabIndex={-1} className="font-display text-xl leading-none focus:outline-none" data-testid="fiber-wallet-page-title">
              {WALLET_PAGE_TITLE[page]}
            </h2>
          </div>
        )}
        <main className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
          {WALLET_PAGES.map((id) => (
            <div key={id} hidden={id !== page} data-testid={`fiber-wallet-page-${id}`}>
              {id === "home" && (
                <h2 ref={homeHeadingRef} tabIndex={-1} className="sr-only">
                  {WALLET_PAGE_TITLE.home}
                </h2>
              )}
              {!running && PAGES_NEEDING_NODE.includes(id) ? (
                <StatusNotice tone="off" data-testid="fiber-wallet-needs-node">
                  {WALLET_CHROME.NEEDS_NODE}
                </StatusNotice>
              ) : (
                pages[id]
              )}
            </div>
          ))}
        </main>
      </div>
    </SecretResetProvider>
  );
}
