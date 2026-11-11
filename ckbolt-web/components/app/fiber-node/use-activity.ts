"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FiberAssetId } from "@/lib/hub/contract";
import {
  isRecordFinal,
  keepSwapRecord,
  readSwapHistory,
  readSwapRecord,
  SWAP_HISTORY,
  swapHistoryKey,
  unknownToHub,
  type SwapReader,
  type SwapRecord,
} from "@/lib/swap/history";
import {
  isPaymentEntry,
  readHistory,
  reconcileChannels,
  saveHistory,
  upsertActivity,
  withPayment,
  type ActivityEntry,
} from "@/lib/wallets/fiber-browser/activity";
import { invoicesToCancel, itemHoldsNode, mergeHistory, pollableEntries, type HistoryItem } from "@/lib/wallets/fiber-browser/history";
import type { BrowserFiberNode, NodeChannel } from "@/lib/wallets/fiber-browser/node-port";
import { webStore } from "@/lib/wallets/fiber-browser/storage";
import { NODE_TIMING } from "@/lib/wallets/fiber-browser/constants";
import { usePolling } from "./use-polling";

export interface Activity {
  /** The node's own entries, newest first (the bridge reads them). */
  entries: ActivityEntry[];
  /** History: the node's entries and the swaps the app kept, merged (lib/wallets/fiber-browser/history.ts). */
  items: HistoryItem[];
  record: (entry: ActivityEntry) => void;
  /** Keeps a swap as the hub reported it (History's detail reads it while it is open). */
  keepSwap: (record: SwapRecord) => void;
  /**
   * Something still needs the node: a swap's invoice waiting for its payout (unless its swap failed), or a payment (a
   * swap's or Pay's) in flight.
   */
  busy: boolean;
}

export interface ActivityContext {
  network: string;
  /** The node the history belongs to: the running one, or the one whose key is stored. Null before any is known. */
  nodeId: string | null;
  /** The node's channels now, to see channel entries open or close. */
  channels: readonly NodeChannel[];
  assetOf: (channel: Pick<NodeChannel, "udtTypeScript">) => FiberAssetId | null;
  /** The hub, to read the swaps not final yet. */
  hub: SwapReader;
}

/** A swap leg's or a payment's status as the node reports it (its id is the payment hash); null when the read failed. */
async function refreshed(node: BrowserFiberNode, entry: ActivityEntry): Promise<ActivityEntry | null> {
  try {
    return isPaymentEntry(entry) ? withPayment(entry, await node.getPayment(entry.id)) : { ...entry, status: await node.getInvoiceStatus(entry.id) };
  } catch {
    // Kept as it is; the next read may answer.
    return null;
  }
}

/**
 * A read that started from `before` lands only if nothing newer was recorded meanwhile: send_payment's own answer (or its
 * failure) recorded while get_payment was on its way must not be overwritten by the older read.
 */
export function landRead(entries: readonly ActivityEntry[], before: ActivityEntry, after: ActivityEntry): ActivityEntry[] {
  const current = entries.find((e) => e.id === before.id);
  if (!current || current.status !== before.status || current.error !== before.error) return entries as ActivityEntry[];
  return upsertActivity(entries, after);
}

/**
 * The node's History: its own entries (lib/wallets/fiber-browser/activity.ts), kept in this browser per network and
 * node, so they last across reloads and are the same in the popup and on the node page, merged with the swaps the app
 * kept (lib/swap/history.ts, same storage: the app page writes them, and a write there reaches this document as a
 * storage event). A swap's invoice or payment under way, or a payment from Pay, is read again until done, also after a
 * reload (its hash was kept before send_payment); channels are matched against the node's channels; the swaps not
 * final yet are read from the hub while this document runs the node. While a swap or a payment still needs the node,
 * leaving the page asks first: the node must stay online to receive a payout or to finish a payment. A payout invoice
 * whose swap failed needs it no more. A Get paid request paid one way has its other invoices cancelled here.
 */
export function useActivity(node: BrowserFiberNode | null, ctx: ActivityContext): Activity {
  const { network, nodeId, channels, assetOf, hub } = ctx;
  const store = useMemo(() => webStore("localStorage"), []);
  // Entries with the node they belong to, so one node's list is never saved under another's id.
  const [history, setHistory] = useState<{ owner: string | null; entries: ActivityEntry[] }>({ owner: null, entries: [] });

  useEffect(() => {
    if (nodeId && history.owner !== nodeId) setHistory({ owner: nodeId, entries: readHistory(store, network, nodeId) });
  }, [nodeId, history.owner, store, network]);
  useEffect(() => {
    if (history.owner) saveHistory(store, network, history.owner, history.entries);
  }, [history, store, network]);

  const record = useCallback((entry: ActivityEntry) => setHistory((h) => ({ ...h, entries: upsertActivity(h.entries, entry) })), []);
  const entries = history.entries;

  // The swaps the app kept: read now, again whenever the app page (or another tab) writes them.
  const [records, setRecords] = useState<SwapRecord[]>([]);
  useEffect(() => {
    const key = swapHistoryKey(network);
    const read = () => setRecords(readSwapHistory(store, network));
    read();
    const onStorage = (event: StorageEvent) => {
      if (event.key === key || event.key === null) read();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [store, network]);
  const keepSwap = useCallback((next: SwapRecord) => setRecords(keepSwapRecord(store, network, next)), [store, network]);

  const items = useMemo(() => mergeHistory(entries, records), [entries, records]);
  const polled = useMemo(() => pollableEntries(entries, records), [entries, records]);
  const busy = items.some(itemHoldsNode);

  // Swaps not final yet, read from the hub by the document that runs the node; one the hub does not know is left be.
  const unknown = useRef(new Set<string>());
  const open = records.filter((r) => !isRecordFinal(r) && !unknown.current.has(r.id));
  usePolling(
    async () => {
      for (const r of open) {
        try {
          keepSwap((await readSwapRecord(hub, r)).record);
        } catch (e) {
          if (unknownToHub(e)) unknown.current.add(r.id);
        }
      }
    },
    SWAP_HISTORY.refreshMs,
    node !== null && open.length > 0,
  );

  // A Get paid request paid one way: its other invoices still open are cancelled, so it is not paid twice. Tried again on
  // the next pass if fnn did not answer; once it refuses (a payment arrived meanwhile), the next read moves the entry.
  const toCancel = useMemo(() => invoicesToCancel(entries, records), [entries, records]);
  const cancelling = useRef(new Set<string>());
  usePolling(
    async () => {
      if (!node) return;
      for (const entry of toCancel) {
        if (cancelling.current.has(entry.id)) continue;
        cancelling.current.add(entry.id);
        try {
          const status = await node.cancelInvoice(entry.id);
          setHistory((h) => ({ ...h, entries: landRead(h.entries, entry, { ...entry, status }) }));
        } catch {
          // Paid, received or cancelled meanwhile: the node's next read says which.
        } finally {
          cancelling.current.delete(entry.id);
        }
      }
    },
    NODE_TIMING.nodePollMs,
    node !== null && toCancel.length > 0,
  );

  usePolling(
    async () => {
      if (!node) return;
      const reads = await Promise.all(polled.map((e) => refreshed(node, e)));
      setHistory((h) => {
        let next = h.entries;
        reads.forEach((after, i) => {
          if (after) next = landRead(next, polled[i], after);
        });
        return next === h.entries ? h : { ...h, entries: next };
      });
    },
    NODE_TIMING.nodePollMs,
    node !== null && polled.length > 0,
  );

  // Channels opening or closing: done once the node's channels say so.
  useEffect(() => {
    setHistory((h) => {
      const next = reconcileChannels(h.entries, channels, assetOf);
      return next.some((e, i) => e !== h.entries[i]) ? { ...h, entries: next } : h;
    });
  }, [channels, assetOf]);

  useEffect(() => {
    if (!busy) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older browsers need a value to show their prompt.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [busy]);

  return { entries, items, record, keepSwap, busy };
}
