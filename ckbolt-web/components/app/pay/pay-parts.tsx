"use client";

import type { ReactNode } from "react";
import type { BridgeClient } from "@/lib/wallets/fiber-browser/bridge-client";
import type { NodePresence } from "@/lib/wallets/fiber-browser/bridge-protocol";
import { PAY_COPY } from "@/lib/pay/copy";
import type { ShortError } from "@/lib/swap/errors";
import type { WalletPage } from "@/lib/wallets/fiber-popup/constants";
import type { FiberWalletApi } from "../swap/contracts";
import { popupRunsNode, useWalletHost, type WalletHost } from "../fiber-wallet/host/wallet-host";
import { textButton } from "../fiber-node/styles";
import { StatusNotice } from "../status";
import { ErrorLine } from "../swap/primary-button";
import { secondaryButton } from "../ui";

/** What each of Pay's flows (a Lightning invoice, a Fiber invoice, a CKB address) gets from the panel. */
export interface PayFlowProps {
  /** The browser node as the swap card sees it (always the browser node here). */
  fiber: FiberWalletApi;
  /** The node tab's last answer, or null. */
  presence: NodePresence | null;
  /** The bridge to the node tab, for Pay's own requests. */
  client: BridgeClient;
  nowMs: number;
  /** The flow started a payment (the field locks) or ended it. */
  onLock: (locked: boolean) => void;
  /** "New payment": clear the field. */
  onDone: () => void;
}

/** Pay's full-width button: what it pays, or why it cannot yet. */
export function PayButton({ label, disabled, onPress }: { label: string; disabled: boolean; onPress: () => void }) {
  return (
    <button
      type="button"
      onClick={onPress}
      disabled={disabled}
      className="h-14 w-full rounded-full bg-foreground px-6 text-base font-medium text-background hover:bg-foreground/90 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2"
      data-testid="pay-confirm"
    >
      {label}
    </button>
  );
}

/** Pay's one error line, its full reason behind a "?". Always in the page, so a new line is announced. */
export function PayError({ error }: { error: ShortError | null }) {
  return <div aria-live="polite">{error && <ErrorLine error={error} label={PAY_COPY.DETAIL_LABEL} testId="pay-error" className="mt-3" />}</div>;
}

/** Opens the header's Fiber node on `page` (in a browser without DIP, the popover offers the node's window). */
export function OpenNodeButton({ page, children, testId }: { page: WalletPage; children: ReactNode; testId: string }) {
  const host = useWalletHost();
  if (!host) return null;
  return (
    <button type="button" onClick={() => host.show(page)} className={textButton} data-testid={testId}>
      {children}
    </button>
  );
}

/** Pay (or Get paid) needs the browser node running: one line, and a button that opens it. */
export function NodeNeeded({
  page = "home",
  line = PAY_COPY.NEEDS_NODE,
  testIds = { notice: "pay-needs-node", button: "pay-open-node" },
}: {
  page?: WalletPage;
  line?: string;
  testIds?: { notice: string; button: string };
}) {
  return (
    <StatusNotice tone="off" role="status" data-testid={testIds.notice}>
      <div className="flex flex-wrap items-center justify-between gap-x-3">
        <p>{line}</p>
        <OpenNodeButton page={page} testId={testIds.button}>
          {PAY_COPY.OPEN_NODE}
        </OpenNodeButton>
      </div>
    </StatusNotice>
  );
}

/** Opens the header's popup on Confirm when it runs the node (a node window or the node page shows it by itself). */
export function showConfirm(host: WalletHost | null): void {
  if (popupRunsNode(host)) host.show("confirm");
}

/** The node waits for the visitor's Confirm on its own page: one line, and a way to show it in the popup. */
export function ConfirmInNode({ password = false }: { password?: boolean }) {
  const host = useWalletHost();
  return (
    <StatusNotice tone="pending" role="status" data-testid="pay-waiting">
      <div className="flex flex-wrap items-center justify-between gap-x-3">
        <p>{password ? PAY_COPY.CONFIRM_IN_NODE_PASSWORD : PAY_COPY.CONFIRM_IN_NODE}</p>
        {popupRunsNode(host) && (
          <OpenNodeButton page="confirm" testId="pay-show-node">
            {PAY_COPY.SHOW_NODE}
          </OpenNodeButton>
        )}
      </div>
    </StatusNotice>
  );
}

/** "New payment", once a payment ended. */
export function NewPaymentButton({ onPress }: { onPress: () => void }) {
  return (
    <button type="button" onClick={onPress} className={secondaryButton} data-testid="pay-new">
      {PAY_COPY.NEW_PAYMENT}
    </button>
  );
}

/** The node tab runs the node now. */
export const nodeRunning = (presence: NodePresence | null): boolean => presence?.phase === "running";
