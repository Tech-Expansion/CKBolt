"use client";

import { useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { CKB_ASSET } from "@/lib/wallets/fiber-browser/channels";
import { fiberWalletWindowHref } from "@/lib/wallets/fiber-browser/links";
import { FIBER_WALLET_WINDOW } from "@/lib/wallets/fiber-popup/constants";
import type { WalletRelayStatus } from "@/lib/wallets/fiber-popup/relay";
import { readLiquidity } from "@/lib/wallets/fiber-wallet/liquidity";
import { useFiberBrowserBridge } from "../fiber-node/use-fiber-browser-bridge";
import { StatusNotice } from "../status";
import { InfoTip } from "../swap/info-tip";
import { primaryButton } from "../ui";
import { FALLBACK_COPY } from "./copy";
import { useParentRelay } from "./use-parent-relay";

const WINDOW_FEATURES = `popup,width=${FIBER_WALLET_WINDOW.WIDTH_PX},height=${FIBER_WALLET_WINDOW.HEIGHT_PX}`;

/**
 * Inside the popover of a browser without Document-Isolation-Policy (Firefox, Safari): the iframe cannot run the node,
 * so it offers the wallet in a window, the node page isolated with COOP/COEP in the wallet's layout. It still tells the
 * header what that window's node does, as the window answers on the same-origin bridge.
 */
export function WalletFallback() {
  const bridge = useFiberBrowserBridge(true);
  const [blocked, setBlocked] = useState(false);
  const presence = bridge.presence;
  const status: WalletRelayStatus = {
    isolated: false,
    phase: presence?.phase ?? null,
    hasKey: presence !== null,
    sendCkb: presence?.phase === "running" ? (readLiquidity(presence.liquidity)[CKB_ASSET]?.send ?? "0") : null,
  };
  useParentRelay(status);

  const open = () => {
    // A window of the node page: it is isolated on its own, and no popup of this page can be (no COOP here).
    const opened = window.open(fiberWalletWindowHref(), FIBER_WALLET_WINDOW.NAME, WINDOW_FEATURES);
    setBlocked(opened === null);
  };

  return (
    <main className="flex h-dvh flex-col justify-center gap-5 bg-background px-6" data-testid="fiber-wallet-fallback">
      <h2 className="font-display text-2xl leading-tight">{FALLBACK_COPY.TITLE}</h2>
      <p className="flex items-center gap-1 text-sm text-muted-foreground">
        {FALLBACK_COPY.LEAD}
        <InfoTip label={FALLBACK_COPY.TIP_LABEL} align="start">
          {FALLBACK_COPY.TIP}
        </InfoTip>
      </p>
      {presence?.phase === "running" && (
        <StatusNotice tone="ok" role="status">
          {FALLBACK_COPY.RUNNING}
        </StatusNotice>
      )}
      <button type="button" onClick={open} className={cn(primaryButton, "inline-flex items-center justify-center gap-2")} data-testid="fiber-wallet-open-window">
        {FALLBACK_COPY.OPEN}
        <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
        <span className="sr-only">{FALLBACK_COPY.NEW_WINDOW}</span>
      </button>
      {blocked && (
        <StatusNotice tone="error" role="alert">
          {FALLBACK_COPY.BLOCKED}
        </StatusNotice>
      )}
    </main>
  );
}
