import type { SwapState } from "@/lib/hub/contract";
import { PAID_OUT_STATES } from "@/lib/swap/constants";
import { hashKey, isRecordFinal, type SwapRecord } from "@/lib/swap/history";
import { runOutcome, type RunOutcome } from "@/lib/swap/run-model";
import { activityLabel, holdsNode, isActivityFinal, isPollable, type ActivityEntry, type ActivityKind } from "./activity";
import { INVOICE_STATUS_OPEN, INVOICE_STATUS_PAID } from "./constants";

/**
 * The Fiber node's History (docs/pay-get-paid.md, part E): one list of everything that moved money through the node.
 * Two sources, both in this browser's localStorage: the node's own entries (./activity.ts: its leg of each swap, Pay's
 * Fiber payments and on-chain sends, Get paid's Fiber invoices, channels, withdrawals) and the swaps the app started
 * (lib/swap/history.ts: the swap card's, Pay's Lightning invoices, Get paid's Lightning invoices). A swap is one entry:
 * the node's leg and the app's record of it share the payment hash. Nothing secret is in either.
 */

export interface HistoryItem {
  /** A swap's or payment's hash (0x, lowercase for a swap), a channel's or withdrawal's id: unique in the list. */
  key: string;
  kind: ActivityKind;
  /** When it happened (ms): the node's entry, or the hub's creation time of a swap the node has no leg of. */
  at: number;
  /** The node's own entry (a swap's leg, or anything else); null for a swap the node has no leg of (an own node's). */
  entry: ActivityEntry | null;
  /** The app's record of a swap (the hub's state as last read); null for anything else, or a leg the app has no record of. */
  swap: SwapRecord | null;
}

/** What the visitor asks History for: a swap by its id, or an entry by its hash (a payment hash, a transaction). */
export interface EntryRef {
  id: string | null;
  hash: string | null;
}

/** The app's record of a node's swap leg: by the payment hash both legs share, or by the swap id the node learned. */
function recordOf(records: readonly SwapRecord[]): (entry: Pick<ActivityEntry, "id" | "swap">) => SwapRecord | null {
  const byHash = new Map(records.map((r) => [hashKey(r.paymentHash), r]));
  const byId = new Map(records.map((r) => [r.id.toLowerCase(), r]));
  return (entry) => byHash.get(hashKey(entry.id)) ?? (entry.swap?.id ? byId.get(entry.swap.id.toLowerCase()) : undefined) ?? null;
}

/** The node's entries and the app's swaps as one list, newest first; each swap once, its leg and its record together. */
export function mergeHistory(entries: readonly ActivityEntry[], records: readonly SwapRecord[]): HistoryItem[] {
  const find = recordOf(records);
  const merged = new Set<string>();
  const items: HistoryItem[] = entries.map((entry) => {
    if (entry.kind !== "swap") return { key: entry.id, kind: entry.kind, at: entry.at, entry, swap: null };
    const swap = find(entry);
    if (swap) merged.add(swap.id);
    return { key: hashKey(entry.id), kind: "swap", at: entry.at, entry, swap };
  });
  for (const swap of records) {
    if (!merged.has(swap.id)) items.push({ key: hashKey(swap.paymentHash), kind: "swap", at: Date.parse(swap.createdAt), entry: null, swap });
  }
  return items.sort((a, b) => b.at - a.at);
}

const HEX_HASH = /^(0x)?[0-9a-f]{64}$/i;

/** The entry a reference names: a swap by its id (the app's record, or the node's leg once it knew it), else by hash. */
export function findHistoryItem(items: readonly HistoryItem[], ref: EntryRef): HistoryItem | null {
  const id = ref.id?.toLowerCase();
  if (id) {
    const byId = items.find((i) => i.swap?.id.toLowerCase() === id || i.entry?.swap?.id?.toLowerCase() === id);
    if (byId) return byId;
  }
  if (!ref.hash || !HEX_HASH.test(ref.hash)) return null;
  const hash = hashKey(ref.hash);
  return items.find((i) => HEX_HASH.test(i.key) && hashKey(i.key) === hash) ?? null;
}

/* ------------------------------------------------------------------------------------------- states */

/**
 * The node's payout invoice of a BTC to CKB swap stays open for an hour, but once the hub's swap failed (cancelled
 * unpaid, refunded, or a Get paid invoice given up for a new one) no payer will come: the leg is done, so it neither
 * holds the node nor is read again.
 */
export const releasedBySwap = (entry: Pick<ActivityEntry, "kind" | "status" | "swap">, record: Pick<SwapRecord, "state"> | null): boolean =>
  entry.kind === "swap" && entry.swap?.leg === "invoice" && entry.status === INVOICE_STATUS_OPEN && record?.state === "failed";

/** The entry still needs the node online (./activity.ts holdsNode), unless its swap released it. */
export const itemHoldsNode = (item: Pick<HistoryItem, "entry" | "swap">): boolean =>
  item.entry !== null && holdsNode(item.entry) && !releasedBySwap(item.entry, item.swap);

/** The node's entries it still reads (get_invoice, get_payment), leaving out legs whose swap released them. */
export function pollableEntries(entries: readonly ActivityEntry[], records: readonly SwapRecord[]): ActivityEntry[] {
  const find = recordOf(records);
  return entries.filter((e) => isPollable(e) && !(e.kind === "swap" && releasedBySwap(e, find(e))));
}

/* ------------------------------------------------------------------------------------------- Get paid */

/** The Get paid request a node entry belongs to: a request's Fiber invoice, or a payout invoice made for its Lightning invoice. */
const requestOf = (entry: Pick<ActivityEntry, "kind" | "request" | "swap">): string | null => {
  if (entry.kind === "request") return entry.request?.id ?? null;
  return entry.kind === "swap" && entry.swap?.leg === "invoice" ? (entry.swap.request ?? null) : null;
};

const paidOut = (record: Pick<SwapRecord, "state"> | null): boolean => record !== null && (PAID_OUT_STATES as readonly SwapState[]).includes(record.state);

/**
 * A Get paid request is paid once: when one of its invoices is paid (its Fiber invoice, or its Lightning invoice, whose
 * swap paid the node's payout invoice), the node cancels the request's other invoices nobody has paid yet. A Fiber
 * payer then cannot pay the Fiber invoice; a Lightning payer's sats come back, since the hub cannot pay a cancelled
 * payout invoice and so refunds the hold. Only invoices still open are cancelled (fnn refuses once a payment arrived:
 * two payers at the same moment still pay twice, and the receipt says so). The node does it, so it happens while the
 * node runs, whether the app page is open or not.
 */
export function invoicesToCancel(entries: readonly ActivityEntry[], records: readonly SwapRecord[]): ActivityEntry[] {
  const find = recordOf(records);
  const paid = new Set<string>();
  for (const entry of entries) {
    const request = requestOf(entry);
    if (request && (entry.status === INVOICE_STATUS_PAID || (entry.kind === "swap" && paidOut(find(entry))))) paid.add(request);
  }
  return entries.filter((entry) => {
    const request = requestOf(entry);
    return request !== null && paid.has(request) && entry.status === INVOICE_STATUS_OPEN && !(entry.kind === "swap" && paidOut(find(entry)));
  });
}

/** A swap the app has a record of, as the hub last said: under way, complete, refunded or refunding, cancelled. */
export const swapOutcome = (record: Pick<SwapRecord, "state" | "refunded" | "funded">): RunOutcome => runOutcome(record, { funded: record.funded });

/** A swap's standing in a word, as its badge shows it. */
const SWAP_OUTCOME_LABEL: Readonly<Record<RunOutcome, string>> = {
  running: "In progress",
  complete: "Completed",
  refunded: "Refunded",
  "refund-pending": "Refunding",
  cancelled: "Cancelled",
  cancelling: "Cancelling",
};

/** Readable status of an entry: a swap the app knows by the hub's state, anything else by the node's. */
export function historyLabel(item: Pick<HistoryItem, "entry" | "swap">): string {
  if (item.swap) return SWAP_OUTCOME_LABEL[swapOutcome(item.swap)];
  return item.entry ? activityLabel(item.entry) : "";
}

/** Nothing more will change: the hub's swap is final, or the node's entry is. */
export function isItemFinal(item: Pick<HistoryItem, "entry" | "swap">): boolean {
  if (item.swap) return isRecordFinal(item.swap);
  return item.entry ? isActivityFinal(item.entry) : true;
}

/** History's filters: everything; Pay's Fiber payments and Get paid's requests; swaps; channels; funds sent on chain. */
export const HISTORY_FILTERS = ["all", "payments", "swaps", "channels", "funds"] as const;
export type HistoryFilter = (typeof HISTORY_FILTERS)[number];

const FILTER_KINDS: Readonly<Record<Exclude<HistoryFilter, "all">, readonly ActivityKind[]>> = {
  payments: ["payment", "request"],
  swaps: ["swap"],
  channels: ["channel"],
  funds: ["withdraw"],
};

export const inHistoryFilter = (item: Pick<HistoryItem, "kind">, filter: HistoryFilter): boolean =>
  filter === "all" || FILTER_KINDS[filter].includes(item.kind);
