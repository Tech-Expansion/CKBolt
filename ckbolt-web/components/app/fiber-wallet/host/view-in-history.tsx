"use client";

import { History } from "lucide-react";
import type { EntryRef } from "@/lib/wallets/fiber-browser/history";
import { cn } from "@/lib/utils";
import { textButton } from "../../fiber-node/styles";
import { WALLET_CHROME } from "../copy";
import { popupRunsNode, useWalletHost } from "./wallet-host";

/**
 * "View in History": opens the header's Fiber node on History, open on `entry` (a swap id or a hash). Shown only while
 * the header's popup runs the node; a node in a window of its own or on the node page cannot be steered from here, and
 * its History is one look away there. `onOpen` runs first (the swap card hides its dialog).
 */
export function ViewInHistory({ entry, onOpen, className }: { entry: EntryRef; onOpen?: () => void; className?: string }) {
  const host = useWalletHost();
  if (!popupRunsNode(host)) return null;
  return (
    <button
      type="button"
      onClick={() => {
        onOpen?.();
        host.showEntry(entry);
      }}
      className={cn(textButton, "inline-flex items-center gap-1.5", className)}
      data-testid="history-entry-view"
    >
      <History className="h-4 w-4" aria-hidden="true" />
      {WALLET_CHROME.VIEW_IN_HISTORY}
    </button>
  );
}
