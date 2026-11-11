"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ArrowDownToLine, ArrowLeftRight, ArrowUpFromLine, ChevronDown, Send, Waypoints, type LucideIcon } from "lucide-react";
import { formatUnits } from "@/lib/hub/format";
import { PAY_COPY } from "@/lib/pay/copy";
import { historyTone } from "@/lib/status-tone";
import { CARD_COPY, RESULT_COPY } from "@/lib/swap/copy";
import type { SwapRecord } from "@/lib/swap/history";
import { legText } from "@/lib/swap/format";
import { cn } from "@/lib/utils";
import { isActivityFinal, type ActivityEntry, type ActivityKind } from "@/lib/wallets/fiber-browser/activity";
import { CKB_DECIMALS, PAYMENT_STATUS } from "@/lib/wallets/fiber-browser/constants";
import {
  findHistoryItem,
  HISTORY_FILTERS,
  historyLabel,
  inHistoryFilter,
  isItemFinal,
  swapOutcome,
  type EntryRef,
  type HistoryFilter,
  type HistoryItem,
} from "@/lib/wallets/fiber-browser/history";
import { explorerTxUrl } from "@/lib/wallets/fiber-byo/funding";
import { tokenLook, type TokenLook } from "@/lib/token-display";
import { PAY_TOKENS } from "@/lib/tokens";
import { FeedbackLink } from "../feedback-link";
import { StatusBadge, StatusNotice } from "../status";
import { TokenIcon } from "../token-icon";
import { CopyButton, Row, shorten } from "../ui";
import { HISTORY_COPY } from "./copy";
import { ChoiceGroup } from "./fields";
import { useSwapRead } from "./use-swap-read";

export interface HistoryNames {
  /** "12.5 RUSD": base units of an asset with its symbol. */
  amount: (asset: string, amount: string) => string;
  /** "RUSD": an asset's symbol, as the hub lists it. */
  symbol: (asset: string) => string;
  /** How an asset looks: the hub's display name and icon first (lib/token-display.ts). */
  look: (asset: string) => TokenLook;
  /** "the CKBolt hub", or a shortened node id. */
  peer: (nodeId: string) => string;
}

/** An entry the list opens by itself (the app's "View in History"); a new `at` opens it again. */
export interface HistoryTarget {
  ref: EntryRef;
  at: number;
}

/** What an entry is, by its icon: a swap, a payment from Pay, an invoice for Get paid, a channel, a withdrawal. */
const KIND_ICON: Readonly<Record<ActivityKind, LucideIcon>> = {
  swap: ArrowLeftRight,
  payment: Send,
  request: ArrowDownToLine,
  channel: Waypoints,
  withdraw: ArrowUpFromLine,
};

/** A node entry in one line, as it stands now: "Swap: paid 100 CKB", "Opening channel with the CKBolt hub · 1,000 CKB"... */
export function historyTitle(entry: ActivityEntry, names: HistoryNames): string {
  const amount = names.amount(entry.asset, entry.amount);
  const done = isActivityFinal(entry);
  switch (entry.kind) {
    case "swap":
      if (entry.swap?.leg === "payment") return entry.status === "Success" ? HISTORY_COPY.SWAP_PAID(amount) : HISTORY_COPY.SWAP_PAYMENT(amount);
      return entry.status === "Paid" ? HISTORY_COPY.SWAP_RECEIVED(amount) : HISTORY_COPY.SWAP_PAYOUT(amount);
    case "payment":
      return entry.status === "Success" ? HISTORY_COPY.PAID(amount) : HISTORY_COPY.PAYMENT(amount);
    case "request":
      return entry.status === "Paid" ? HISTORY_COPY.RECEIVED(amount) : HISTORY_COPY.REQUEST(amount);
    case "channel": {
      const peer = entry.counterparty ? names.peer(entry.counterparty) : HISTORY_COPY.UNKNOWN_PEER;
      if (entry.channel?.action === "close") return done ? HISTORY_COPY.CHANNEL_CLOSED(peer, amount) : HISTORY_COPY.CHANNEL_CLOSING(peer, amount);
      return done ? HISTORY_COPY.CHANNEL_OPEN(peer, amount) : HISTORY_COPY.CHANNEL_OPENING(peer, amount);
    }
    default:
      return HISTORY_COPY.WITHDREW(amount);
  }
}

/** An entry of History in one line: a swap the app kept by both its sides ("Swap: 20,000 sats → 1,000 CKB"), else the node's. */
export function itemTitle(item: HistoryItem, names: HistoryNames): string {
  if (item.swap) return HISTORY_COPY.SWAP(legText(item.swap.pay, item.swap.symbol), legText(item.swap.receive, item.swap.symbol));
  return item.entry ? historyTitle(item.entry, names) : "";
}

const time = (ms: number): string => new Date(ms).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
const dateTime = (ms: number): string => new Date(ms).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
const day = (ms: number): string => new Date(ms).toLocaleDateString("en-US", { dateStyle: "medium" });

const linkClass = "inline-flex min-h-10 items-center text-xs underline underline-offset-4";

/** The entry's token in its detail: icon and display name with the symbol (the name only when it says more). */
function TokenRow({ look }: { look: TokenLook }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 border-b border-foreground/5 last:border-b-0" data-testid="history-entry-token">
      <dt className="shrink-0 text-xs text-muted-foreground">{HISTORY_COPY.TOKEN}</dt>
      <dd className="inline-flex min-w-0 items-center gap-2 text-right text-xs">
        <TokenIcon symbol={look.symbol} icon={look.icons} size={16} />
        <span className="[overflow-wrap:anywhere]">{HISTORY_COPY.TOKEN_NAME(look.name, look.symbol)}</span>
      </dd>
    </div>
  );
}

/** The hash an entry is known by, and what to call it: a payment hash, a channel, a transaction. */
function hashOf(item: HistoryItem): { label: string; value: string } {
  const entry = item.entry;
  if (entry?.kind === "withdraw") return { label: HISTORY_COPY.TRANSACTION, value: entry.txHash ?? entry.id };
  if (entry?.kind === "channel") return { label: HISTORY_COPY.CHANNEL_ID, value: entry.channel?.channelId ?? entry.id };
  return { label: HISTORY_COPY.HASH, value: item.key };
}

/** What a swap that ended without completing means for the visitor's money, under its badge. */
const OUTCOME_LINE: Partial<Record<ReturnType<typeof swapOutcome>, string>> = {
  refunded: HISTORY_COPY.REFUNDED_LINE,
  "refund-pending": RESULT_COPY.REFUND_PENDING_LINE,
  cancelled: RESULT_COPY.CANCELLED_LINE,
};

/**
 * A swap's detail: both sides and how it stands at the hub (read while the detail is open and the swap not final), its
 * refund and the hub's reason, the node's own leg (its routing fee), the swap id and payment hash, Report a problem.
 */
function SwapDetail({ item, names, open, onKeepSwap }: { item: HistoryItem; names: HistoryNames; open: boolean; onKeepSwap: (record: SwapRecord) => void }) {
  const { entry, swap } = item;
  const id = swap?.id ?? entry?.swap?.id ?? null;
  const toRead = id ? { id, symbol: swap?.symbol ?? (entry ? names.symbol(entry.asset) : ""), funded: swap?.funded ?? false } : null;
  const { read, failed } = useSwapRead(toRead, open, onKeepSwap);
  const outcome = swap ? swapOutcome(swap) : null;
  const line = outcome ? OUTCOME_LINE[outcome] : undefined;
  return (
    <>
      {line && <p className="py-2 text-xs text-muted-foreground">{line}</p>}
      <dl>
        {swap ? (
          <>
            <Row compact label={CARD_COPY.PAY_LABEL} value={legText(swap.pay, swap.symbol)} />
            <Row compact label={CARD_COPY.RECEIVE_LABEL} value={legText(swap.receive, swap.symbol)} />
          </>
        ) : (
          entry && <Row compact label={HISTORY_COPY.AMOUNT} value={names.amount(entry.asset, entry.amount)} />
        )}
        {(swap ?? entry) && <TokenRow look={names.look((swap ?? entry)!.asset)} />}
        {!swap && entry?.swap?.lightningSats && <Row compact label={HISTORY_COPY.LIGHTNING_LEG} value={HISTORY_COPY.SATS(formatUnits(entry.swap.lightningSats, 0))} />}
        {entry?.fee && <Row compact label={HISTORY_COPY.ROUTING_FEE} value={names.amount(entry.asset, entry.fee)} />}
        {read?.failureReason && (
          // The hub's reason is a sentence: read as prose, under its label, not as a mono value.
          <div className="border-b border-foreground/5 py-2">
            <dt className="text-xs text-muted-foreground">{RESULT_COPY.REASON}</dt>
            <dd className="mt-1 text-xs [overflow-wrap:anywhere]">{read.failureReason}</dd>
          </div>
        )}
        {id && <Row compact label={HISTORY_COPY.SWAP_ID} value={id} />}
        <Row compact label={HISTORY_COPY.HASH} value={shorten(item.key, 10)} />
      </dl>
      {failed === "unknown" && <p className="mt-1 text-xs text-muted-foreground">{HISTORY_COPY.UNKNOWN_TO_HUB}</p>}
      {failed === "unreachable" && !isItemFinal(item) && <p className="mt-1 text-xs text-muted-foreground">{HISTORY_COPY.UNREACHABLE}</p>}
      <div className="flex flex-wrap items-center gap-x-5">
        <CopyButton value={item.key} label={HISTORY_COPY.COPY(HISTORY_COPY.HASH)} />
        <FeedbackLink swapId={id} className="text-xs" testId="history-entry-report" />
      </div>
    </>
  );
}

/** A Fiber invoice paid from Pay: the amount, the fee it took next to the most it could have, the payee, the hash. */
function PaymentDetail({ entry, names }: { entry: ActivityEntry; names: HistoryNames }) {
  const maxFee = entry.payment ? names.amount(entry.asset, entry.payment.maxFee) : null;
  const paid = entry.status === PAYMENT_STATUS.SUCCESS && entry.fee;
  return (
    <>
      <dl>
        <Row compact label={HISTORY_COPY.AMOUNT} value={names.amount(entry.asset, entry.amount)} />
        <TokenRow look={names.look(entry.asset)} />
        {paid ? (
          <Row compact label={PAY_COPY.ACTUAL_FEE} value={maxFee ? PAY_COPY.FEE_OF_MAX(names.amount(entry.asset, entry.fee!), maxFee) : names.amount(entry.asset, entry.fee!)} />
        ) : (
          maxFee && <Row compact label={HISTORY_COPY.MAX_FEE} value={maxFee} />
        )}
        {entry.payment?.payee && <Row compact label={HISTORY_COPY.PAYEE} value={shorten(entry.payment.payee, 8)} />}
        <Row compact label={HISTORY_COPY.HASH} value={shorten(entry.id, 10)} />
      </dl>
      {entry.error && <p className="mt-1 font-mono text-xs text-destructive [overflow-wrap:anywhere]">{entry.error}</p>}
      <div className="flex flex-wrap items-center gap-x-5">
        <CopyButton value={entry.id} label={HISTORY_COPY.COPY(HISTORY_COPY.HASH)} />
        <FeedbackLink className="text-xs" testId="history-entry-report" />
      </div>
    </>
  );
}

/** A Get paid invoice, a channel or a withdrawal: its hash or id, and what else the node knows of it. */
function NodeDetail({ item, entry, names }: { item: HistoryItem; entry: ActivityEntry; names: HistoryNames }) {
  const hash = hashOf(item);
  return (
    <>
      <dl>
        <Row compact label={hash.label} value={shorten(hash.value, 10)} />
        <TokenRow look={names.look(entry.asset)} />
        {entry.counterparty && <Row compact label={HISTORY_COPY.PEER} value={shorten(entry.counterparty, 8)} />}
        {entry.fee && <Row compact label={HISTORY_COPY.FEE} value={names.amount(entry.asset, entry.fee)} />}
        {entry.request?.note && <Row compact label={HISTORY_COPY.NOTE} value={entry.request.note} />}
        {entry.request && !isActivityFinal(entry) && <Row compact label={HISTORY_COPY.VALID_UNTIL} value={dateTime(entry.request.expiresAt)} />}
        {entry.address && <Row compact label={HISTORY_COPY.TO} value={shorten(entry.address, 12)} />}
      </dl>
      {entry.error && <p className="mt-1 font-mono text-xs text-destructive [overflow-wrap:anywhere]">{entry.error}</p>}
      <div className="flex flex-wrap items-center gap-x-5">
        <CopyButton value={hash.value} label={HISTORY_COPY.COPY(hash.label)} />
        {entry.kind === "withdraw" && entry.txHash && (
          <a href={explorerTxUrl(entry.txHash)} target="_blank" rel="noopener noreferrer" className={linkClass}>
            {HISTORY_COPY.EXPLORER}
          </a>
        )}
      </div>
    </>
  );
}

/** One entry: a button with its icon, title, time and status; it opens to the entry's detail below it. */
function HistoryRow({
  item,
  names,
  open,
  reveal,
  onToggle,
  onKeepSwap,
}: {
  item: HistoryItem;
  names: HistoryNames;
  open: boolean;
  /** Opened from the app: brought into view. */
  reveal: number | null;
  onToggle: () => void;
  onKeepSwap: (record: SwapRecord) => void;
}) {
  const detailId = useId();
  const rowRef = useRef<HTMLLIElement>(null);
  const Icon = KIND_ICON[item.kind];
  useEffect(() => {
    if (reveal !== null) rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [reveal]);
  const entry = item.entry;
  return (
    <li
      ref={rowRef}
      className="border-b border-foreground/5 last:border-b-0"
      data-testid="history-entry"
      data-kind={item.kind}
      data-status={item.swap?.state ?? entry?.status}
      data-key={item.key}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={detailId}
        className="flex w-full items-center gap-3 py-3 text-left hover:bg-foreground/[0.02] focus-visible:outline-2 focus-visible:-outline-offset-2"
      >
        <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center border border-foreground/10" aria-hidden="true">
          <Icon className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm [overflow-wrap:anywhere]">{itemTitle(item, names)}</span>
          <span className="block font-mono text-xs text-muted-foreground">{time(item.at)}</span>
        </span>
        <StatusBadge tone={historyTone(item)}>{historyLabel(item)}</StatusBadge>
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} aria-hidden="true" />
      </button>
      <div id={detailId} hidden={!open} className="pb-3 pl-11" data-testid="history-entry-detail">
        {item.kind === "swap" ? (
          <SwapDetail item={item} names={names} open={open} onKeepSwap={onKeepSwap} />
        ) : entry?.kind === "payment" ? (
          <PaymentDetail entry={entry} names={names} />
        ) : (
          entry && <NodeDetail item={item} entry={entry} names={names} />
        )}
      </div>
    </li>
  );
}

const FILTERS: readonly { value: HistoryFilter; label: string }[] = HISTORY_FILTERS.map((value) => ({ value, label: HISTORY_COPY.FILTER[value] }));

/**
 * The node's History (newest first), shared by the popup's Home (`limit`: the latest few), its History page
 * (`filterable` and grouped by day) and the node page. One entry is open at a time; `target` opens one from outside
 * (the app's "View in History"), showing every kind, and says so when the node has no record of it. `empty` shows when
 * there is nothing yet.
 */
export function HistoryList({
  items,
  names,
  limit,
  filterable = false,
  grouped = false,
  empty,
  testId,
  target = null,
  onKeepSwap,
}: {
  items: readonly HistoryItem[];
  names: HistoryNames;
  limit?: number;
  filterable?: boolean;
  grouped?: boolean;
  empty?: ReactNode;
  testId: string;
  target?: HistoryTarget | null;
  onKeepSwap: (record: SwapRecord) => void;
}) {
  const [filter, setFilter] = useState<HistoryFilter>("all");
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [reveal, setReveal] = useState<{ key: string; at: number } | null>(null);
  const [missingAt, setMissingAt] = useState<number | null>(null);
  const [shownAll, setShownAll] = useState<number | null>(null);

  // The app asks for an entry: show everything (once), open it and bring it into view; until it is known, say so.
  useEffect(() => {
    if (!target || reveal?.at === target.at) return;
    if (shownAll !== target.at) {
      setFilter("all");
      setShownAll(target.at);
    }
    const found = findHistoryItem(items, target.ref);
    if (found) {
      setOpenKey(found.key);
      setReveal({ key: found.key, at: target.at });
      setMissingAt(null);
    } else setMissingAt(target.at);
  }, [target, items, reveal, shownAll]);

  const shown = items.filter((i) => inHistoryFilter(i, filter)).slice(0, limit);
  const row = (item: HistoryItem) => (
    <HistoryRow
      key={item.key}
      item={item}
      names={names}
      open={openKey === item.key}
      reveal={reveal?.key === item.key ? reveal.at : null}
      onToggle={() => setOpenKey((k) => (k === item.key ? null : item.key))}
      onKeepSwap={onKeepSwap}
    />
  );
  return (
    <div className="space-y-3" data-testid={testId}>
      {target && missingAt === target.at && (
        <StatusNotice tone="off" role="status" data-testid="history-entry-missing">
          {HISTORY_COPY.MISSING}
        </StatusNotice>
      )}
      {filterable && items.length > 0 && <ChoiceGroup label={HISTORY_COPY.FILTER_LABEL} options={FILTERS} value={filter} onChange={setFilter} fill />}
      {items.length === 0 ? (
        (empty ?? <p className="text-sm text-muted-foreground">{HISTORY_COPY.EMPTY}</p>)
      ) : shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">{HISTORY_COPY.NONE_HERE}</p>
      ) : grouped ? (
        <div className="space-y-4">
          {byDay(shown).map((group) => (
            <section key={group.day} aria-label={group.day}>
              <h3 className="font-mono text-xs text-muted-foreground">{group.day}</h3>
              <ul>{group.items.map(row)}</ul>
            </section>
          ))}
        </div>
      ) : (
        <ul>{shown.map(row)}</ul>
      )}
    </div>
  );
}

/** Entries under their day, newest first. */
function byDay(items: readonly HistoryItem[]): { day: string; items: HistoryItem[] }[] {
  const days: { day: string; items: HistoryItem[] }[] = [];
  for (const item of items) {
    const label = day(item.at);
    const last = days.at(-1);
    if (last?.day === label) last.items.push(item);
    else days.push({ day: label, items: [item] });
  }
  return days;
}

/** How the node's history names amounts and peers, from the workspace's tokens and the hub's id. */
export function historyNames(
  decimalsOf: (asset: string) => number,
  symbolOf: (asset: string) => string,
  hubNodeIds: readonly string[],
  lookOf: (asset: string) => TokenLook = (asset) => tokenLook(symbolOf(asset), undefined, PAY_TOKENS),
): HistoryNames {
  return {
    amount: (asset, amount) => `${formatUnits(amount, asset === "CKB" ? CKB_DECIMALS : decimalsOf(asset))} ${symbolOf(asset)}`,
    symbol: symbolOf,
    look: lookOf,
    peer: (nodeId) => (hubNodeIds.includes(nodeId) ? HISTORY_COPY.HUB : shorten(nodeId, 6)),
  };
}
