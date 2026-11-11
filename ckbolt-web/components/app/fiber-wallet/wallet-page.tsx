"use client";

import { useEffect, useMemo, useState } from "react";
import { readBrowserNodeConfig, type BrowserNodeConfig } from "@/lib/wallets/fiber-browser/config";
import { canRunNode, checkIsolation } from "@/lib/wallets/fiber-browser/isolation";
import { fiberWalletWindowHref } from "@/lib/wallets/fiber-browser/links";
import { WALLET_CHROME } from "./copy";
import { IsolationNotice } from "../fiber-node/isolation-notice";
import { useNodeWorkspace } from "../fiber-node/use-node-workspace";
import { WalletPickerProvider } from "../fiber-node/wallet-picker";
import { WalletFallback } from "./wallet-fallback";
import { WalletShell, WalletTitleBar } from "./wallet-shell";
import { isFramed } from "./use-parent-relay";

/** Where the wallet's document was loaded: /app/wallet is the popover's frame, /app/fiber?view=wallet its window. */
export type WalletView = "frame" | "window";

/**
 * The wallet's document: in the header's popover (an iframe of /app/wallet) or in a window of its own. It runs the node
 * when the document is cross-origin isolated; otherwise the popover offers the wallet in a window, and a window says
 * what is missing. A fresh document each time, so no reload for isolation is needed here. /app/wallet opened on its
 * own goes to the window instead: that route is made for a frame and sends no COOP.
 */
export function FiberWalletPage({ view }: { view: WalletView }) {
  const config = useMemo(readBrowserNodeConfig, []);
  const [report] = useState(checkIsolation);
  const [framed] = useState(isFramed);
  if (view === "frame" && !framed) return <ToWalletWindow />;
  if (canRunNode(report)) return <WalletRunner config={config} framed={framed} />;
  if (framed) return <WalletFallback />;
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <WalletTitleBar />
      <main className="p-4" data-testid="fiber-wallet-unavailable">
        <IsolationNotice report={report} />
      </main>
    </div>
  );
}

/** Replaces this page with the wallet's window, which is isolated with COOP and COEP like any page of its own. */
function ToWalletWindow() {
  useEffect(() => window.location.replace(fiberWalletWindowHref()), []);
  return (
    <p className="p-4 text-sm text-muted-foreground" role="status" data-testid="fiber-wallet-to-window">
      {WALLET_CHROME.OPENING_WINDOW}
    </p>
  );
}

function WalletRunner({ config, framed }: { config: BrowserNodeConfig; framed: boolean }) {
  const ws = useNodeWorkspace(config);
  return (
    // The visitor's CKB wallet, as a source of their address for a close or a withdrawal (never a signer here).
    <WalletPickerProvider rpcUrl={config.ckbRpcUrl} network={config.network}>
      <WalletShell ws={ws} framed={framed} />
    </WalletPickerProvider>
  );
}
