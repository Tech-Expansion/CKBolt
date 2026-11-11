"use client";

import type { WalletPage } from "@/lib/wallets/fiber-popup/constants";
import { KeepOpenNotice } from "../fiber-node/activity-panel";
import { HISTORY_TIP } from "../fiber-node/copy";
import { HistoryList, type HistoryNames, type HistoryTarget } from "../fiber-node/history-list";
import { pillButton } from "../fiber-node/styles";
import type { NodeWorkspace } from "../fiber-node/use-node-workspace";
import { InfoTip } from "../swap/info-tip";
import { HISTORY_PAGE_COPY, WALLET_PAGE_TITLE } from "./copy";

/** Pages the empty History offers: a channel from the hub is the first step, funds before it. */
const FIRST_STEPS: readonly WalletPage[] = ["channels", "add-funds"];

/**
 * History: everything that moved money through the node, newest first by day, with a filter (all, payments, swaps,
 * channels, funds); each entry opens to its detail. `target` opens one entry (the app's "View in History").
 */
export function HistoryPage({
  ws,
  names,
  onOpen,
  target,
}: {
  ws: NodeWorkspace;
  names: HistoryNames;
  onOpen: (page: WalletPage) => void;
  target: HistoryTarget | null;
}) {
  const empty = (
    <div className="space-y-3" data-testid="fiber-wallet-history-empty">
      <p className="text-sm text-muted-foreground">{HISTORY_PAGE_COPY.EMPTY}</p>
      <div className="flex flex-wrap gap-3">
        {FIRST_STEPS.map((page) => (
          <button key={page} type="button" onClick={() => onOpen(page)} className={pillButton} data-testid={`fiber-wallet-history-${page}`}>
            {WALLET_PAGE_TITLE[page]}
          </button>
        ))}
      </div>
    </div>
  );
  return (
    <div className="space-y-4" data-testid="fiber-wallet-history">
      <p className="flex items-center gap-1 text-sm text-muted-foreground">
        {HISTORY_PAGE_COPY.LEAD}
        <InfoTip label={HISTORY_PAGE_COPY.TIP_LABEL} align="start">
          {HISTORY_TIP}
        </InfoTip>
      </p>
      <KeepOpenNotice busy={ws.activity.busy} />
      <HistoryList
        items={ws.activity.items}
        names={names}
        filterable
        grouped
        empty={empty}
        testId="fiber-wallet-history-list"
        target={target}
        onKeepSwap={ws.activity.keepSwap}
      />
    </div>
  );
}
