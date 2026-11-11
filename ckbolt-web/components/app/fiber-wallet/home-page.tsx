"use client";

import { useId, type ReactNode } from "react";
import { ArrowDownToLine, ArrowUpFromLine, Settings, Waypoints, type LucideIcon } from "lucide-react";
import { formatUnits } from "@/lib/hub/format";
import type { StatusTone } from "@/lib/status-tone";
import { CKB_DECIMALS, RECENT_HISTORY_ENTRIES } from "@/lib/wallets/fiber-browser/constants";
import type { WalletPage } from "@/lib/wallets/fiber-popup/constants";
import { liquidityRows } from "@/lib/wallets/fiber-wallet/liquidity";
import { KeepOpenNotice } from "../fiber-node/activity-panel";
import { HistoryList, type HistoryNames } from "../fiber-node/history-list";
import { CreateKeyForm, KeyError, UnlockKeyForm, UnreadableKeyNotice } from "../fiber-node/key-forms";
import { LiquidityTable } from "../fiber-node/liquidity-table";
import { NodeStatusNotice } from "../fiber-node/node-status-notice";
import { pillButton, textButton } from "../fiber-node/styles";
import type { NodeWorkspace } from "../fiber-node/use-node-workspace";
import { StatusBadge, StatusNotice } from "../status";
import { InfoTip } from "../swap/info-tip";
import { CONFIRM_COPY } from "../fiber-node/copy";
import { HOME_ACTIONS, HOME_COPY, WALLET_CHROME, WALLET_PAGE_TITLE } from "./copy";
import { homeAction, monoLabel, sectionTitle } from "./styles";

/** Each page's icon on Home's buttons. */
const PAGE_ICON: Readonly<Partial<Record<WalletPage, LucideIcon>>> = {
  "add-funds": ArrowDownToLine,
  channels: Waypoints,
  withdraw: ArrowUpFromLine,
  settings: Settings,
};

interface HomePageProps {
  ws: NodeWorkspace;
  names: HistoryNames;
  /** Opens a page from one of Home's buttons, which gets the focus back on Back (data-opens names the page). */
  onOpen: (page: WalletPage) => void;
}

/** A button of Home that opens a page; `data-opens` lets the shell find it again when focus returns. */
export function OpenPageButton({ page, onOpen, className, children }: { page: WalletPage; onOpen: (page: WalletPage) => void; className: string; children: ReactNode }) {
  return (
    <button type="button" onClick={() => onOpen(page)} className={className} data-opens={page} data-testid={`fiber-wallet-open-${page}`}>
      {children}
    </button>
  );
}

/** The popup's first screen: create or unlock the node; once it runs, what it can swap, its CKB, the hub, its pages, its History. */
export function HomePage({ ws, names, onOpen }: HomePageProps) {
  const { state, nodeKey } = ws;
  const errorId = useId();
  if (state.phase !== "running") {
    return (
      <div className="space-y-5" data-testid="fiber-wallet-home">
        <p className="flex items-center gap-1 text-sm text-muted-foreground">
          {HOME_COPY.LEAD}
          <InfoTip label={HOME_COPY.TIP_LABEL} align="start">
            {HOME_COPY.TIP}
          </InfoTip>
        </p>
        <UnreadableKeyNotice nodeKey={nodeKey} />
        <NodeStatusNotice state={state} otherTabHolds={ws.otherTabHolds} showLocked={false} />
        {!nodeKey.record && <CreateKeyForm nodeKey={nodeKey} onKeys={ws.start} errorId={errorId} />}
        {nodeKey.record && state.phase !== "starting" && <UnlockKeyForm nodeKey={nodeKey} onKeys={ws.start} errorId={errorId} />}
        <KeyError nodeKey={nodeKey} id={errorId} />
        {/* Restore and forget live in Settings, which works while the node is locked. */}
        <OpenPageButton page="settings" onOpen={onOpen} className={textButton}>
          {WALLET_PAGE_TITLE.settings}
        </OpenPageButton>
      </div>
    );
  }
  return <RunningHome ws={ws} names={names} onOpen={onOpen} />;
}

function RunningHome({ ws, names, onOpen }: HomePageProps) {
  const { state, data, link, hub, hubNode, activity } = ws;
  const readyId = useId();
  const historyId = useId();
  const rows = liquidityRows(
    Object.fromEntries(Object.entries(ws.liquidity).flatMap(([id, l]) => (l ? [[id, { send: l.send.toString(), receive: l.receive.toString() }]] : []))),
    ws.tokens,
  );
  const hasChannel = rows.some((row) => row.send !== "0" || row.receive !== "0");
  const hubState: { label: string; tone: StatusTone } = !hubNode
    ? { label: HOME_COPY.HUB_UNAVAILABLE, tone: "error" }
    : link.connected
      ? { label: HOME_COPY.HUB_CONNECTED, tone: "ok" }
      : link.dialing
        ? { label: HOME_COPY.HUB_CONNECTING, tone: "pending" }
        : { label: HOME_COPY.HUB_NOT_CONNECTED, tone: "off" };

  return (
    <div className="space-y-6" data-testid="fiber-wallet-home">
      {ws.confirmations.pending && (
        <StatusNotice tone="pending" role="status" data-testid="fiber-wallet-confirm-waiting">
          <div className="flex flex-wrap items-center justify-between gap-x-3">
            <p>{CONFIRM_COPY.WAITING}</p>
            <OpenPageButton page="confirm" onOpen={onOpen} className={textButton}>
              {CONFIRM_COPY.REVIEW}
            </OpenPageButton>
          </div>
        </StatusNotice>
      )}
      <section className="space-y-1" aria-labelledby={readyId} data-testid="fiber-wallet-ready">
        <h3 id={readyId} className={`flex items-center gap-1 ${sectionTitle}`}>
          {HOME_COPY.READY}
          <InfoTip label={HOME_COPY.READY_TIP_LABEL} align="start">
            {HOME_COPY.READY_TIP}
          </InfoTip>
        </h3>
        <LiquidityTable rows={rows} testId="fiber-wallet-liquidity" />
        {!hasChannel && <p className="text-xs text-muted-foreground">{HOME_COPY.NO_CHANNELS}</p>}
      </section>

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-2 text-sm">
        <dt className={monoLabel}>{HOME_COPY.ON_CHAIN}</dt>
        <dd className="font-mono tabular-nums [overflow-wrap:anywhere]" data-testid="fiber-wallet-balance">
          {data.balance === null ? "…" : formatUnits(data.balance.toString(), CKB_DECIMALS)} CKB
        </dd>
        <dt className={monoLabel}>{HOME_COPY.HUB}</dt>
        <dd className="flex flex-wrap items-center justify-between gap-2" data-testid="fiber-wallet-hub">
          <StatusBadge tone={hubState.tone} dot>
            {hubState.label}
          </StatusBadge>
          {hubNode && !link.connected && (
            <button type="button" onClick={() => void link.dial()} disabled={link.dialing} className={pillButton}>
              {HOME_COPY.CONNECT}
            </button>
          )}
          {!hubNode && hub.error && (
            <button type="button" onClick={() => void hub.reload()} className={textButton}>
              {HOME_COPY.CONNECT}
            </button>
          )}
        </dd>
      </dl>
      {link.error && !link.connected && <StatusNotice tone="error">{link.error}</StatusNotice>}
      <NodeStatusNotice state={state} otherTabHolds={false} />

      <nav aria-label={WALLET_CHROME.ACTIONS_LABEL}>
        <ul className="grid grid-cols-2 gap-2">
          {HOME_ACTIONS.map((page) => {
            const Icon = PAGE_ICON[page];
            return (
              <li key={page}>
                <OpenPageButton page={page} onOpen={onOpen} className={homeAction}>
                  {Icon && <Icon className="h-5 w-5" aria-hidden="true" />}
                  {WALLET_PAGE_TITLE[page]}
                </OpenPageButton>
              </li>
            );
          })}
        </ul>
      </nav>

      <section className="space-y-2" aria-labelledby={historyId}>
        <div className="flex items-center justify-between gap-3">
          <h3 id={historyId} className={sectionTitle}>
            {HOME_COPY.HISTORY}
          </h3>
          <OpenPageButton page="history" onOpen={onOpen} className={textButton}>
            {HOME_COPY.VIEW_ALL}
          </OpenPageButton>
        </div>
        <KeepOpenNotice busy={activity.busy} />
        <HistoryList items={activity.items} names={names} limit={RECENT_HISTORY_ENTRIES} testId="fiber-wallet-recent" onKeepSwap={activity.keepSwap} />
      </section>
    </div>
  );
}
