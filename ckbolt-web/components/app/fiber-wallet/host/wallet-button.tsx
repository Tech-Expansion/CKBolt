"use client";

import { cn } from "@/lib/utils";
import { walletButtonView, WALLET_BUTTON_COPY } from "@/lib/wallets/fiber-popup/button-view";
import { StatusDot } from "../../status";
import { walletButton, walletButtonRunning } from "../styles";
import { useWalletHost, WALLET_POPOVER_ID } from "./wallet-host";

/**
 * The header's Fiber node button: a status dot and a short label ("Fiber node", "Locked", or the CKB a swap can send),
 * from the node's last status. It opens and closes the popover; nothing renders outside the wallet host.
 */
export function FiberWalletButton({ className, onOpen }: { className?: string; onOpen?: () => void }) {
  const host = useWalletHost();
  if (!host) return null;
  const view = walletButtonView(host.status, host.health);
  const name = `${WALLET_BUTTON_COPY.NAME}: ${view.state}`;
  return (
    <button
      ref={host.buttonRef}
      type="button"
      onClick={() => {
        if (!host.open) onOpen?.();
        host.toggle();
      }}
      aria-haspopup="dialog"
      aria-expanded={host.open}
      aria-controls={host.mounted ? WALLET_POPOVER_ID : undefined}
      aria-label={name}
      title={name}
      className={cn(walletButton, view.tone === "ok" && walletButtonRunning, className)}
      data-testid="fiber-wallet-button"
    >
      <StatusDot tone={view.tone} />
      <span className="truncate">{view.label}</span>
    </button>
  );
}
