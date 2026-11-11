"use client";

import { Globe, Server } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useWalletHost } from "../../fiber-wallet/host/wallet-host";
import { assetPhrase } from "@/lib/hub/assets";
import type { AssetDto } from "@/lib/hub/contract";
import { FIBER_NODE_LINKS } from "@/lib/wallets/fiber-byo/constants";
import { FIBER_WALLET_KINDS, FIBER_WALLET_LABEL } from "@/lib/wallets/fiber-wallet/constants";
import type { BrowserNodeView } from "@/lib/wallets/fiber-wallet/state";
import type { FiberWalletApi, FiberWalletKind } from "../contracts";
import { InfoTip } from "../info-tip";
import { onRadioGroupKeyDown } from "../../ui";
import { BrowserNodeDetails } from "./browser-node-details";
import { FIBER_COPY, WALLET_ACTION, WALLET_ASSETS, WALLET_TITLE } from "./copy";
import { inlineLink, monoLabel, optionCard, pillButton } from "./styles";

interface FiberWalletPanelProps {
  wallet: FiberWalletApi;
  node: { view: BrowserNodeView; check: () => Promise<void> };
  /** The hub's assets, for symbols and decimals of the node's liquidity. */
  assets: readonly AssetDto[];
  /** Closes the dialog (before the header's Fiber node opens). */
  onLeave?: () => void;
}

/**
 * The Fiber wallet dialog: choose the browser node (driven over the bridge) or your own node (by hand). Choosing one
 * connects it; Disconnect forgets the choice.
 */
export function FiberWalletDialog({ open, onOpenChange, ...panel }: FiberWalletPanelProps & { open: boolean; onOpenChange: (open: boolean) => void }) {
  const host = useWalletHost();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={WALLET_TITLE}
        description={WALLET_ASSETS(assetPhrase(panel.assets.map((a) => a.symbol)))}
        // Leaving for the header's Fiber node: focus goes into it, not back to the wallet chip.
        onCloseAutoFocus={(event) => host?.open && event.preventDefault()}
        data-testid="wallet-dialog-fiber"
      >
        <FiberWalletPanel {...panel} onLeave={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

/** The dialog's body: the two choices, the browser node's details when it is chosen, and Disconnect. */
export function FiberWalletPanel({ wallet, node, assets, onLeave }: FiberWalletPanelProps) {
  // Roving focus: the chosen option, or the first one when nothing is chosen.
  const focusable = wallet.kind ?? FIBER_WALLET_KINDS[0];
  return (
    <div className="space-y-4">
      <div role="radiogroup" aria-label={FIBER_COPY.CHOICE_LABEL} onKeyDown={onRadioGroupKeyDown} className="space-y-2">
        {FIBER_WALLET_KINDS.map((kind) => (
          <KindOption key={kind} kind={kind} checked={wallet.kind === kind} focusable={focusable === kind} onChoose={wallet.choose} />
        ))}
      </div>
      {wallet.kind === "browser-node" && <BrowserNodeDetails wallet={wallet} view={node.view} check={node.check} assets={assets} onLeave={onLeave} />}
      {wallet.kind && (
        <button type="button" className={pillButton} onClick={wallet.disconnect} data-testid="wallet-disconnect">
          {WALLET_ACTION.DISCONNECT}
        </button>
      )}
    </div>
  );
}

/** How each option reads: icon, one line, an optional mono note and an optional "?" (kept outside the radio button). */
const KIND_META: Readonly<Record<FiberWalletKind, { icon: typeof Globe; line: string; note?: string; tip?: boolean }>> = {
  "browser-node": { icon: Globe, line: FIBER_COPY.BROWSER_NODE_LINE },
  "own-node": { icon: Server, line: FIBER_COPY.OWN_NODE_LINE, note: FIBER_COPY.OWN_NODE_TOOLS, tip: true },
};

function KindOption({
  kind,
  checked,
  focusable,
  onChoose,
}: {
  kind: FiberWalletKind;
  checked: boolean;
  focusable: boolean;
  onChoose: (kind: FiberWalletKind) => void;
}) {
  const { icon: Icon, line, note, tip } = KIND_META[kind];
  return (
    <div className="relative">
      <button
        type="button"
        role="radio"
        aria-checked={checked}
        tabIndex={focusable ? 0 : -1}
        onClick={() => onChoose(kind)}
        className={`${optionCard} ${tip ? "pr-12" : ""}`}
        data-testid={`fiber-option-${kind}`}
      >
        <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-foreground/40" aria-hidden="true">
          {checked && <span className="h-2 w-2 rounded-full bg-foreground" />}
        </span>
        <span className="min-w-0 space-y-1">
          <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
            <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
            {FIBER_WALLET_LABEL[kind]}
            {note && <span className={monoLabel}>{note}</span>}
          </span>
          <span className="block text-sm text-muted-foreground">{line}</span>
        </span>
      </button>
      {tip && (
        <div className="absolute right-3 top-3">
          <OwnNodeTip />
        </div>
      )}
    </div>
  );
}

function OwnNodeTip() {
  return (
    <InfoTip label={FIBER_COPY.OWN_NODE_TIP_LABEL} align="end">
      <span className="block space-y-2">
        {FIBER_COPY.OWN_NODE_TIP.map((line) => (
          <span key={line} className="block">
            {line}
          </span>
        ))}
        <a href={FIBER_NODE_LINKS.FIBER_STUDIO} target="_blank" rel="noopener noreferrer" className={`block ${inlineLink}`}>
          {FIBER_COPY.GET_FIBER_STUDIO}
          <span className="sr-only"> {WALLET_ACTION.NEW_TAB}</span>
        </a>
      </span>
    </InfoTip>
  );
}
