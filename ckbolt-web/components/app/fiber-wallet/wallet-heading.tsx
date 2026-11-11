import type { StatusTone } from "@/lib/status-tone";
import { StatusBadge } from "../status";
import { WALLET_CHROME } from "./copy";

/** The wallet's state beside its title ("Running", "Locked"...), in its colour, with its dot. */
export function WalletStateBadge({ state }: { state: { label: string; tone: StatusTone } | null }) {
  if (!state) return null;
  return (
    <StatusBadge tone={state.tone} dot data-testid="fiber-wallet-state">
      {state.label}
    </StatusBadge>
  );
}

/** Testnet, in the caution colour: the wallet moves test money only. */
export function TestnetBadge() {
  return <StatusBadge tone="pending">{WALLET_CHROME.TAG}</StatusBadge>;
}
