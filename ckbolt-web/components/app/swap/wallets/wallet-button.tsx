"use client";

import { Globe, Server, Wallet } from "lucide-react";
import type { FiberWalletKind, WalletButtonProps } from "../contracts";
import { fiberChipView } from "./chip-view";
import { WALLET_ACTION, WALLET_CONNECT_CHIP, WALLET_TITLE, WALLET_TONE_LABEL } from "./copy";
import { useFiberWallet, useWalletDialogs } from "./fiber-wallet-provider";
import { WalletStatusDot } from "./status-dot";
import { walletChip } from "./styles";

const FIBER_KIND_ICON: Readonly<Record<FiberWalletKind, typeof Globe>> = { "browser-node": Globe, "own-node": Server };

/**
 * The Fiber node's chip on the Fiber side of the swap card: "Connect Fiber" until a node is chosen, then its icon, short
 * name and status dot. It opens the node's dialog, where the details and Disconnect are.
 */
export function WalletButton({ disabled = false, attention = false }: WalletButtonProps) {
  const view = fiberChipView(useFiberWallet(), attention);
  const { open, openWalletDialog } = useWalletDialogs();
  const label = view.connected ? `${WALLET_TITLE}: ${view.name}, ${WALLET_TONE_LABEL[view.tone]}` : `${WALLET_ACTION.CONNECT} ${WALLET_TITLE}`;
  const Icon = view.connected && view.fiberKind ? FIBER_KIND_ICON[view.fiberKind] : Wallet;
  return (
    <button
      type="button"
      className={walletChip}
      onClick={openWalletDialog}
      disabled={disabled}
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={open}
      data-testid="wallet-button-fiber"
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="truncate">{view.connected ? view.name : WALLET_CONNECT_CHIP}</span>
      <WalletStatusDot tone={view.connected ? view.tone : null} />
    </button>
  );
}
