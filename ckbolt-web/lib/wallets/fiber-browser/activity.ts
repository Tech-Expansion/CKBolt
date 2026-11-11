import type { FiberAssetId } from "@/lib/hub/contract";
import { UUID_PATTERN } from "@/lib/hub/constants";
import type { NodeChannel, NodeInvoiceStatus, NodePayment, NodePaymentStatus } from "./node-port";
import { storageKey, type KeyValueStore } from "./storage";
import { CHANNEL_STATE, INVOICE_FINAL_STATUSES, MAX_HISTORY_ENTRIES, PAYMENT_STATUS, STORAGE_NAME } from "./constants";

/**
 * The node's activity: what it did as the app's infrastructure. The swaps it served for /app over the bridge, the
 * Fiber invoices it paid for Pay once the visitor confirmed them in the node, the Fiber invoices it made for Get paid,
 * the channels it asked for, opened and closed, and its withdrawals (also an on-chain send from Pay). A Get paid
 * request's Lightning invoice is the hub's, paid to the node through a swap, so it shows as that swap's leg. fiber-js
 * 0.9.1 can look up one payment or invoice by its hash but cannot list them, so the page keeps the list itself, per
 * network and node, in this browser (the popup and /app/fiber share it). History (./history.ts) merges it with the
 * swaps the app kept. Nothing secret is kept: no preimage, no key, no invoice text. Deposits are not listed: the page
 * cannot tell a transfer in from a channel's funds coming back without reading every transaction of its address.
 */

export type ActivityKind = "swap" | "payment" | "request" | "channel" | "withdraw";
/** The node's part in a swap: the payout invoice it made (BTC to CKB), or the hub's hold invoice it paid (CKB to BTC). */
export type SwapLeg = "invoice" | "payment";
export type ChannelActivity = "open" | "close";

/** A channel's part of the history: opening (asked for), open, closing, closed. */
export const CHANNEL_ACTIVITY_STATUS = { OPENING: "Opening", OPEN: "Open", CLOSING: "Closing", CLOSED: "Closed" } as const;
/** A withdrawal once the CKB RPC took its transaction. */
export const WITHDRAW_STATUS_SENT = "Sent";

export type ActivityStatus =
  | NodeInvoiceStatus
  | NodePaymentStatus
  | (typeof CHANNEL_ACTIVITY_STATUS)[keyof typeof CHANNEL_ACTIVITY_STATUS]
  | typeof WITHDRAW_STATUS_SENT;

export interface ActivityEntry {
  /** The key: a swap leg's or a payment's hash (0x), a channel request or channel id, a withdrawal's tx hash. */
  id: string;
  kind: ActivityKind;
  /** CKB for a withdrawal. */
  asset: FiberAssetId;
  /** Base units of `asset`. */
  amount: string;
  status: ActivityStatus;
  error: string | null;
  /** When it happened (ms). */
  at: number;
  /**
   * A swap: its id at the hub, the node's leg, the Lightning side in sats when the node knows it, and for a payout
   * invoice made for a Get paid request, that request's id.
   */
  swap?: { id: string | null; leg: SwapLeg; lightningSats: string | null; request?: string | null };
  /** Base units of `asset` paid in fees, once known (a swap's payment, a payment, a withdrawal). */
  fee?: string | null;
  /** A Fiber invoice paid from Pay: the most its routing fee could be (base units of `asset`), and the node it paid. */
  payment?: { maxFee: string; payee: string | null };
  /**
   * A Fiber invoice made for Get paid: the visitor's note (or null), when it stops being payable (ms), and the request's
   * id (which its Lightning invoice's payout invoice carries too; null in entries kept before 2026-10-30).
   */
  request?: { note: string | null; expiresAt: number; id?: string | null };
  /** A channel's peer. */
  counterparty?: string | null;
  /** A channel: opened or closed, the channel's id once known, and how many ready channels the peer had in that asset before. */
  channel?: { action: ChannelActivity; channelId: string | null; readyBefore: number };
  /** A withdrawal: its transaction and where it went. */
  txHash?: string | null;
  address?: string | null;
}

/* ------------------------------------------------------------------------------------------- states */

const CHANNEL_FINAL: readonly string[] = [CHANNEL_ACTIVITY_STATUS.OPEN, CHANNEL_ACTIVITY_STATUS.CLOSED];

/** The node has nothing more to learn about this entry. */
export function isActivityFinal(entry: Pick<ActivityEntry, "kind" | "status" | "swap">): boolean {
  switch (entry.kind) {
    case "swap":
      return entry.swap?.leg === "payment"
        ? entry.status === PAYMENT_STATUS.SUCCESS || entry.status === PAYMENT_STATUS.FAILED
        : INVOICE_FINAL_STATUSES.includes(entry.status);
    case "payment":
      return entry.status === PAYMENT_STATUS.SUCCESS || entry.status === PAYMENT_STATUS.FAILED;
    case "request":
      return INVOICE_FINAL_STATUSES.includes(entry.status);
    case "channel":
      return CHANNEL_FINAL.includes(entry.status);
    default:
      return true;
  }
}

/**
 * The entry needs the node online, so the page should stay open: a swap's invoice or payment, or a payment from Pay,
 * until done. A channel does not hold it: the hub and the chain finish it. Nor does a Get paid invoice: it stays open
 * for an hour and is often paid on Lightning instead, so Lock and leaving the page are not held up for it.
 */
export const holdsNode = (entry: Pick<ActivityEntry, "kind" | "status" | "swap">): boolean =>
  (entry.kind === "swap" || entry.kind === "payment") && !isActivityFinal(entry);

/**
 * Entries the node itself can tell about, still under way: a swap's invoice or payment, a payment from Pay, an invoice
 * made for Get paid. Read again until done, also after a reload (the dev log's payment-recovery pattern: the hash is
 * kept before send_payment).
 */
export const isPollable = (entry: Pick<ActivityEntry, "kind" | "status" | "swap">): boolean =>
  (entry.kind === "swap" || entry.kind === "payment" || entry.kind === "request") && !isActivityFinal(entry);

/** The entry is read with get_payment (a payment it sent) rather than get_invoice (an invoice it made). */
export const isPaymentEntry = (entry: Pick<ActivityEntry, "kind" | "swap">): boolean =>
  entry.kind === "payment" || (entry.kind === "swap" && entry.swap?.leg === "payment");

/** Replaces the entry with the same id where it is, or adds a new one first (newest first); the oldest drop past the cap. */
export const upsertActivity = (entries: readonly ActivityEntry[], entry: ActivityEntry): ActivityEntry[] =>
  (entries.some((e) => e.id === entry.id) ? entries.map((e) => (e.id === entry.id ? entry : e)) : [entry, ...entries]).slice(0, MAX_HISTORY_ENTRIES);

/** A payment (a swap's or one from Pay) as get_payment reports it now. */
export const withPayment = (entry: ActivityEntry, payment: Pick<NodePayment, "status" | "failedError" | "fee">): ActivityEntry => ({
  ...entry,
  status: payment.status,
  error: payment.failedError,
  fee: payment.status === PAYMENT_STATUS.SUCCESS ? payment.fee.toString() : (entry.fee ?? null),
});

/**
 * Channel entries against the node's channels now: an opening one is open once the peer has one more ready channel in
 * its asset than when it was asked for; a closing one is closed once its channel is closed or gone. `assetOf` names a
 * channel's asset (null for a token the hub does not list).
 */
export function reconcileChannels(
  entries: readonly ActivityEntry[],
  channels: readonly Pick<NodeChannel, "channelId" | "peerId" | "state" | "udtTypeScript">[],
  assetOf: (channel: Pick<NodeChannel, "udtTypeScript">) => FiberAssetId | null,
): ActivityEntry[] {
  return entries.map((entry) => {
    if (entry.kind !== "channel" || !entry.channel || isActivityFinal(entry)) return entry;
    if (entry.channel.action === "open") {
      const ready = readyChannels(channels, entry.counterparty ?? "", entry.asset, assetOf);
      return ready > entry.channel.readyBefore ? { ...entry, status: CHANNEL_ACTIVITY_STATUS.OPEN } : entry;
    }
    const channel = channels.find((c) => c.channelId === entry.channel?.channelId);
    return !channel || channel.state === CHANNEL_STATE.CLOSED ? { ...entry, status: CHANNEL_ACTIVITY_STATUS.CLOSED } : entry;
  });
}

/** How many ready channels the node has with `peerId` in `asset`. */
export const readyChannels = (
  channels: readonly Pick<NodeChannel, "peerId" | "state" | "udtTypeScript">[],
  peerId: string,
  asset: FiberAssetId,
  assetOf: (channel: Pick<NodeChannel, "udtTypeScript">) => FiberAssetId | null,
): number => channels.filter((c) => c.peerId === peerId && c.state === CHANNEL_STATE.READY && assetOf(c) === asset).length;

/* ------------------------------------------------------------------------------------------- words */

/** A payment's status (a swap's leg, or one from Pay) in a word or two, as its badge shows it. */
const PAYMENT_STATUS_LABEL: Readonly<Record<string, string>> = { Created: "Sending", Inflight: "In flight", Success: "Paid", Failed: "Failed" };

/** An invoice's status (a swap's payout invoice, or one made for Get paid) in a word or two, as its badge shows it. */
const INVOICE_STATUS_LABEL: Readonly<Record<string, string>> = { Open: "Waiting", Received: "Arriving", Paid: "Received", Cancelled: "Cancelled", Expired: "Expired" };

/** A swap leg's status in a word or two, as its badge shows it. */
const SWAP_STATUS_LABEL: Readonly<Record<SwapLeg, Readonly<Record<string, string>>>> = {
  invoice: INVOICE_STATUS_LABEL,
  payment: PAYMENT_STATUS_LABEL,
};

/** Readable status of an entry. */
export function activityLabel(entry: Pick<ActivityEntry, "kind" | "status" | "swap">): string {
  if (entry.kind === "swap") return SWAP_STATUS_LABEL[entry.swap?.leg ?? "invoice"][entry.status] ?? entry.status;
  if (entry.kind === "payment") return PAYMENT_STATUS_LABEL[entry.status] ?? entry.status;
  if (entry.kind === "request") return INVOICE_STATUS_LABEL[entry.status] ?? entry.status;
  return entry.status;
}

/* ------------------------------------------------------------------------------------------- storage */

const historyKey = (network: string, nodeId: string): string => storageKey(network, `${STORAGE_NAME.HISTORY}:${nodeId}`);

const KINDS: readonly string[] = ["swap", "payment", "request", "channel", "withdraw"];
const LEGS: readonly string[] = ["invoice", "payment"];
const BASE_UNITS = /^\d{1,30}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
/** A Get paid request's id as kept: missing (older entries), null, or a UUID. */
const isRequestId = (v: unknown): boolean => v === undefined || v === null || (typeof v === "string" && UUID_PATTERN.test(v));

/** An entry read back from storage, with the fields its kind must have; anything else is dropped. */
function readEntry(value: unknown): ActivityEntry | null {
  if (!isRecord(value)) return null;
  const e = value as Partial<ActivityEntry>;
  const ok =
    typeof e.id === "string" &&
    typeof e.kind === "string" &&
    KINDS.includes(e.kind) &&
    typeof e.asset === "string" &&
    typeof e.amount === "string" &&
    BASE_UNITS.test(e.amount) &&
    typeof e.status === "string" &&
    typeof e.at === "number" &&
    (e.kind !== "swap" || (isRecord(e.swap) && typeof e.swap.leg === "string" && LEGS.includes(e.swap.leg) && isRequestId(e.swap.request))) &&
    (e.kind !== "payment" || (isRecord(e.payment) && typeof e.payment.maxFee === "string" && BASE_UNITS.test(e.payment.maxFee))) &&
    (e.kind !== "request" ||
      (isRecord(e.request) && typeof e.request.expiresAt === "number" && (e.request.note === null || typeof e.request.note === "string") && isRequestId(e.request.id))) &&
    (e.kind !== "channel" || isRecord(e.channel));
  return ok ? (e as ActivityEntry) : null;
}

/** The node's history on `network` as kept in this browser, newest first; empty when none or unreadable. */
export function readHistory(store: KeyValueStore | null, network: string, nodeId: string): ActivityEntry[] {
  try {
    const parsed: unknown = JSON.parse(store?.getItem(historyKey(network, nodeId)) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(readEntry)
      .filter((e): e is ActivityEntry => e !== null)
      .slice(0, MAX_HISTORY_ENTRIES);
  } catch {
    return [];
  }
}

/**
 * Keeps the node's history (the newest MAX_HISTORY_ENTRIES); a node with nothing to list keeps nothing. Without storage
 * it lasts until the page closes.
 */
export function saveHistory(store: KeyValueStore | null, network: string, nodeId: string, entries: readonly ActivityEntry[]): void {
  try {
    const key = historyKey(network, nodeId);
    if (entries.length === 0) store?.removeItem(key);
    else store?.setItem(key, JSON.stringify(entries.slice(0, MAX_HISTORY_ENTRIES)));
  } catch {
    // Blocked or full storage: the page keeps the list in memory.
  }
}
