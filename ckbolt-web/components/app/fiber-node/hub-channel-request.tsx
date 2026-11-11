"use client";

import { useEffect, useId, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { localeDecimalMark } from "@/lib/amount";
import type { FiberAssetId, FiberNodeDto, Script } from "@/lib/hub/contract";
import { formatUnits } from "@/lib/hub/format";
import type { TokenLook } from "@/lib/token-display";
import { ckbNeededToAccept, parseContribution } from "@/lib/wallets/fiber-browser/channel-contribution";
import { CKB_ASSET } from "@/lib/wallets/fiber-browser/channels";
import { CHANNEL_RESERVE_CKB, HUB_RUN_TIMING, MIN_CHANNEL_CONTRIBUTION_CKB } from "@/lib/wallets/fiber-browser/constants";
import {
  hubRows,
  hubRowTone,
  hubRowView,
  hubRunSummary,
  hubRunSummaryTone,
  maxContribution,
  offersFundingChoice,
  rowFunding,
  runHubRequests,
  runRowRequest,
  selectionNeeds,
  waitForFunding,
  type HubRow,
  type HubRowFunding,
  type HubRowView,
  type HubRunProgress,
  type HubRunRow,
  type HubRunSummary,
} from "@/lib/wallets/fiber-browser/hub-channel-rows";
import type { BrowserFiberNode, NodeChannel } from "@/lib/wallets/fiber-browser/node-port";
import { checkOwnAmount, maxOwnAmount, ownAmountText, ownChannelPlan, OWN_TOKEN_MESSAGE, type OwnAmountCheck, type OwnTokenOffer } from "@/lib/wallets/fiber-browser/own-token-channel";
import type { PeerChannelPlan } from "@/lib/wallets/fiber-browser/peer-channel";
import { StatusBadge, StatusNotice } from "../status";
import { InfoTip } from "../swap/info-tip";
import { TokenIcon } from "../token-icon";
import { primaryButton } from "../ui";
import { CHANNEL_ACTION } from "./channel-actions";
import { HUB_PANEL_COPY } from "./copy";
import { ChoiceGroup } from "./fields";
import { noteBox, textButton, textInput } from "./styles";
import type { NodeAction } from "./use-node-action";

export interface ChannelContribution {
  /** Whole CKB the visitor last chose (saved per network): the field's value when it shows. */
  chosen: number;
  onChange: (ckb: number) => void;
}

const formatCkb = (ckb: number): string => ckb.toLocaleString("en-US");
/** "RUSD and cWBTC": the tokens one line names. */
const assetList = new Intl.ListFormat("en-US", { type: "conjunction" });
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** A token channel's CKB reserve with the fee margin, as the total counts it. */
const TOKEN_RESERVE_CKB = (asset: FiberAssetId) => formatCkb(ckbNeededToAccept(asset, 0));

interface HubChannelRequestProps {
  /** The hub's Fiber node, on this node's network. */
  hubNode: FiberNodeDto;
  node: BrowserFiberNode | null;
  hubConnected: boolean;
  channels: NodeChannel[];
  /** Shannons the node can spend on-chain, or null until read. */
  balance: bigint | null;
  contribution: ChannelContribution;
  /** The view's one action at a time (useNodeAction): a run holds it, so nothing else starts on the node meanwhile. */
  action: Pick<NodeAction, "working" | "run">;
  decimalsOf: (asset: string) => number;
  symbolOf: (asset: string) => string;
  /** How a token looks: its name and icons, the hub's first (NodeWorkspace.lookOf, lib/token-display.ts). */
  lookOf: (asset: string) => TokenLook;
  /** Tokens the running node would not take the hub's channel in until it restarts (NodeWorkspace.restartFor). */
  restartFor?: readonly FiberAssetId[];
  /** Stops the node, so it restarts with the hub's whitelist once unlocked; `lockBusy` while a swap needs it. */
  onLock?: () => void;
  lockBusy?: boolean;
  /** Asks the hub for one channel in `asset` (requestHubChannel, recorded in History); `contributionText` is the CKB field. */
  request: (asset: FiberAssetId, contributionText: string) => Promise<unknown>;
  /**
   * Reads what the node holds of a token on chain (base units; ckb-rpc.ts tokenAmount at the node's lock), for a row the
   * node funds with its own tokens; null until the node's lock is known. Keep it stable (useCallback).
   */
  readTokenBalance: ((script: Script) => Promise<bigint>) | null;
  /** A WebSocket address of the hub to dial when the node is not its peer any more (the hub link's first), or null. */
  hubAddress: string | null;
  /** Opens a channel to the hub with the node's own tokens (openOwnTokenChannel, recorded in History). */
  openOwn: (plan: PeerChannelPlan) => Promise<unknown>;
  /** A run ended: read the hub again (what it can fund now). */
  onRunEnd: () => void;
}

/**
 * "Channel with the hub": one card, a row per asset the hub opens channels in (from GET /v1/fiber/node alone, CKB first),
 * each with where it stands. The visitor ticks rows, sets what the node puts into a CKB channel, sees what that needs on
 * chain, and opens them all with one button. The run asks the hub for one channel after another (each is its own channel
 * and funding transaction; the node accepts the CKB one with the amount typed), waits for each funding before the next,
 * and keeps going when a row fails (lib/wallets/fiber-browser/hub-channel-rows.ts). A token the hub lets nodes open
 * their own channel in (peerChannels) offers "Your own cWBTC" on its row: the node then opens that channel itself with
 * its on-chain tokens, and the hub is not asked for it (own-token-channel.ts).
 */
export function HubChannelRequest(props: HubChannelRequestProps) {
  const {
    hubNode,
    node,
    hubConnected,
    channels,
    balance,
    contribution,
    action,
    decimalsOf,
    symbolOf,
    lookOf,
    restartFor = [],
    onLock,
    lockBusy = false,
    request,
    readTokenBalance,
    hubAddress,
    openOwn,
    onRunEnd,
  } = props;
  const [text, setText] = useState(() => String(contribution.chosen));
  const [selected, setSelected] = useState<ReadonlySet<FiberAssetId>>(() => new Set());
  // Rows the visitor chose to fund with the node's own tokens, what was typed for each, and what the node holds of each.
  const [ownChosen, setOwnChosen] = useState<ReadonlySet<FiberAssetId>>(() => new Set());
  const [ownText, setOwnText] = useState<Partial<Record<FiberAssetId, string>>>({});
  const [ownBalances, setOwnBalances] = useState<Partial<Record<FiberAssetId, bigint | null>>>({});
  const [runs, setRuns] = useState(0);
  const [runRows, setRunRows] = useState<Partial<Record<FiberAssetId, HubRunRow>>>({});
  const [progress, setProgress] = useState<HubRunProgress | null>(null);
  const [summary, setSummary] = useState<HubRunSummary | null>(null);
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const stopRef = useRef(false);
  const alive = useRef(true);
  const nodeRef = useRef(node);
  useEffect(() => {
    nodeRef.current = node;
  }, [node]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const rows = hubRows(hubNode, channels, restartFor);
  const views = rows.map((row) => ({ row, ...hubRowView(row.state, runRows[row.asset]) }));
  const ready = node !== null && hubConnected;
  const fundingOf = (row: HubRow): HubRowFunding => rowFunding(row, ownChosen.has(row.asset));
  // A row ticked before it stopped being selectable (its channel showed, the hub cannot fund it now) no longer counts.
  const chosen = views.filter((v) => v.selectable && selected.has(v.row.asset)).map((v) => v.row.asset);
  // The ticked rows the node funds itself, each with its amount checked against the hub's minimum and the node's tokens.
  const ownChecks = rows
    .filter((row) => chosen.includes(row.asset) && row.own !== null && fundingOf(row) === "own")
    .map((row) => ({ asset: row.asset, check: ownCheckOf(row.asset, row.own!) }));
  const ownFailed = ownChecks.find((c) => !c.check.ok)?.check;
  const typed = parseContribution(text);
  const needs = selectionNeeds(chosen, typed ?? contribution.chosen, balance);
  const blocked = ready ? null : node ? HUB_PANEL_COPY.CONNECT_FIRST : HUB_PANEL_COPY.START_FIRST;
  const reason =
    blocked ??
    (running
      ? null
      : action.working !== null
        ? HUB_PANEL_COPY.BUSY
        : chosen.length === 0
          ? HUB_PANEL_COPY.CHOOSE
          : chosen.includes(CKB_ASSET) && typed === null
            ? HUB_PANEL_COPY.CONTRIBUTION_ERROR(formatCkb(MIN_CHANNEL_CONTRIBUTION_CKB))
            : ownFailed && !ownFailed.ok
              ? ownFailed.error
              : balance === null
                ? HUB_PANEL_COPY.NO_BALANCE
                : !needs.enough
                  ? HUB_PANEL_COPY.SHORT(formatCkb(needs.shortCkb))
                  : null);
  const ownSymbols = rows.filter((r) => r.own !== null).map((r) => symbolOf(r.asset));

  /**
   * What was typed for a row the node funds itself (the hub's minimum until the visitor types, written with the locale's
   * decimal mark so it reads back as written), checked.
   */
  function ownTextOf(asset: FiberAssetId, offer: OwnTokenOffer): string {
    return ownText[asset] ?? ownAmountText(offer.minAmount, decimalsOf(asset), localeDecimalMark());
  }
  function ownCheckOf(asset: FiberAssetId, offer: OwnTokenOffer): OwnAmountCheck {
    return checkOwnAmount({
      text: ownTextOf(asset, offer),
      decimals: decimalsOf(asset),
      symbol: symbolOf(asset),
      minAmount: offer.minAmount,
      balance: ownBalances[asset] ?? null,
      decimalMark: localeDecimalMark(),
    });
  }
  const restartSymbols = rows.filter((r) => r.state.kind === "restart").map((r) => symbolOf(r.asset));

  if (rows.length === 0) {
    return (
      <div className={noteBox}>
        <p className="text-sm font-medium">{HUB_PANEL_COPY.TITLE}</p>
        <p className="text-xs text-muted-foreground">{HUB_PANEL_COPY.NOT_OFFERED}</p>
      </div>
    );
  }

  const chooseFunding = (asset: FiberAssetId, funding: HubRowFunding) => {
    setOwnChosen((prev) => {
      const next = new Set(prev);
      if (funding === "own") next.add(asset);
      else next.delete(asset);
      return next;
    });
    // Choosing the node's own tokens is choosing to open it: the row is ticked.
    if (funding === "own") toggle(asset, true);
  };

  const toggle = (asset: FiberAssetId, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(asset);
      else next.delete(asset);
      return next;
    });
    // Ticked again after it failed: it rests until the next run.
    setRunRows((prev) => {
      if (!prev[asset]) return prev;
      const next = { ...prev };
      delete next[asset];
      return next;
    });
  };

  const start = () => {
    if (reason !== null || running || !node) return;
    const assets = chosen;
    const contributionText = text;
    const nodeAtStart = node;
    const hubAtStart = hubNode;
    // The rows the node funds itself, with their amounts as checked now; the hub is not asked for them.
    const own: Partial<Record<FiberAssetId, bigint>> = {};
    const offers: Partial<Record<FiberAssetId, OwnTokenOffer>> = {};
    for (const { asset, check } of ownChecks) if (check.ok) own[asset] = check.amount;
    for (const row of rows) if (row.own) offers[row.asset] = row.own;
    stopRef.current = false;
    const stopped = () => stopRef.current || !alive.current || nodeRef.current !== nodeAtStart;
    setRunRows({});
    setSummary(null);
    setStopping(false);
    setRunning(true);
    void action.run(CHANNEL_ACTION.HUB_RUN, async () => {
      try {
        const outcome = await runHubRequests(assets, {
          request: runRowRequest({
            own,
            askHub: (asset) => request(asset, contributionText),
            openOwn: (asset, amount) => openOwn(ownChannelPlan({ nodeId: hubAtStart.nodeId, address: hubAddress }, asset, offers[asset]!, amount)),
          }),
          // After a failed row only a pending funding is waited for: its channel may never show.
          waitForFunding: (asset, failed) =>
            waitForFunding(
              asset,
              { listChannels: () => nodeAtStart.listChannels(), hubNode: hubAtStart, sleep, now: Date.now, stopped },
              failed ? { ...HUB_RUN_TIMING, appearMs: 0 } : HUB_RUN_TIMING,
            ),
          onRow: (asset, row) => {
            if (!alive.current) return;
            setRunRows((prev) => {
              const next = { ...prev };
              if (row) next[asset] = row;
              else delete next[asset];
              return next;
            });
          },
          onProgress: (next) => {
            if (alive.current) setProgress(next);
          },
          stopped,
        });
        if (alive.current) {
          setSummary(hubRunSummary(outcome));
          setSelected(new Set());
        }
      } finally {
        if (alive.current) {
          setRunning(false);
          // The node's tokens moved into the channels it opened: read them again.
          setRuns((n) => n + 1);
        }
        onRunEnd();
      }
      // The card shows how the run went, row by row and in its summary.
      return null;
    });
  };

  const stop = () => {
    stopRef.current = true;
    setStopping(true);
  };

  return (
    <div className={noteBox} data-testid="fiber-node-hub-request">
      <p className="text-sm font-medium">
        {HUB_PANEL_COPY.TITLE}{" "}
        <InfoTip label={HUB_PANEL_COPY.TIP_LABEL} align="start">
          <span className="block space-y-2">
            {HUB_PANEL_COPY.TIP(CHANNEL_RESERVE_CKB.CKB, CHANNEL_RESERVE_CKB.UDT, ownSymbols).map((paragraph) => (
              <span key={paragraph} className="block">
                {paragraph}
              </span>
            ))}
          </span>
        </InfoTip>
      </p>
      <ul>
        {views.map(({ row, view, selectable }) => {
          const symbol = symbolOf(row.asset);
          const run = runRows[row.asset];
          const inRun = running && run !== undefined;
          const funding = fundingOf(row);
          // The row is still to be opened: its CKB field, its funding choice and its own tokens show.
          const toOpen = row.state.kind === "available" && view !== "done";
          const choice = toOpen && offersFundingChoice(row);
          // What putting in the node's own tokens changes: beside the choice, or after the line when there is none.
          const ownTip = row.own && toOpen && (
            <InfoTip label={HUB_PANEL_COPY.OWN_TIP_LABEL(symbol)} align="start">
              <span className="block space-y-2">
                {HUB_PANEL_COPY.OWN_TIP(symbol, CHANNEL_RESERVE_CKB.UDT).map((paragraph) => (
                  <span key={paragraph} className="block">
                    {paragraph}
                  </span>
                ))}
              </span>
            </InfoTip>
          );
          const lockedReason = !ready
            ? blocked
            : running
              ? inRun
                ? HUB_PANEL_COPY.IN_RUN
                : HUB_PANEL_COPY.BUSY
              : selectable
                ? null
                : rowLockedReason(view === "failed" ? row.state.kind : view, symbol);
          return (
            <HubRowItem
              key={row.asset}
              row={row}
              view={view}
              symbol={symbol}
              look={lookOf(row.asset)}
              funding={funding}
              units={(value) => formatUnits(value.toString(), decimalsOf(row.asset))}
              checked={(selectable && selected.has(row.asset)) || inRun}
              disabled={lockedReason !== null}
              lockedReason={lockedReason}
              reason={view === "failed" ? run?.reason : undefined}
              lineTip={choice ? null : ownTip}
              onToggle={(on) => toggle(row.asset, on)}
            >
              {row.asset === CKB_ASSET && toOpen && (
                <ContributionField
                  text={text}
                  onText={setText}
                  onValid={contribution.onChange}
                  balance={balance}
                  selected={chosen}
                  disabled={running}
                />
              )}
              {choice && (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pt-1" data-testid={`fiber-node-hub-fund-${row.asset}`}>
                  <ChoiceGroup
                    label={HUB_PANEL_COPY.FUNDING_LABEL(symbol)}
                    options={[
                      { value: "hub", label: HUB_PANEL_COPY.FUND_HUB },
                      { value: "own", label: HUB_PANEL_COPY.FUND_OWN(symbol) },
                    ]}
                    value={funding}
                    onChange={(next) => chooseFunding(row.asset, next)}
                    disabled={running}
                  />
                  {ownTip}
                </div>
              )}
              {row.own && toOpen && funding === "own" && (
                <OwnTokenField
                  asset={row.asset}
                  symbol={symbol}
                  decimals={decimalsOf(row.asset)}
                  offer={row.own}
                  text={ownTextOf(row.asset, row.own)}
                  onText={(next) => setOwnText((prev) => ({ ...prev, [row.asset]: next }))}
                  check={ownCheckOf(row.asset, row.own)}
                  read={readTokenBalance}
                  refreshKey={`${balance ?? ""}:${runs}`}
                  onBalance={(amount) => setOwnBalances((prev) => (prev[row.asset] === amount ? prev : { ...prev, [row.asset]: amount }))}
                  disabled={running}
                />
              )}
            </HubRowItem>
          );
        })}
      </ul>
      {ready && restartSymbols.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3" data-testid="fiber-node-hub-restart">
          <p className="text-xs text-muted-foreground">{HUB_PANEL_COPY.RESTART(assetList.format(restartSymbols))}</p>
          {onLock && (
            <button
              type="button"
              onClick={onLock}
              disabled={lockBusy || running}
              title={lockBusy ? HUB_PANEL_COPY.LOCK_BUSY : running ? HUB_PANEL_COPY.BUSY : undefined}
              className={textButton}
              data-testid="fiber-node-hub-restart-lock"
            >
              {HUB_PANEL_COPY.LOCK}
            </button>
          )}
        </div>
      )}
      {blocked && (
        <p className="text-xs text-muted-foreground" data-testid="fiber-node-hub-blocked">
          {blocked}
        </p>
      )}
      {!blocked && !running && chosen.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground" data-testid="fiber-node-hub-total">
            {HUB_PANEL_COPY.TOTAL(formatCkb(needs.neededCkb), needs.haveCkb === null ? null : formatCkb(needs.haveCkb))}
          </p>
          {balance !== null && !needs.enough && (
            <p className="text-xs text-destructive" data-testid="fiber-node-hub-short">
              {HUB_PANEL_COPY.SHORT(formatCkb(needs.shortCkb))}
            </p>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-1">
        <button
          type="button"
          onClick={start}
          disabled={reason !== null || running}
          title={reason ?? undefined}
          className={primaryButton}
          data-testid="fiber-node-hub-open"
        >
          {running ? HUB_PANEL_COPY.OPENING_NOW : HUB_PANEL_COPY.OPEN(Math.max(1, chosen.length))}
        </button>
        {running && (
          <button type="button" onClick={stop} disabled={stopping} title={HUB_PANEL_COPY.STOP_TITLE} className={textButton} data-testid="fiber-node-hub-stop">
            {HUB_PANEL_COPY.STOP}
          </button>
        )}
      </div>
      <div aria-live="polite" className="space-y-2">
        {running && progress && (
          <p className="text-xs text-muted-foreground" data-testid="fiber-node-hub-progress">
            {progress.kind === "asking"
              ? HUB_PANEL_COPY.PROGRESS_ASKING(symbolOf(progress.asset), progress.index, progress.total)
              : HUB_PANEL_COPY.PROGRESS_WAITING(symbolOf(progress.asset))}
          </p>
        )}
        {!running && summary && (
          <StatusNotice tone={hubRunSummaryTone(summary)} role="status" data-testid="fiber-node-hub-summary">
            {summaryText(summary)}
          </StatusNotice>
        )}
      </div>
    </div>
  );
}

/** Why a row that cannot be ticked cannot (its checkbox's title); a failed row by where it stands now. */
function rowLockedReason(view: HubRowView, symbol: string): string | null {
  switch (view) {
    case "open":
    case "opening":
      return HUB_PANEL_COPY.HAS_CHANNEL(symbol);
    case "restart":
      return HUB_PANEL_COPY.RESTART(symbol);
    case "unfundable":
      return HUB_PANEL_COPY.HUB_SHORT(symbol);
    case "done":
      return HUB_PANEL_COPY.ASKED;
    case "queued":
    case "asking":
      return HUB_PANEL_COPY.IN_RUN;
    default:
      return null;
  }
}

function summaryText(summary: HubRunSummary): string {
  switch (summary.kind) {
    case "all_done":
      return HUB_PANEL_COPY.SUMMARY.allDone(summary.done);
    case "some_failed":
      return HUB_PANEL_COPY.SUMMARY.someFailed(summary.done, summary.total, summary.failed);
    case "none_done":
      return HUB_PANEL_COPY.SUMMARY.noneDone(summary.total);
    case "stopped":
      return HUB_PANEL_COPY.SUMMARY.stopped(summary.done, summary.total);
  }
}

/**
 * One asset: its checkbox (named by the symbol), icon, symbol and name, where it stands, and one line: what the open
 * channel moves now, or who funds a new one with what (and, for a token, the CKB reserve the node needs).
 */
function HubRowItem(props: {
  row: HubRow;
  view: HubRowView;
  symbol: string;
  look: TokenLook;
  funding: HubRowFunding;
  units: (value: bigint) => string;
  checked: boolean;
  disabled: boolean;
  lockedReason: string | null;
  reason: string | undefined;
  /** A "?" after the line. */
  lineTip?: React.ReactNode;
  onToggle: (on: boolean) => void;
  children?: React.ReactNode;
}) {
  const { row, view, symbol, look, funding, units, checked, disabled, lockedReason, reason, lineTip, onToggle, children } = props;
  const id = useId();
  const statusId = `${id}-status`;
  const hubAmount = `${units(row.hubAmount ?? BigInt(0))} ${symbol}`;
  const line =
    row.state.kind === "open"
      ? HUB_PANEL_COPY.CAPACITY(units(row.state.liquidity.send), units(row.state.liquidity.receive), symbol)
      : row.state.kind === "opening"
        ? HUB_PANEL_COPY.READY_SOON
        : row.asset === CKB_ASSET
          ? HUB_PANEL_COPY.HUB_FUNDS(hubAmount)
          : row.state.kind === "available" && funding === "own"
            ? HUB_PANEL_COPY.OWN_OFFER(TOKEN_RESERVE_CKB(row.asset))
            : HUB_PANEL_COPY.TOKEN_OFFER(hubAmount, TOKEN_RESERVE_CKB(row.asset));
  return (
    <li
      className="flex items-start gap-3 border-b border-foreground/5 py-3 last:border-b-0"
      data-testid={`fiber-node-hub-row-${row.asset}`}
      data-status={view}
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onToggle(e.target.checked)}
        title={lockedReason ?? undefined}
        aria-describedby={statusId}
        className="mt-1 h-4 w-4 shrink-0 accent-foreground disabled:cursor-not-allowed disabled:opacity-40"
      />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <span className="inline-flex min-w-0 items-center gap-2">
            <label htmlFor={id} className="inline-flex items-center gap-2 text-sm font-medium">
              <TokenIcon symbol={symbol} icon={look.icons} size={20} />
              {symbol}
            </label>
            {/* The hub's display name, else the app's or the hub's name: beside the symbol, not part of the checkbox's name. */}
            {look.name !== symbol && (
              <span className="truncate text-xs text-muted-foreground" data-testid={`fiber-node-hub-name-${row.asset}`}>
                {look.name}
              </span>
            )}
          </span>
          <StatusBadge id={statusId} tone={hubRowTone(view)} dot={view === "asking"}>
            {HUB_PANEL_COPY.STATUS[view]}
          </StatusBadge>
        </div>
        <p className="text-xs text-muted-foreground">
          <span data-testid={`fiber-node-hub-line-${row.asset}`}>{line}</span>
          {lineTip && <> {lineTip}</>}
        </p>
        {reason && (
          <p className="text-xs text-destructive [overflow-wrap:anywhere]" data-testid={`fiber-node-hub-reason-${row.asset}`}>
            {reason}
          </p>
        )}
        {children}
      </div>
    </li>
  );
}

/**
 * "Your node puts in [ ] cWBTC": the node's own tokens for a channel it opens to the hub (the hub's peerChannels). The
 * field starts at the hub's minimum; under it, what the node holds of the token on chain (read when the field shows,
 * again after a run or a new CKB balance) and the minimum, or why the amount cannot go in. Max fills all the node holds.
 */
function OwnTokenField(props: {
  asset: FiberAssetId;
  symbol: string;
  decimals: number;
  offer: OwnTokenOffer;
  text: string;
  onText: (text: string) => void;
  check: OwnAmountCheck;
  read: ((script: Script) => Promise<bigint>) | null;
  /** A new value reads the balance again. */
  refreshKey: string;
  onBalance: (amount: bigint | null) => void;
  disabled: boolean;
}) {
  const { asset, symbol, decimals, offer, text, onText, check, read, refreshKey, onBalance, disabled } = props;
  const id = useId();
  const [state, setState] = useState<{ status: "reading" } | { status: "read"; amount: bigint } | { status: "failed" }>({ status: "reading" });
  const [again, setAgain] = useState(0);
  const report = useRef(onBalance);
  useEffect(() => {
    report.current = onBalance;
  });
  const script = offer.udtTypeScript;
  const scriptKey = `${script.codeHash}:${script.hashType}:${script.args}`;
  useEffect(() => {
    if (!read) return;
    let live = true;
    setState({ status: "reading" });
    report.current(null);
    read(script).then(
      (amount) => {
        if (!live) return;
        setState({ status: "read", amount });
        report.current(amount);
      },
      () => {
        if (live) setState({ status: "failed" });
      },
    );
    return () => {
      live = false;
    };
    // `script` is named by scriptKey: a new object for the same script reads nothing again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [read, scriptKey, refreshKey, again]);
  const held = state.status === "read" ? state.amount : null;
  const max = maxOwnAmount(held, offer.minAmount);
  const min = `${formatUnits(offer.minAmount.toString(), decimals)} ${symbol}`;
  // The field's own problem; "still reading" shows as the line under it instead.
  const error = !check.ok && check.error !== OWN_TOKEN_MESSAGE.READING(symbol) ? check.error : null;
  return (
    <div className="space-y-1 pt-1" data-testid={`fiber-node-hub-own-${asset}`}>
      <label id={`${id}-label`} htmlFor={id} className="block text-xs text-muted-foreground">
        {HUB_PANEL_COPY.PUTS_IN}
      </label>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <input
          id={id}
          inputMode="decimal"
          autoComplete="off"
          value={text}
          disabled={disabled}
          onChange={(e) => onText(e.target.value)}
          aria-labelledby={`${id}-label ${id}-unit`}
          aria-invalid={error !== null}
          aria-describedby={error ? `${id}-error` : `${id}-held`}
          className={cn(textInput, "w-32 disabled:opacity-60")}
        />
        <span id={`${id}-unit`} className="text-xs text-muted-foreground">
          {symbol}
        </span>
        {max !== null && (
          <button type="button" onClick={() => onText(ownAmountText(max, decimals, localeDecimalMark()))} disabled={disabled} className={textButton}>
            {HUB_PANEL_COPY.MAX}
          </button>
        )}
      </div>
      <p id={`${id}-held`} className="text-xs text-muted-foreground" data-testid={`fiber-node-hub-own-held-${asset}`}>
        {state.status === "read"
          ? HUB_PANEL_COPY.OWN_HOLDS(`${formatUnits(state.amount.toString(), decimals)} ${symbol}`, min)
          : state.status === "failed"
            ? HUB_PANEL_COPY.OWN_READ_FAILED(symbol)
            : HUB_PANEL_COPY.OWN_READING(symbol)}
        {state.status === "failed" && (
          <>
            {" "}
            <button type="button" onClick={() => setAgain((n) => n + 1)} className={cn(textButton, "mx-0 px-1 underline underline-offset-4")}>
              {HUB_PANEL_COPY.READ_AGAIN}
            </button>
          </>
        )}
      </p>
      {error && (
        <p id={`${id}-error`} className="text-xs text-destructive" data-testid={`fiber-node-hub-own-error-${asset}`}>
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * "Your node puts in [ ] CKB": the amount for a new CKB channel, used when the node accepts it, so it changes with no
 * restart. A valid amount is saved as the next default; Max fills what the node holds less the fee margin and what the
 * ticked token rows need.
 */
function ContributionField(props: {
  text: string;
  onText: (text: string) => void;
  onValid: (ckb: number) => void;
  balance: bigint | null;
  selected: readonly FiberAssetId[];
  disabled: boolean;
}) {
  const { text, onText, onValid, balance, selected, disabled } = props;
  const valid = parseContribution(text) !== null;
  const largest = balance === null ? null : maxContribution(balance, selected);
  const change = (next: string) => {
    onText(next);
    const ckb = parseContribution(next);
    if (ckb !== null) onValid(ckb);
  };
  return (
    <div className="space-y-1 pt-1" data-testid="fiber-node-contribution">
      <label htmlFor="fiber-node-contribution" className="block text-xs text-muted-foreground">
        {HUB_PANEL_COPY.PUTS_IN}
      </label>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <input
          id="fiber-node-contribution"
          inputMode="numeric"
          autoComplete="off"
          value={text}
          disabled={disabled}
          onChange={(e) => change(e.target.value)}
          aria-invalid={!valid}
          aria-describedby={valid ? undefined : "fiber-node-contribution-error"}
          className={cn(textInput, "w-28 disabled:opacity-60")}
        />
        <span className="text-xs text-muted-foreground">CKB</span>
        {largest !== null && largest >= MIN_CHANNEL_CONTRIBUTION_CKB && (
          <button type="button" onClick={() => change(String(largest))} disabled={disabled} className={textButton}>
            {HUB_PANEL_COPY.MAX}
          </button>
        )}
      </div>
      {!valid && (
        <p id="fiber-node-contribution-error" className="text-xs text-destructive">
          {HUB_PANEL_COPY.CONTRIBUTION_ERROR(formatCkb(MIN_CHANNEL_CONTRIBUTION_CKB))}
        </p>
      )}
    </div>
  );
}
