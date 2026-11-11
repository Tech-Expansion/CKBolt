import { test as base, expect, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow, expectNoSeriousAxe } from "./page-checks";
import { hubChannel, installFakeNode, nodeCalls, nodeIdentity, nodeInvoiceHash, settleNodeInvoice, settleNodePayments, shareNodeHash, units, type NodeScope } from "./support/fiber-node";
import {
  answerInNode,
  browserHasDip,
  createWalletNode,
  DIP_PROBE_TIMEOUT_MS,
  InvoiceBook,
  NO_DIP_REASON,
  openPage,
  openWalletPopup,
  unlockAfterReload,
  WALLET_TIMEOUT_MS,
  WALLET_WINDOW_PATH,
  walletFrame,
} from "./support/fiber-wallet";
import { isolate, LiveHub } from "./support/live-hub";
import { STEP_TIMEOUT_MS } from "./support/swap-card";

/*
 * History in the Fiber node (docs/pay-get-paid.md, part E): the app's History tab is gone; the node's History lists
 * what moved money through the node, swaps the app kept merged with the node's own legs, and the app's "View in
 * History" opens the header's popup on an entry. The popup is an iframe of /app/wallet isolated by
 * Document-Isolation-Policy, which only real Chrome and Edge have: run with PW_CHANNEL=chrome. The fakes are
 * support/fiber-node.ts (fiber-js) and support/live-hub.ts (the hub); nothing reaches a real network.
 */

const TEST_TIMEOUT_MS = 150_000;
const PAY_TIMEOUT_MS = 20_000;
/** The page asks the node for its status every 5 s. */
const NODE_STATUS_TIMEOUT_MS = 15_000;
/** The node reads the swaps not final yet from the hub every 10 s (SWAP_HISTORY.refreshMs), and a busy tab answers late. */
const HUB_REFRESH_TIMEOUT_MS = 25_000;
/** A Get paid request, as the fake hub prices it. */
const REQUEST = { ckb: "1000", sats: "2,526", usd: "≈ $2.00" } as const;
const PHONE = { width: 390, height: 844 };
/** The popover's room for the node (components/app/fiber-wallet/styles.ts, less its title bar). */
const WALLET_FRAME_PX = { width: 380, height: 550 };

interface Fixtures {
  hub: LiveHub;
  book: InvoiceBook;
  dip: boolean;
}

const test = base.extend<Fixtures>({
  hub: async ({ context }, use) => {
    await isolate(context);
    const hub = new LiveHub();
    await hub.install(context);
    await use(hub);
  },
  book: async ({ context }, use) => {
    const book = new InvoiceBook();
    await book.install(context);
    await use(book);
  },
  dip: [
    async ({ browser, baseURL }, use) => {
      await use(await browserHasDip(browser, baseURL!));
    },
    { timeout: DIP_PROBE_TIMEOUT_MS },
  ],
});

/** The header's popup running a fresh node, on `path`, closed again so the app is in view. */
async function popupNode(page: Page, path: string) {
  const wallet = await openWalletPopup(page, path);
  await createWalletNode(wallet.ui);
  await page.getByTestId("fiber-wallet-close").click();
  return { ui: wallet.ui, scope: await walletFrame(page) };
}

const popover = (page: Page) => page.getByTestId("fiber-wallet-popover");

/** The status the fake fnn holds for one of the node's invoices (by its 0x payment hash). */
const fnnInvoiceStatus = (scope: NodeScope, hash: string) =>
  scope.evaluate((h) => (window as unknown as { __fakeFiber: { invoices: Record<string, { status: string }> } }).__fakeFiber.invoices[h].status, hash);

/**
 * Get paid: fills the form for the request and creates it once the node and the quote allow it (its Fiber invoice), then
 * opens the Lightning tab, which makes the Lightning invoice; both invoices shown.
 */
async function createRequest(page: Page) {
  const mode = page.getByTestId("mode-receive");
  await mode.getByTestId("request-amount").fill(REQUEST.ckb);
  await expect(mode.getByTestId("request-conversion")).toHaveText(`${REQUEST.usd} · ${REQUEST.sats} sats on Lightning`, { timeout: STEP_TIMEOUT_MS });
  await expect(mode.getByTestId("request-create")).toBeEnabled({ timeout: NODE_STATUS_TIMEOUT_MS });
  await mode.getByTestId("request-create").click();
  await expect(mode.getByTestId("request-fiber-text")).not.toBeEmpty({ timeout: STEP_TIMEOUT_MS });
  await mode.getByTestId("request-tab-lightning").click();
  await expect(mode.getByTestId("request-lightning-qr")).toBeVisible({ timeout: STEP_TIMEOUT_MS });
}

test.describe("one store for the page and the node", () => {
  test("the app page and the popup's isolated iframe share localStorage, and each hears the other's writes", async ({ page, context, hub: _hub, dip }) => {
    test.skip(!dip, NO_DIP_REASON);
    await installFakeNode(context);
    await openWalletPopup(page, "/app");
    const frame = await walletFrame(page);
    expect(await frame.evaluate(() => crossOriginIsolated)).toBe(true);
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(false);

    // The iframe listens before the page writes, so the storage event shows the two documents share one storage area.
    await frame.evaluate(() => {
      const heard: string[] = [];
      (window as unknown as { __heard: string[] }).__heard = heard;
      window.addEventListener("storage", (e) => e.key === "ckbolt:probe" && heard.push(e.newValue ?? ""));
    });
    await page.evaluate(() => localStorage.setItem("ckbolt:probe", "from the page"));
    expect(await frame.evaluate(() => localStorage.getItem("ckbolt:probe"))).toBe("from the page");
    await expect.poll(() => frame.evaluate(() => (window as unknown as { __heard: string[] }).__heard)).toEqual(["from the page"]);
    await frame.evaluate(() => localStorage.setItem("ckbolt:probe", "from the node"));
    expect(await page.evaluate(() => localStorage.getItem("ckbolt:probe"))).toBe("from the node");
  });
});

test.describe("View in History", () => {
  test("Pay's Fiber invoice, once paid: the popup opens on History with the payment open, its fee next to the max; the filters", async ({
    page,
    context,
    hub: _hub,
    book,
    dip,
  }) => {
    test.skip(!dip, NO_DIP_REASON);
    test.setTimeout(TEST_TIMEOUT_MS);
    await installFakeNode(context, { channels: [hubChannel({ local: units(1_000), remote: units(0) })], sendPayment: { status: "Inflight", failedError: null, throws: null, fee: "0x186a0" } });
    const node = await popupNode(page, "/app?mode=pay");
    const mode = page.getByTestId("mode-pay");
    const invoice = book.add({ amount: units(5) });
    await mode.getByTestId("pay-input").fill(invoice);
    await expect(mode.getByTestId("pay-confirm")).toHaveText("Pay 5 CKB", { timeout: PAY_TIMEOUT_MS });
    await mode.getByTestId("pay-confirm").click();
    // Confirm in the node, which the popup opened on.
    await expect(popover(page)).toBeVisible();
    await answerInNode(node, "accept");
    await expect(node.ui.getByTestId("fiber-wallet-confirm-outcome")).toHaveAttribute("data-status", "sent", { timeout: PAY_TIMEOUT_MS });
    await page.getByTestId("fiber-wallet-close").click();
    const result = mode.getByTestId("pay-result");
    // Not before it ended: a payment on its way has no "View in History" yet.
    await expect(result).toContainText("Sending…", { timeout: PAY_TIMEOUT_MS });
    await expect(result.getByTestId("history-entry-view")).toHaveCount(0);
    await settleNodePayments(node.scope, "Success");
    await expect(result).toHaveAttribute("data-status", "Success", { timeout: PAY_TIMEOUT_MS });

    await result.getByTestId("history-entry-view").click();
    await expect(popover(page)).toBeVisible();
    await expect(node.ui.getByTestId("fiber-wallet-page-history")).toBeVisible();
    const list = node.ui.getByTestId("fiber-wallet-history-list");
    const entry = list.locator(`[data-testid="history-entry"][data-key="${book.hashOf(invoice)}"]`);
    await expect(entry).toHaveAttribute("data-kind", "payment");
    await expect(entry.getByRole("button").first()).toHaveAttribute("aria-expanded", "true");
    await expect(entry).toContainText("Paid 5 CKB");
    const detail = entry.getByTestId("history-entry-detail");
    await expect(detail).toContainText("0.001 CKB (max 0.025 CKB)", { timeout: NODE_STATUS_TIMEOUT_MS });
    await expect(detail.getByTestId("history-entry-report")).toBeVisible();
    await expect(detail.getByRole("button", { name: "Copy payment hash" })).toBeVisible();

    // The filters: Payments has it, Swaps and Funds have nothing yet.
    await list.getByRole("radio", { name: "Payments" }).click();
    await expect(list.getByTestId("history-entry")).toHaveCount(1);
    for (const filter of ["Swaps", "Funds", "Channels"]) {
      await list.getByRole("radio", { name: filter }).click();
      await expect(list).toContainText("Nothing of this kind yet.");
    }
    // Asked again, History shows everything and opens the payment again.
    await page.getByTestId("fiber-wallet-close").click();
    await result.getByTestId("history-entry-view").click();
    await expect(list.getByRole("radio", { name: "All" })).toHaveAttribute("aria-checked", "true");
    await expect(entry.getByRole("button").first()).toHaveAttribute("aria-expanded", "true");
  });

  test("Get paid, left behind with New request: its Lightning invoice's swap holds the node until the page cancels it at the hub; nothing is cancelled in the node", async ({
    page,
    context,
    hub,
    dip,
  }) => {
    test.skip(!dip, NO_DIP_REASON);
    test.setTimeout(TEST_TIMEOUT_MS);
    await installFakeNode(context, { channels: [hubChannel({ local: units(0), remote: units(20_000) })] });
    const node = await popupNode(page, "/app?mode=receive");
    const mode = page.getByTestId("mode-receive");
    await createRequest(page);
    // Both legs of the swap share the node's payment hash, as with the real hub.
    const swapHash = await shareNodeHash(hub, node.scope);

    // The node's payout invoice waits for the hub's payout: History shows the swap in progress, and the node is held.
    await page.getByTestId("fiber-wallet-button").click();
    const recent = node.ui.getByTestId("fiber-wallet-recent");
    const swap = recent.locator(`[data-testid="history-entry"][data-key="${swapHash}"]`);
    await expect(swap).toContainText(`Swap: ${REQUEST.sats} sats → 1,000 CKB`, { timeout: STEP_TIMEOUT_MS });
    await expect(swap).toContainText("In progress");
    await expect(recent.locator('[data-testid="history-entry"][data-kind="request"]')).toContainText("Request for 1,000 CKB");
    await expect(node.ui.getByTestId("fiber-wallet-page-home").getByTestId("fiber-node-keep-open")).toBeVisible();
    await openPage(node.ui, "settings");
    await expect(node.ui.getByTestId("fiber-wallet-lock")).toBeDisabled();
    await page.getByTestId("fiber-wallet-close").click();

    // "New request" cancels the unpaid Lightning invoice's swap at the hub with its token, and keeps the hub's answer
    // where the node's History reads it: once its swap reads failed, the payout invoice, open for another hour, holds
    // the node no more.
    const swapId = hub.current.id;
    await mode.getByTestId("request-reset").click();
    await expect.poll(() => hub.cancels).toEqual([{ id: swapId, token: hub.cancelTokens.get(swapId), status: 200 }]);
    await expect(swap).toHaveAttribute("data-status", "failed", { timeout: HUB_REFRESH_TIMEOUT_MS });
    await expect(swap).toContainText("Cancelled");
    await page.getByTestId("fiber-wallet-button").click();
    await openPage(node.ui, "settings");
    await expect(node.ui.getByTestId("fiber-wallet-lock")).toBeEnabled();
    await openPage(node.ui, "home");
    await expect(node.ui.getByTestId("fiber-wallet-page-home").getByTestId("fiber-node-keep-open")).toHaveCount(0);
    // Nobody paid the request, so the node cancelled none of its invoices: it simply stopped waiting for this one.
    expect(await nodeCalls(node.scope, "cancel_invoice")).toEqual([]);
    expect(await fnnInvoiceStatus(node.scope, swapHash)).toBe("Open");
    const leaveAsks = await node.scope.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(leaveAsks).toBe(false);
  });

  test("Get paid, paid on Fiber: the receipt opens the request in History, and the node cancels the request's Lightning leg", async ({
    page,
    context,
    hub,
    dip,
  }) => {
    test.skip(!dip, NO_DIP_REASON);
    test.setTimeout(TEST_TIMEOUT_MS);
    await installFakeNode(context, { channels: [hubChannel({ local: units(0), remote: units(20_000) })] });
    const node = await popupNode(page, "/app?mode=receive");
    const mode = page.getByTestId("mode-receive");
    await createRequest(page);
    const swapHash = await shareNodeHash(hub, node.scope);
    const fiberInvoice = (await mode.getByTestId("request-fiber-text").textContent())!;
    const fiberHash = (await nodeInvoiceHash(node.scope, fiberInvoice))!;
    // While the request is open, nothing is cancelled: the node holds for the payout, both invoices stay payable.
    await page.getByTestId("fiber-wallet-button").click();
    await expect(node.ui.getByTestId("fiber-wallet-page-home").getByTestId("fiber-node-keep-open")).toBeVisible({ timeout: STEP_TIMEOUT_MS });
    await page.getByTestId("fiber-wallet-close").click();
    expect(await nodeCalls(node.scope, "cancel_invoice")).toEqual([]);

    // A Fiber payer pays the request's Fiber invoice: the receipt opens its entry in History.
    await settleNodeInvoice(node.scope, fiberInvoice, "Paid");
    const receipt = mode.getByTestId("request-paid");
    await expect(receipt).toBeVisible({ timeout: NODE_STATUS_TIMEOUT_MS });
    await mode.getByTestId("request-view").getByTestId("history-entry-view").click();
    await expect(node.ui.getByTestId("fiber-wallet-page-history")).toBeVisible();
    const list = node.ui.getByTestId("fiber-wallet-history-list");
    const request = list.locator(`[data-testid="history-entry"][data-key="${fiberHash}"]`);
    await expect(request.getByRole("button").first()).toHaveAttribute("aria-expanded", "true");
    await expect(request).toHaveAttribute("data-status", "Paid", { timeout: NODE_STATUS_TIMEOUT_MS });
    await expect(request).toContainText("Received 1,000 CKB");

    // Paid on Fiber, the node cancels the payout invoice the request's Lightning invoice pays into: a late Lightning
    // payer is refunded by the hub, and the leg no longer holds the node.
    await expect.poll(() => fnnInvoiceStatus(node.scope, swapHash), { timeout: NODE_STATUS_TIMEOUT_MS }).toBe("Cancelled");
    expect(await nodeCalls(node.scope, "cancel_invoice")).toEqual([{ payment_hash: swapHash }]);
    await openPage(node.ui, "settings");
    await expect(node.ui.getByTestId("fiber-wallet-lock")).toBeEnabled({ timeout: NODE_STATUS_TIMEOUT_MS });
  });
});

test.describe("History's layout and accessibility", () => {
  test("the list and an open swap fit the popover's size or a phone, with no serious axe finding", async ({ page, context, hub: _hub, isMobile }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    await installFakeNode(context);
    if (!isMobile) await page.setViewportSize(WALLET_FRAME_PX);
    else await page.setViewportSize(PHONE);
    // The node's own document (its window): the same pages as in the popover.
    await page.goto(WALLET_WINDOW_PATH);
    await expect(page.getByTestId("fiber-wallet")).toBeVisible({ timeout: WALLET_TIMEOUT_MS });
    await createWalletNode(page);
    const { nodeId } = await nodeIdentity(page);
    // Two swaps the app kept (one the node served, one through another node), the node's leg of the first, and a payment.
    const hash = "ab".repeat(32);
    const at = Date.now();
    const swap = (id: string, paymentHash: string, state: string, refunded: boolean) => ({
      id,
      direction: "ln_to_fiber",
      asset: "CKB",
      symbol: "CKB",
      paymentHash,
      pay: { network: "lightning", asset: "BTC", amount: "2526", decimals: 0 },
      receive: { network: "fiber", asset: "CKB", amount: "100000000000", decimals: 8 },
      createdAt: new Date(at - 60_000).toISOString(),
      state,
      refunded,
      funded: state === "succeeded",
    });
    const records = [swap("22222222-2222-4222-8222-222222222222", hash, "succeeded", false), swap("33333333-3333-4333-8333-333333333333", "cd".repeat(32), "failed", true)];
    const entries = [
      { id: `0x${hash}`, kind: "swap", asset: "CKB", amount: "100000000000", status: "Paid", error: null, at, swap: { id: null, leg: "invoice", lightningSats: null } },
      { id: `0x${"34".repeat(32)}`, kind: "payment", asset: "CKB", amount: "500000000", status: "Success", error: null, at: at - 1_000, fee: "100000", payment: { maxFee: "2500000", payee: `03${"5a".repeat(32)}` } },
    ];
    await page.evaluate(
      ([historyKey, history, swaps]) => {
        localStorage.setItem(historyKey, history);
        localStorage.setItem("ckbolt:swap-history:testnet", swaps);
      },
      [`ckbolt:fiber-browser:testnet:history:${nodeId}`, JSON.stringify(entries), JSON.stringify(records)],
    );
    await page.reload();
    await unlockAfterReload({ ui: page, scope: page });
    await openPage(page, "history");
    const list = page.getByTestId("fiber-wallet-history-list");
    await expect(list.getByTestId("history-entry")).toHaveCount(3);
    await expect(list.getByTestId("history-entry").first()).toContainText("Swap: 2,526 sats → 1,000 CKB");
    await expect(list.getByTestId("history-entry").first()).toContainText("Completed");
    await expect(list.getByTestId("history-entry").last()).toContainText("Cancelled");
    await expectNoSeriousAxe(page);
    await expectNoHorizontalOverflow(page);
    for (const row of [list.getByTestId("history-entry").first(), list.getByTestId("history-entry").nth(1)]) {
      await row.getByRole("button").first().click();
      await expect(row.getByTestId("history-entry-detail")).toBeVisible();
      await expectNoSeriousAxe(page);
      await expectNoHorizontalOverflow(page);
    }
  });
});
