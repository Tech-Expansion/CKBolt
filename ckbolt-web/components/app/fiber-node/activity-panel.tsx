"use client";

import type { SwapRecord } from "@/lib/swap/history";
import { APP_PAGE_PATH } from "@/lib/wallets/fiber-browser/constants";
import type { HistoryItem } from "@/lib/wallets/fiber-browser/history";
import { StatusBadge, StatusNotice } from "../status";
import { InfoTip } from "../swap/info-tip";
import { Panel } from "../ui";
import { ACTIVITY_COPY } from "./copy";
import { HistoryList, type HistoryNames } from "./history-list";
import { pillButton } from "./styles";

interface ActivityPanelProps {
  items: HistoryItem[];
  onKeepSwap: (record: SwapRecord) => void;
  /** The tab answers the swap form (its node runs). */
  serving: boolean;
  busy: boolean;
  names: HistoryNames;
}

/** A busy node says so: it is still needed to finish a payment. */
export function KeepOpenNotice({ busy }: { busy: boolean }) {
  if (!busy) return null;
  return (
    <StatusNotice tone="pending" role="status" data-testid="fiber-node-keep-open">
      {ACTIVITY_COPY.KEEP_OPEN}
    </StatusNotice>
  );
}

/** Panel 05: the node's History, the same as in the popup. */
export function ActivityPanel({ items, onKeepSwap, serving, busy, names }: ActivityPanelProps) {
  return (
    <Panel
      step="05"
      title={ACTIVITY_COPY.TITLE}
      aside={
        <StatusBadge tone={serving ? "ok" : "off"} dot>
          {serving ? ACTIVITY_COPY.LISTENING : ACTIVITY_COPY.NOT_RUNNING}
        </StatusBadge>
      }
    >
      <div className="space-y-4" data-testid="fiber-node-activity">
        <p className="text-sm text-muted-foreground leading-relaxed">
          {ACTIVITY_COPY.LEAD}{" "}
          <InfoTip label={ACTIVITY_COPY.TIP_LABEL} align="start">
            {ACTIVITY_COPY.TIP}
          </InfoTip>
        </p>
        <KeepOpenNotice busy={busy} />
        <HistoryList items={items} names={names} filterable grouped testId="fiber-node-activity-list" onKeepSwap={onKeepSwap} />
        <a href={APP_PAGE_PATH} target="_blank" rel="noopener" className={pillButton}>
          {ACTIVITY_COPY.OPEN_APP}
        </a>
      </div>
    </Panel>
  );
}
