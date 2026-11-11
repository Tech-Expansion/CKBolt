import { test as base, expect, type BrowserContext, type Page } from "@playwright/test";
import { apiError } from "./fakes/hub";
import { expectNoHorizontalOverflow, expectNoSeriousAxe } from "./page-checks";
import { hubChannel, installFakeNode, nodeCalls, nodeInvoiceHash, openRunningNode, settleNodeInvoice, shareNodeHash, units } from "./support/fiber-node";
import { NODE_POLL_TIMEOUT_MS, WALLET_TIMEOUT_MS } from "./support/fiber-wallet";
import { isolate, LiveHub } from "./support/live-hub";
import { STEP_TIMEOUT_MS } from "./support/swap-card";

/*
 * Get paid on /app (docs/pay-get-paid.md, part C), with the fake hub (support/live-hub.ts) and the browser node's fake
 * fiber-js (support/fiber-node.ts) running in the node page next to /app (a request needs no Confirm in the node, so no
 * popup is needed and every browser runs it): the form's conversion from the hub's request quote; "Create request"
 * makes the Fiber invoice (the node's own) and opens on it; the Lightning invoice (an ln_to_fiber swap on a request
 * quote, whose payout invoice the node made) is made only when its tab opens; paid on Lightning through the hub, or on
 * Fiber (the node's invoice settled), each ends in the receipt, and a second payment is not hidden; the page cancels an
 * unpaid Lightning invoice's swap at the hub with its cancel token (kept in memory only) once the request is paid on
 * Fiber, "New request" or "New invoice"; a failed cancel leaves the node's pairing to close it; the refusals; axe and
 * a 390 px screen. Nothing reaches a real network.
 */

const TEST_TIMEOUT_MS = 150_000;
/** The page asks the node tab for its status every 5 s. */
const NODE_STATUS_TIMEOUT_MS = 15_000;
/** The page reads the Fiber invoice's status every 3 s. */
const STATUS_TIMEOUT_MS = 15_000;
const PHONE = { width: 390, height: 844 };
/** As the fake hub prices it (1 BTC = 40,000,000 CKB, 1 % fee): 1,000 CKB received costs a Lightning payer 2,526 sats. */
const REQUEST = { ckb: "1000", ckbText: "1,000 CKB", units: "100000000000", sats: "2,526", usd: "≈ $2.00" } as const;
const CONVERSION = `${REQUEST.usd} · ${REQUEST.sats} sats on Lightning`;
/** The quote Get paid asks for, for the conversion line and for the Lightning invoice: a request quote. */
const REQUEST_QUOTE = { direction: "ln_to_fiber", asset: "CKB", side: "receive", amount: REQUEST.units, purpose: "request" } as const;
/** The Lightning panel's line: the payer pays BTC, the requester receives CKB. */
const LIGHTNING_LINE = "They pay BTC on Lightning. You receive CKB.";
/** A short request quote, so the Lightning invoice expires within the test. */
const SHORT_QUOTE_TTL_MS = 12_000;
/** The fake's request quotes, as the hub's REQUEST_QUOTE_TTL_SECONDS default: 15 minutes. */
const REQUEST_QUOTE_TTL_MS = 900_000;

const test = base.extend<{ hub: LiveHub }>({
  hub: async ({ context }, use) => {
    await isolate(context);
    const hub = new LiveHub();
    await hub.install(context);
    await use(hub);
  },
});

/** The Get paid tab and its parts. */
const getPaid = (page: Page) => {
  const id = (testId: string) => page.getByTestId("mode-receive").getByTestId(testId);
  return {
    card: id("request-card"),
    form: id("request-form"),
    amount: id("request-amount"),
    asset: id("request-asset"),
    note: id("request-note"),
    conversion: id("request-conversion"),
    create: id("request-create"),
    error: id("request-error"),
    summary: id("request-summary"),
    tabs: id("request-tabs"),
    lightningTab: id("request-tab-lightning"),
    fiberTab: id("request-tab-fiber"),
    lightning: id("request-lightning"),
    fiber: id("request-fiber"),
    countdown: id("request-countdown"),
    paid: id("request-paid"),
    reset: id("request-reset"),
  };
};

async function openGetPaid(page: Page) {
  await page.goto("/app?mode=receive");
  await expect(getPaid(page).card).toBeVisible({ timeout: WALLET_TIMEOUT_MS });
}

/** A running node next to /app that can receive 20,000 CKB from the hub, and Get paid open on /app. */
async function withNode(page: Page, receiveCkb = 20_000) {
  const context = page.context();
  await installFakeNode(context, { channels: [hubChannel({ local: units(0), remote: units(receiveCkb) })] });
  const node = await openRunningNode(context);
  await page.bringToFront();
  await openGetPaid(page);
  return node;
}

/** Fills the form for 1,000 CKB with `note` and creates the request: it opens on its Fiber invoice. */
async function createRequest(page: Page, note = "") {
  const g = getPaid(page);
  await g.amount.fill(REQUEST.ckb);
  if (note) await g.note.fill(note);
  await expect(g.conversion).toHaveText(CONVERSION, { timeout: STEP_TIMEOUT_MS });
  await expect(g.create).toBeEnabled({ timeout: NODE_STATUS_TIMEOUT_MS });
  await g.create.click();
  await expect(g.form).toHaveCount(0);
  await expect(g.fiber.getByTestId("request-fiber-qr")).toBeVisible({ timeout: STEP_TIMEOUT_MS });
}

/** Opens the Lightning tab, which makes the request's Lightning invoice, and waits for its QR code. */
async function openLightning(page: Page) {
  const g = getPaid(page);
  await g.lightningTab.click();
  await expect(g.lightning.getByTestId("request-lightning-qr")).toBeVisible({ timeout: STEP_TIMEOUT_MS });
}

/** Records every bridge message each page of `context` sends (BroadcastChannel), to show what crosses to the node. */
async function recordBridge(context: BrowserContext) {
  await context.addInitScript(() => {
    const log: string[] = [];
    (window as unknown as { __bridgeLog: string[] }).__bridgeLog = log;
    const post = BroadcastChannel.prototype.postMessage;
    BroadcastChannel.prototype.postMessage = function (message: unknown) {
      try {
        log.push(JSON.stringify(message));
      } catch {
        log.push(String(message));
      }
      return post.call(this, message);
    };
  });
}

/** Everything a page keeps or sends to the node: its localStorage, sessionStorage and bridge messages, as text. */
const kept = (page: Page) =>
  page.evaluate(() => ({
    storage: JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
    bridge: (window as unknown as { __bridgeLog?: string[] }).__bridgeLog ?? [],
  }));

/** The cancel token is in none of the pages' storage, nor in any message on the bridge between the page and the node. */
async function expectTokenNowhere(pages: Page[], token: string) {
  expect(token).toMatch(/^[0-9a-f]{64}$/);
  for (const page of pages) {
    const { storage, bridge } = await kept(page);
    expect(storage).not.toContain(token);
    expect(bridge.join("\n")).not.toContain(token);
  }
}

/* ======================================================================================= a request, paid */

test.describe("Get paid: a request with a Fiber invoice, and a Lightning invoice made when its tab opens", () => {
  test("the conversion from a request quote; Create makes the Fiber invoice and opens on it; the Lightning tab makes the Lightning invoice; paid on Lightning: the receipt", async ({
    page,
    hub,
  }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    const node = await withNode(page);
    const g = getPaid(page);
    await g.amount.fill(REQUEST.ckb);
    await expect(g.conversion).toHaveText(CONVERSION, { timeout: STEP_TIMEOUT_MS });
    expect(hub.quoteBodies.at(-1)).toEqual(REQUEST_QUOTE);
    await g.note.fill("Table 4");
    await expect(g.create).toBeEnabled({ timeout: NODE_STATUS_TIMEOUT_MS });
    const quotesBefore = hub.quoteBodies.length;
    await g.create.click();

    // The request: what it asks for, and two tabs, Fiber first and open.
    await expect(g.summary).toContainText(REQUEST.ckbText);
    await expect(g.summary).toContainText("Table 4");
    await expect(g.tabs.getByRole("tab")).toHaveText([/^Fiber/, /^Lightning/]);
    await expect(g.fiberTab).toHaveAttribute("aria-selected", "true");
    await expect(g.fiber.getByTestId("request-fiber-qr")).toBeVisible({ timeout: STEP_TIMEOUT_MS });
    await expect(g.fiber.getByTestId("request-fiber-copy")).toBeVisible();
    await expect(g.fiber).toContainText("Valid until");
    await expect(g.fiberTab).toHaveAttribute("data-status", "waiting");
    // No Lightning invoice yet: no quote, no swap at the hub, one invoice from the node, valid an hour.
    await expect(g.lightningTab).toHaveAttribute("data-status", "idle");
    await expect(g.lightningTab).toContainText("Not made yet");
    expect(hub.quoteBodies.length).toBe(quotesBefore);
    expect(hub.swapBodies).toEqual([]);
    await expect.poll(async () => (await nodeCalls(node, "new_invoice")).length).toBe(1);
    expect((await nodeCalls(node, "new_invoice"))[0]).toMatchObject({
      amount: "0x174876e800",
      description: "Table 4",
      expiry: "0xe10",
      hash_algorithm: "sha256",
      currency: "Fibt",
    });
    const fiberHash = await nodeInvoiceHash(node, (await g.fiber.getByTestId("request-fiber-text").textContent())!);

    // Opening the Lightning tab makes it: a request quote, the node's payout invoice, then the swap with the hub.
    await openLightning(page);
    expect(hub.quoteBodies.slice(quotesBefore)).toEqual([REQUEST_QUOTE]);
    expect(hub.lastQuote.purpose).toBe("request");
    expect(hub.swapBodies).toEqual([expect.objectContaining({ quoteId: hub.lastQuote.id })]);
    const holdInvoice = hub.current.pay.invoice;
    await expect(g.lightning).toContainText(LIGHTNING_LINE);
    await expect(g.lightning.getByTestId("request-lightning-text")).toHaveText(holdInvoice);
    await expect(g.lightning.getByTestId("request-lightning-open")).toHaveAttribute("href", `lightning:${holdInvoice}`);
    await expect(g.lightning.getByTestId("request-lightning-copy")).toBeVisible();
    await expect(g.lightning).toContainText(`${REQUEST.sats} sats`);
    // The countdown starts at the request quote's 15 minutes, not a swap quote's few.
    await expect(g.countdown).toHaveText(/^\d+s$/);
    const seconds = Number((await g.countdown.textContent())?.replace("s", ""));
    expect(seconds).toBeGreaterThan(REQUEST_QUOTE_TTL_MS / 1_000 - 60);
    expect(seconds).toBeLessThanOrEqual(REQUEST_QUOTE_TTL_MS / 1_000 + 1);
    await expect(g.lightningTab).toHaveAttribute("data-status", "waiting");
    await expect(g.lightningTab).toContainText("Waiting");

    // The node made two invoices for exactly the amount: the Fiber invoice and the swap's payout invoice.
    await expect.poll(async () => (await nodeCalls(node, "new_invoice")).length).toBe(2);
    const made = await nodeCalls(node, "new_invoice");
    expect(made.map((m) => m?.amount)).toEqual(["0x174876e800", "0x174876e800"]);
    expect(made.map((m) => m?.description).sort()).toEqual(["CKBolt swap payout", "Table 4"]);
    // Making an invoice spends nothing: nothing was paid, nothing asked the visitor to confirm.
    expect(await nodeCalls(node, "send_payment")).toEqual([]);
    // Both legs of the swap share the node's payment hash, as with the real hub.
    await shareNodeHash(hub, node);
    // Going back and forth makes nothing more.
    await g.fiberTab.click();
    await g.lightningTab.click();
    await expect(g.lightning.getByTestId("request-lightning-qr")).toBeVisible();
    expect(hub.swapBodies).toHaveLength(1);

    // A Lightning payer pays: the hub holds it, pays the node, settles.
    hub.holdPayment();
    await expect(g.lightningTab).toHaveAttribute("data-status", "arriving", { timeout: STEP_TIMEOUT_MS });
    await expect(g.lightning).toContainText("Payment held. The hub is paying your node…");
    hub.startPayout();
    hub.settle();
    await expect(g.paid).toBeVisible({ timeout: STEP_TIMEOUT_MS });
    await expect(g.paid).toHaveAttribute("data-count", "1");
    await expect(g.paid).toContainText("Paid");
    await expect(g.paid).toContainText(REQUEST.ckbText);
    await expect(g.paid).toContainText(`Lightning, ${REQUEST.sats} sats`);
    await expect(g.summary).toContainText("Table 4");
    // The receipt replaces the QR codes.
    await expect(g.tabs).toHaveCount(0);

    // The node's History has the request's Fiber invoice, and the Lightning invoice's swap once: its payout leg and the
    // swap the app kept are one entry, completed.
    const list = node.getByTestId("fiber-node-activity-list");
    await expect(list.locator('[data-testid="history-entry"][data-kind="request"]')).toContainText("Request for 1,000 CKB", { timeout: NODE_POLL_TIMEOUT_MS });
    const swap = list.locator('[data-testid="history-entry"][data-kind="swap"]');
    await expect(swap).toHaveCount(1);
    await expect(swap).toContainText(`Swap: ${REQUEST.sats} sats → ${REQUEST.ckbText}`);
    await expect(swap).toContainText("Completed");
    // The node runs in its own tab, not in the header's popup: no "View in History" here.
    await expect(g.paid.getByTestId("history-entry-view")).toHaveCount(0);
    // Paid on Lightning: the node cancelled the request's Fiber invoice, so nobody can pay the request twice.
    await expect.poll(() => nodeCalls(node, "cancel_invoice"), { timeout: NODE_POLL_TIMEOUT_MS }).toEqual([{ payment_hash: fiberHash }]);
    const request = list.locator('[data-testid="history-entry"][data-kind="request"]');
    await expect(request).toHaveAttribute("data-status", "Cancelled", { timeout: NODE_POLL_TIMEOUT_MS });
    await expect(request).toContainText("Cancelled");

    // A paid Lightning invoice is never cancelled at the hub, not even by "New request".
    await g.reset.click();
    await expect(g.form).toBeVisible();
    await expect(g.amount).toHaveValue("");
    expect(hub.count("POST /v1/swaps/:id/cancel")).toBe(0);
  });

  test("paid on Fiber before anyone opened the Lightning tab: the hub never made a swap for the request", async ({ page, hub }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    const node = await withNode(page);
    const g = getPaid(page);
    await createRequest(page);
    const quotes = hub.quoteBodies.length;
    const fiberInvoice = (await g.fiber.getByTestId("request-fiber-text").textContent())!;
    await settleNodeInvoice(node, fiberInvoice, "Paid");
    await expect(g.paid).toBeVisible({ timeout: STATUS_TIMEOUT_MS });
    await expect(g.paid.getByTestId("request-payment")).toHaveAttribute("data-network", "fiber");
    expect(hub.quoteBodies.length).toBe(quotes);
    expect(hub.swapBodies).toEqual([]);
    expect(await nodeCalls(node, "new_invoice")).toHaveLength(1);
    await g.reset.click();
    await expect(g.form).toBeVisible();
    expect(hub.count("POST /v1/swaps/:id/cancel")).toBe(0);
    expect(await nodeCalls(node, "cancel_invoice")).toEqual([]);
  });

  test("paid on Fiber while the Lightning invoice is open: the page cancels its swap at the hub with its token, which never leaves the page's memory; the node cancels the payout invoice too", async ({
    page,
    context,
    hub,
  }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    await recordBridge(context);
    const node = await withNode(page);
    const g = getPaid(page);
    await createRequest(page);
    await openLightning(page);
    const swapId = hub.current.id;
    const token = hub.cancelTokens.get(swapId)!;
    // Both legs of the swap share the node's payment hash, as with the real hub, so History shows the swap once.
    const payoutHash = await shareNodeHash(hub, node);
    // The bridge carried the node's invoices, but never the token; nor does either page keep it.
    expect((await kept(page)).bridge.length).toBeGreaterThan(0);
    await expectTokenNowhere([page, node], token);

    await g.fiberTab.click();
    const fiberInvoice = await g.fiber.getByTestId("request-fiber-text").textContent();
    expect(fiberInvoice).toMatch(/^fibt1000/);
    await settleNodeInvoice(node, fiberInvoice!, "Received");
    await expect(g.fiberTab).toHaveAttribute("data-status", "arriving", { timeout: STATUS_TIMEOUT_MS });
    expect(hub.cancels).toEqual([]);
    await settleNodeInvoice(node, fiberInvoice!, "Paid");
    await expect(g.paid).toBeVisible({ timeout: STATUS_TIMEOUT_MS });
    await expect(g.paid).toHaveAttribute("data-count", "1");
    await expect(g.paid.getByTestId("request-payment")).toHaveAttribute("data-network", "fiber");
    await expect(g.paid).toContainText(REQUEST.ckbText);

    // The request no longer needs its Lightning invoice: the page cancels the swap at the hub, with its own token, once.
    await expect.poll(() => hub.cancels, { timeout: STEP_TIMEOUT_MS }).toEqual([{ id: swapId, token, status: 200 }]);
    expect(hub.current).toMatchObject({ state: "failed", refunded: true });
    const list = node.getByTestId("fiber-node-activity-list");
    const swap = list.locator('[data-testid="history-entry"][data-kind="swap"]');
    await expect(swap).toHaveCount(1);
    await expect(swap).toContainText("Cancelled", { timeout: NODE_POLL_TIMEOUT_MS });
    const entry = list.locator('[data-testid="history-entry"][data-kind="request"]');
    await expect(entry).toHaveAttribute("data-status", "Paid", { timeout: NODE_POLL_TIMEOUT_MS });
    await expect(entry).toContainText("Received 1,000 CKB");
    // The node still pairs the two: it cancels the payout invoice the Lightning invoice paid into.
    await expect.poll(() => nodeCalls(node, "cancel_invoice"), { timeout: NODE_POLL_TIMEOUT_MS }).toEqual([{ payment_hash: payoutHash }]);
    await expect(g.paid).toHaveAttribute("data-count", "1");
    // "New request" has nothing left to cancel.
    await g.reset.click();
    await expect(g.form).toBeVisible();
    expect(hub.cancels).toHaveLength(1);
    await expectTokenNowhere([page, node], token);
  });

  test("a cancel the hub cannot do is only logged: the node's pairing still closes the Lightning side, so a late payer is refunded", async ({ page, hub }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    const warnings: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "warning") warnings.push(message.text());
    });
    hub.fail("POST /v1/swaps/:id/cancel", { status: 503, body: apiError("upstream_unavailable", "The Lightning node did not answer.") });
    const node = await withNode(page);
    const g = getPaid(page);
    await createRequest(page);
    await openLightning(page);
    const swapId = hub.current.id;
    const token = hub.cancelTokens.get(swapId)!;
    const payoutHash = await nodeInvoiceHash(node, hub.current.receive.invoice);
    await g.fiberTab.click();
    await settleNodeInvoice(node, (await g.fiber.getByTestId("request-fiber-text").textContent())!, "Paid");
    await expect(g.paid).toBeVisible({ timeout: STATUS_TIMEOUT_MS });

    await expect.poll(() => hub.count("POST /v1/swaps/:id/cancel"), { timeout: STEP_TIMEOUT_MS }).toBe(1);
    await expect.poll(() => warnings.find((w) => w.includes(`The hub did not cancel swap ${swapId}`)) ?? null).toContain("The Lightning node did not answer.");
    expect(warnings.join("\n")).not.toContain(token);
    // The node cancels the payout invoice the request's Lightning invoice pays into...
    await expect.poll(() => nodeCalls(node, "cancel_invoice"), { timeout: NODE_POLL_TIMEOUT_MS }).toEqual([{ payment_hash: payoutHash }]);
    expect(await node.evaluate((h) => (window as unknown as { __fakeFiber: { invoices: Record<string, { status: string }> } }).__fakeFiber.invoices[h!].status, payoutHash)).toBe(
      "Cancelled",
    );
    // ...so a Lightning payer who still pays the hub's hold invoice is refunded: the hub's payout to a cancelled invoice
    // fails, and it cancels the hold. The receipt stays at one payment.
    hub.holdPayment();
    hub.failPayout("The payout failed.", true);
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("ckbolt:swap-history:testnet") ?? "[]")[0]?.state), { timeout: STEP_TIMEOUT_MS }).toBe("failed");
    await expect(g.paid).toHaveAttribute("data-count", "1");
    await expect(g.paid).not.toContainText("Paid twice");
    expect(hub.count("POST /v1/swaps/:id/cancel")).toBe(1);
  });

  test("paid twice, rarely: a payout already reaching the node when the Fiber invoice is paid cannot be cancelled; the receipt shows both", async ({
    page,
    hub,
  }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    const node = await withNode(page);
    const g = getPaid(page);
    await createRequest(page);
    const fiberInvoice = await g.fiber.getByTestId("request-fiber-text").textContent();
    await openLightning(page);
    // The hub's payout is arriving at the node (fnn: Received), and a Fiber payer pays at the same moment.
    hub.holdPayment();
    hub.startPayout();
    await settleNodeInvoice(node, hub.current.receive.invoice, "Received");
    await settleNodeInvoice(node, fiberInvoice!, "Paid");
    await expect(g.paid).toBeVisible({ timeout: STATUS_TIMEOUT_MS });
    hub.settle();
    await expect(g.paid).toHaveAttribute("data-count", "2", { timeout: STEP_TIMEOUT_MS });
    await expect(g.paid).toContainText("Paid twice");
    await expect(g.paid.getByTestId("request-payment")).toHaveCount(2);
    await expect(g.paid).toContainText(`Lightning, ${REQUEST.sats} sats`);
    // The node tried to cancel the payout invoice and fnn refused: a payment had arrived. Nothing else was cancelled.
    const calls = await nodeCalls(node, "cancel_invoice");
    expect(calls.every((c) => c?.payment_hash === (calls[0]?.payment_hash ?? null))).toBe(true);
    // Nor could the hub cancel a swap already paid: if the page asked before it read the payment, the hub said no.
    expect(hub.cancels.every((c) => c.status === 409)).toBe(true);
  });

  test("the node pairs the two invoices itself: with the app page closed, a paid Lightning invoice still cancels the Fiber one", async ({ page, hub }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    const node = await withNode(page);
    const g = getPaid(page);
    await createRequest(page);
    const fiberHash = await nodeInvoiceHash(node, (await g.fiber.getByTestId("request-fiber-text").textContent())!);
    await openLightning(page);
    const payoutInvoice = hub.current.receive.invoice;
    await page.close();
    // The hub pays the node's payout invoice; nobody follows the swap on the app page any more.
    await settleNodeInvoice(node, payoutInvoice, "Paid");
    await expect.poll(() => nodeCalls(node, "cancel_invoice"), { timeout: NODE_POLL_TIMEOUT_MS }).toEqual([{ payment_hash: fiberHash }]);
    const request = node.getByTestId("fiber-node-activity-list").locator('[data-testid="history-entry"][data-kind="request"]');
    await expect(request).toHaveAttribute("data-status", "Cancelled", { timeout: NODE_POLL_TIMEOUT_MS });
  });

  test("the Lightning invoice expires unpaid: New invoice cancels it at the hub and makes a fresh one; New request cancels that one; the Fiber one stays", async ({
    page,
    hub,
  }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    const node = await withNode(page);
    const g = getPaid(page);
    hub.requestQuoteTtlMs = SHORT_QUOTE_TTL_MS;
    await createRequest(page);
    const fiberInvoice = await g.fiber.getByTestId("request-fiber-text").textContent();
    await openLightning(page);
    const first = hub.current;
    await expect(g.countdown).toHaveText(/^\d+s$/);
    const seconds = Number((await g.countdown.textContent())?.replace("s", ""));
    // The page's clock ticks once a second, so a fresh quote may read one second more for that second.
    expect(seconds).toBeLessThanOrEqual(SHORT_QUOTE_TTL_MS / 1_000 + 1);
    expect(seconds).toBeGreaterThan(0);

    await expect(g.lightningTab).toHaveAttribute("data-status", "expired", { timeout: SHORT_QUOTE_TTL_MS + STEP_TIMEOUT_MS });
    await expect(g.lightning).toContainText("Expired before anyone paid.");
    await expect(g.lightning.getByTestId("request-lightning-qr")).toHaveCount(0);

    // The hub has not ended it yet (it does within seconds): "New invoice" cancels it with its token, then makes another.
    hub.requestQuoteTtlMs = REQUEST_QUOTE_TTL_MS;
    await g.lightning.getByTestId("request-new").click();
    await expect(g.lightningTab).toHaveAttribute("data-status", "waiting", { timeout: STEP_TIMEOUT_MS });
    await expect(g.lightning.getByTestId("request-lightning-qr")).toBeVisible();
    await expect.poll(() => hub.cancels).toEqual([{ id: first.id, token: hub.cancelTokens.get(first.id), status: 200 }]);
    expect(hub.swapBodies).toHaveLength(2);
    const second = hub.current;
    expect(second.id).not.toBe(first.id);
    expect(second.pay.invoice).not.toBe(first.pay.invoice);
    await expect(g.lightning.getByTestId("request-lightning-text")).toHaveText(second.pay.invoice);
    // The same request: the same amount quoted again; the Fiber invoice is still the first one, still payable.
    expect(hub.quoteBodies.at(-1)).toEqual(REQUEST_QUOTE);
    await expect(g.fiberTab).toHaveAttribute("data-status", "waiting");
    await g.fiberTab.click();
    await expect(g.fiber.getByTestId("request-fiber-text")).toHaveText(fiberInvoice!);
    await expect.poll(async () => (await nodeCalls(node, "new_invoice")).length).toBe(3);

    // "New request": its unpaid Lightning invoice is cancelled at the hub too, with that swap's own token.
    await g.reset.click();
    await expect(g.form).toBeVisible();
    await expect.poll(() => hub.cancels.map((c) => c.id)).toEqual([first.id, second.id]);
    expect(hub.cancels[1]).toEqual({ id: second.id, token: hub.cancelTokens.get(second.id), status: 200 });
    expect(hub.current).toMatchObject({ state: "failed", refunded: true });
  });
});

/* ============================================================================================ refusals */

test.describe("Get paid's refusals", () => {
  test("no node running: one line with the way to open it; an amount out of the per-swap limits or zero: one line; nothing is made", async ({ page, hub }) => {
    await openGetPaid(page);
    const g = getPaid(page);
    await g.amount.fill(REQUEST.ckb);
    await expect(g.conversion).toHaveText(CONVERSION, { timeout: STEP_TIMEOUT_MS });
    await expect(page.getByTestId("mode-receive").getByTestId("request-needs-node")).toHaveText(/Get paid needs your Fiber node running\./, {
      timeout: NODE_STATUS_TIMEOUT_MS,
    });
    await expect(page.getByTestId("mode-receive").getByTestId("request-open-node")).toBeVisible();
    await expect(g.create).toBeDisabled();

    // 1 CKB is 3 sats, 50,000 CKB 126,263 sats: the Lightning invoice's limits are 1,000 to 100,000 sats.
    for (const amount of ["1", "50000"]) {
      await g.amount.fill(amount);
      await expect(g.error).toHaveText("On Lightning, requests run from 1,000 to 100,000 sats.", { timeout: STEP_TIMEOUT_MS });
      await expect(g.create).toBeDisabled();
    }
    await g.amount.fill("0");
    await expect(g.error).toHaveText("Enter an amount of CKB above zero.");
    await expect(g.amount).toHaveAttribute("aria-invalid", "true");
    // The token picker: RUSD is quoted in RUSD.
    await g.amount.fill("2");
    await g.asset.click();
    await page.getByTestId("swap-token-list").getByRole("button", { name: /RUSD/ }).click();
    await expect.poll(() => hub.quoteBodies.at(-1)).toEqual({ direction: "ln_to_fiber", asset: "RUSD", side: "receive", amount: "200000000", purpose: "request" });
    expect(hub.swapBodies).toEqual([]);
  });

  test("a node that cannot receive the amount from the hub: one line, and the node's Channels one click away", async ({ page, hub }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    await withNode(page, 500);
    const g = getPaid(page);
    await g.amount.fill(REQUEST.ckb);
    await expect(g.error).toHaveText("Your node can receive 500 CKB now. Not enough for this.", { timeout: NODE_STATUS_TIMEOUT_MS });
    await expect(g.create).toBeDisabled();
    await expect(page.getByTestId("mode-receive").getByTestId("request-open-node")).toBeVisible();
    await g.amount.fill("400");
    await expect(g.error).toHaveCount(0, { timeout: STEP_TIMEOUT_MS });
    await expect(g.create).toBeEnabled();
    expect(hub.swapBodies).toEqual([]);
  });
});

/* ===================================================================================== layout, accessibility */

test.describe("Get paid's layout and accessibility", () => {
  test("axe finds nothing serious, and nothing is wider than a 390 px screen: the form, both tabs, the receipt", async ({ page, hub }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    await page.setViewportSize(PHONE);
    await withNode(page);
    const g = getPaid(page);
    await expectNoSeriousAxe(page);
    await expectNoHorizontalOverflow(page);
    await createRequest(page, "A long note for a table by the window ".repeat(2).trim());
    await expectNoSeriousAxe(page);
    await expectNoHorizontalOverflow(page);
    await openLightning(page);
    await expect(g.lightning).toContainText(LIGHTNING_LINE);
    await expectNoSeriousAxe(page);
    await expectNoHorizontalOverflow(page);
    hub.holdPayment();
    hub.startPayout();
    hub.settle();
    await expect(g.paid).toBeVisible({ timeout: STEP_TIMEOUT_MS });
    await expectNoSeriousAxe(page);
    await expectNoHorizontalOverflow(page);
  });
});
