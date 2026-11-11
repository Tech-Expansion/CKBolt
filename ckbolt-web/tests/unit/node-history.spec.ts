import { expect, test } from "@playwright/test";
import { itemTitle, type HistoryNames } from "../../components/app/fiber-node/history-list";
import type { SwapState } from "../../lib/hub/contract";
import { historyTone } from "../../lib/status-tone";
import type { SwapRecord } from "../../lib/swap/history";
import type { ActivityEntry } from "../../lib/wallets/fiber-browser/activity";
import {
  findHistoryItem,
  HISTORY_FILTERS,
  invoicesToCancel,
  historyLabel,
  inHistoryFilter,
  isItemFinal,
  itemHoldsNode,
  mergeHistory,
  pollableEntries,
  releasedBySwap,
  type HistoryFilter,
} from "../../lib/wallets/fiber-browser/history";

/*
 * The Fiber node's History (docs/pay-get-paid.md, part E), its pure parts: the node's own entries and the swaps the app
 * kept merged into one list (one entry per swap, by the payment hash or the swap id), how an entry reads (its words and
 * tone), the filters, finding the entry the app's "View in History" names, and the rule that frees the node from a
 * payout invoice whose swap failed. The relay's open-entry message is tested with the relay in fiber-wallet-popup.spec.ts.
 */

const SHANNONS = BigInt(100_000_000);
const ckb = (whole: number): string => (BigInt(whole) * SHANNONS).toString();
const NOW = Date.parse("2026-10-30T10:00:00Z");
const HASH = "ab".repeat(32);
const SWAP_ID = "22222222-2222-4222-8222-222222222222";
const NAMES: HistoryNames = {
  amount: (asset, amount) => `${Number(BigInt(amount) / SHANNONS).toLocaleString("en-US")} ${asset}`,
  symbol: (asset) => asset,
  look: (asset) => ({ symbol: asset, name: asset, icons: [] }),
  peer: (id) => id.slice(0, 6),
};

/** The app's record of a BTC to CKB swap: 2,526 sats for 1,000 CKB, as the hub wrote it (the hash bare). */
const record = (o: Partial<SwapRecord> = {}): SwapRecord => ({
  id: SWAP_ID,
  direction: "ln_to_fiber",
  asset: "CKB",
  symbol: "CKB",
  paymentHash: HASH,
  pay: { network: "lightning", asset: "BTC", amount: "2526", decimals: 0 },
  receive: { network: "fiber", asset: "CKB", amount: ckb(1_000), decimals: 8 },
  createdAt: new Date(NOW + 1_000).toISOString(),
  state: "pending",
  refunded: false,
  funded: false,
  ...o,
});

/** The node's leg of a swap: its payout invoice (BTC to CKB, made before the swap had an id), or its payment of the hold invoice. */
const leg = (o: Partial<ActivityEntry> = {}, kind: "invoice" | "payment" = "invoice"): ActivityEntry => ({
  id: `0x${HASH}`,
  kind: "swap",
  asset: "CKB",
  amount: ckb(1_000),
  status: kind === "invoice" ? "Open" : "Inflight",
  error: null,
  at: NOW,
  swap: { id: kind === "invoice" ? null : SWAP_ID, leg: kind, lightningSats: kind === "invoice" ? null : "2526" },
  ...o,
});

const entry = (kind: ActivityEntry["kind"], id: string, at: number, o: Partial<ActivityEntry> = {}): ActivityEntry => ({
  id,
  kind,
  asset: "CKB",
  amount: ckb(5),
  status: kind === "withdraw" ? "Sent" : "Open",
  error: null,
  at,
  ...(kind === "payment" ? { status: "Success", payment: { maxFee: ckb(1), payee: null } } : {}),
  ...(kind === "request" ? { request: { note: null, expiresAt: at + 3_600_000 } } : {}),
  ...(kind === "channel" ? { channel: { action: "open" as const, channelId: null, readyBefore: 0 } } : {}),
  ...o,
});

test.describe("one list: the node's entries and the swaps the app kept", () => {
  test("a swap is one entry: the node's leg and the app's record share the payment hash (0x or bare, any case)", () => {
    const items = mergeHistory([leg({ id: `0x${HASH.toUpperCase()}` })], [record()]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: `0x${HASH}`, kind: "swap", at: NOW, swap: { id: SWAP_ID } });
    expect(items[0].entry?.swap?.leg).toBe("invoice");
    // It reads by both its sides once the app's record is there; by the node's leg alone before.
    expect(itemTitle(items[0], NAMES)).toBe("Swap: 2,526 sats → 1,000 CKB");
    expect(itemTitle(mergeHistory([leg()], [])[0], NAMES)).toBe("Swap: payout of 1,000 CKB");
  });

  test("a leg whose hash differs is still joined to its swap by the id the node learned (a CKB to BTC payment)", () => {
    const items = mergeHistory([leg({ id: `0x${"cd".repeat(32)}` }, "payment")], [record({ direction: "fiber_to_ln" })]);
    expect(items).toHaveLength(1);
    expect(items[0].swap?.id).toBe(SWAP_ID);
  });

  test("a swap the node has no leg of (the own node's), and a leg the app has no record of, each show once; newest first", () => {
    const own = record({ id: "33333333-3333-4333-8333-333333333333", paymentHash: "ef".repeat(32), createdAt: new Date(NOW + 60_000).toISOString() });
    const items = mergeHistory(
      [entry("withdraw", `0x${"12".repeat(32)}`, NOW + 30_000), leg({ id: `0x${"99".repeat(32)}`, at: NOW - 60_000 }), entry("payment", `0x${"34".repeat(32)}`, NOW + 120_000)],
      [own],
    );
    expect(items.map((i) => [i.kind, i.entry !== null, i.swap !== null])).toEqual([
      ["payment", true, false],
      ["swap", false, true],
      ["withdraw", true, false],
      ["swap", true, false],
    ]);
    expect(items[1].key).toBe(`0x${"ef".repeat(32)}`);
    expect(new Set(items.map((i) => i.key)).size).toBe(items.length);
  });

  test("a swap reads by how it stands at the hub, in its tone; anything else by the node's own status", () => {
    const read = (o: Partial<SwapRecord>) => {
      const [item] = mergeHistory([leg()], [record(o)]);
      return [historyLabel(item), historyTone(item), isItemFinal(item)];
    };
    expect(read({ state: "pending" })).toEqual(["In progress", "pending", false]);
    expect(read({ state: "outgoing_in_flight", funded: true })).toEqual(["In progress", "pending", false]);
    expect(read({ state: "succeeded", funded: true })).toEqual(["Completed", "ok", true]);
    // The payment came back (amber: nothing to fix), or is on its way back.
    expect(read({ state: "failed", funded: true, refunded: true })).toEqual(["Refunded", "pending", true]);
    expect(read({ state: "failed", funded: true, refunded: false })).toEqual(["Refunding", "pending", false]);
    // Nothing was paid (an expired request, an abandoned run): cancelled, grey.
    expect(read({ state: "failed", refunded: true })).toEqual(["Cancelled", "off", true]);
    expect(read({ state: "failed", refunded: false })).toEqual(["Cancelling", "pending", false]);
    const [alone] = mergeHistory([leg({ status: "Paid" })], []);
    expect([historyLabel(alone), historyTone(alone), isItemFinal(alone)]).toEqual(["Received", "ok", true]);
    const [payment] = mergeHistory([entry("payment", `0x${"34".repeat(32)}`, NOW, { status: "Failed", error: "No route" })], []);
    expect([historyLabel(payment), historyTone(payment)]).toEqual(["Failed", "error"]);
  });

  test("filters: All; Payments are Pay's Fiber payments and Get paid's requests; Swaps; Channels; Funds are what left on chain", () => {
    const items = mergeHistory(
      [
        leg(),
        entry("payment", `0x${"34".repeat(32)}`, NOW + 1),
        entry("request", `0x${"56".repeat(32)}`, NOW + 2),
        entry("channel", "channel-1", NOW + 3),
        entry("withdraw", `0x${"78".repeat(32)}`, NOW + 4),
      ],
      [record(), record({ id: "33333333-3333-4333-8333-333333333333", paymentHash: "ef".repeat(32) })],
    );
    const kinds = (filter: HistoryFilter) => items.filter((i) => inHistoryFilter(i, filter)).map((i) => i.kind);
    expect(HISTORY_FILTERS).toEqual(["all", "payments", "swaps", "channels", "funds"]);
    expect(kinds("all")).toHaveLength(6);
    expect(kinds("payments")).toEqual(["request", "payment"]);
    expect(kinds("swaps")).toEqual(["swap", "swap"]);
    expect(kinds("channels")).toEqual(["channel"]);
    expect(kinds("funds")).toEqual(["withdraw"]);
  });
});

test.describe("View in History finds its entry", () => {
  const withdrawal = `0x${"78".repeat(32)}`;
  const items = mergeHistory([leg(), entry("withdraw", withdrawal, NOW + 4), entry("payment", `0x${"34".repeat(32)}`, NOW + 5)], [record()]);

  test("a swap by its id (the app's record, or the id the node's leg learned), in any case", () => {
    expect(findHistoryItem(items, { id: SWAP_ID, hash: null })?.key).toBe(`0x${HASH}`);
    expect(findHistoryItem(items, { id: SWAP_ID.toUpperCase(), hash: null })?.key).toBe(`0x${HASH}`);
    const legOnly = mergeHistory([leg({}, "payment")], []);
    expect(findHistoryItem(legOnly, { id: SWAP_ID, hash: null })?.entry?.swap?.leg).toBe("payment");
  });

  test("anything by its hash: a payment hash, or an on-chain send's transaction", () => {
    expect(findHistoryItem(items, { id: null, hash: `0x${HASH.toUpperCase()}` })?.kind).toBe("swap");
    expect(findHistoryItem(items, { id: null, hash: HASH })?.kind).toBe("swap");
    expect(findHistoryItem(items, { id: null, hash: withdrawal })?.kind).toBe("withdraw");
    expect(findHistoryItem(items, { id: null, hash: `0x${"34".repeat(32)}` })?.kind).toBe("payment");
    // An unknown id falls back to the hash; neither known, nothing.
    expect(findHistoryItem(items, { id: "33333333-3333-4333-8333-333333333333", hash: withdrawal })?.kind).toBe("withdraw");
    expect(findHistoryItem(items, { id: null, hash: `0x${"00".repeat(32)}` })).toBeNull();
    expect(findHistoryItem(items, { id: null, hash: "channel-1" })).toBeNull();
  });
});

test.describe("a payout invoice whose swap failed no longer holds the node", () => {
  const holds = (l: ActivityEntry, r: SwapRecord | null) => itemHoldsNode(mergeHistory([l], r ? [r] : [])[0]);
  const polled = (l: ActivityEntry, r: SwapRecord | null) => pollableEntries([l], r ? [r] : []).length === 1;

  test("BTC to CKB: the node's invoice waits for the payout while the swap runs, and is done once the hub's swap failed", () => {
    // No record yet, or a swap under way: the node must stay online to be paid.
    expect([holds(leg(), null), polled(leg(), null)]).toEqual([true, true]);
    for (const state of ["pending", "incoming_accepted", "outgoing_in_flight"] as SwapState[]) {
      expect([holds(leg(), record({ state })), polled(leg(), record({ state }))], state).toEqual([true, true]);
    }
    // Cancelled unpaid (an abandoned run, Get paid's "New invoice"), refunding or refunded: no payer will come, so it is
    // final, neither holding Lock and the page nor read again for the hour the invoice stays open.
    for (const failed of [record({ state: "failed", refunded: true }), record({ state: "failed" }), record({ state: "failed", funded: true, refunded: true })]) {
      expect(releasedBySwap(leg(), failed)).toBe(true);
      expect([holds(leg(), failed), polled(leg(), failed)]).toEqual([false, false]);
    }
  });

  test("only a still-open invoice is freed: a payout on its way in keeps the node, and a payment ends by its own status", () => {
    const failed = record({ state: "failed", refunded: true });
    expect(holds(leg({ status: "Received" }), failed)).toBe(true);
    // CKB to BTC: the node's payment of the hold invoice settles or fails by itself (the hub cancels the hold).
    const paying = leg({}, "payment");
    expect([holds(paying, record({ direction: "fiber_to_ln", state: "failed", funded: true })), releasedBySwap(paying, failed)]).toEqual([true, false]);
    expect(holds(leg({ status: "Failed" }, "payment"), failed)).toBe(false);
    // A Pay payment or a Get paid invoice is no swap leg: the rule does not touch them.
    expect(releasedBySwap(entry("payment", `0x${HASH}`, NOW, { status: "Inflight" }), failed)).toBe(false);
    expect(releasedBySwap(entry("request", `0x${HASH}`, NOW), failed)).toBe(false);
  });
});

test.describe("a Get paid request is paid once: the node cancels its other invoices", () => {
  const REQUEST_ID = "44444444-4444-4444-8444-444444444444";
  const FIBER_HASH = `0x${"56".repeat(32)}`;
  /** The request's Fiber invoice. */
  const fiberInvoice = (status: ActivityEntry["status"], id: string | null = REQUEST_ID) =>
    entry("request", FIBER_HASH, NOW, { status, request: { note: null, expiresAt: NOW + 3_600_000, ...(id ? { id } : {}) } });
  /** The payout invoice of the request's Lightning invoice (the node made it; its swap pays it). */
  const payout = (status: ActivityEntry["status"], o: { hash?: string; request?: string | null } = {}) =>
    leg({ id: o.hash ?? `0x${HASH}`, status, swap: { id: null, leg: "invoice", lightningSats: null, ...(o.request === null ? {} : { request: o.request ?? REQUEST_ID }) } });
  const ids = (list: readonly ActivityEntry[]) => list.map((e) => e.id);

  test("paid on Lightning (the swap paid the node out, or its payout invoice reads Paid): the Fiber invoice still open is cancelled", () => {
    for (const state of ["outgoing_succeeded", "succeeded"] as SwapState[]) {
      expect(ids(invoicesToCancel([fiberInvoice("Open"), payout("Open")], [record({ state })])), state).toEqual([FIBER_HASH]);
    }
    expect(ids(invoicesToCancel([fiberInvoice("Open"), payout("Paid")], []))).toEqual([FIBER_HASH]);
    // Not before the payout went through.
    for (const state of ["pending", "incoming_accepted", "outgoing_in_flight", "failed"] as SwapState[]) {
      expect(invoicesToCancel([fiberInvoice("Open"), payout("Open")], [record({ state })]), state).toEqual([]);
    }
  });

  test("paid on Fiber: the payout invoices of the request's Lightning invoices still open are cancelled, so the hub refunds a late payer", () => {
    const renewed = payout("Open", { hash: `0x${"9a".repeat(32)}` });
    expect(ids(invoicesToCancel([fiberInvoice("Paid"), payout("Open"), renewed], []))).toEqual([`0x${HASH}`, `0x${"9a".repeat(32)}`]);
  });

  test("only what is still open, only this request's, and nothing for entries kept without a request", () => {
    // A payout already arriving cannot be cancelled (fnn refuses once a payment arrived): both payments stand.
    expect(invoicesToCancel([fiberInvoice("Paid"), payout("Received")], [])).toEqual([]);
    // Expired, cancelled or paid invoices are left as they are; a paid one is never cancelled.
    for (const status of ["Expired", "Cancelled", "Paid"] as const) expect(invoicesToCancel([fiberInvoice(status), payout("Paid")], []), status).toEqual([]);
    // Another request's invoices, a swap's own payout invoice and a request kept before ids are untouched.
    const other = "55555555-5555-4555-8555-555555555555";
    expect(invoicesToCancel([fiberInvoice("Open", other), payout("Paid")], [])).toEqual([]);
    expect(invoicesToCancel([fiberInvoice("Paid"), payout("Open", { request: null })], [])).toEqual([]);
    expect(invoicesToCancel([fiberInvoice("Open", null), payout("Paid", { request: null })], [])).toEqual([]);
    // Nothing paid yet: nothing to cancel.
    expect(invoicesToCancel([fiberInvoice("Open"), payout("Open")], [record()])).toEqual([]);
    // The payout invoice whose swap paid out is the paid one, never cancelled, even before the node read it Paid.
    expect(ids(invoicesToCancel([fiberInvoice("Open"), payout("Open")], [record({ state: "succeeded" })]))).not.toContain(`0x${HASH}`);
  });
});
