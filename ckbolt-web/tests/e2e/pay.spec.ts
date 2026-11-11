import { randomBytes } from "node:crypto";
import { test as base, expect, type BrowserContext, type FrameLocator, type Page, type Route } from "@playwright/test";
import { ccc } from "@ckb-ccc/core";
import type { Script } from "../../lib/hub/contract";
import { demoFiberInvoice } from "../../lib/payment-request";
import { CKB_RPC_DEFAULT_URL } from "../../lib/wallets/fiber-browser/constants";
import { FakeCkbChain, type JsonRpcRequest } from "./fiber-byo-fakes";
import { amountlessInvoice, lightningInvoice } from "./fakes/hub";
import { expectNoHorizontalOverflow, expectNoSeriousAxe } from "./page-checks";
import {
  hubChannel,
  HUB_FIBER_NODE,
  installFakeNode,
  NO_ROUTE_ERROR,
  nodeCalls,
  nodeDryRuns,
  nodeIdentity,
  nodeSends,
  openRunningNode,
  RUSD_SCRIPT,
  setNodeRoutes,
  settleNodePayments,
  units,
  type NodeScope,
} from "./support/fiber-node";
import {
  answerInNode,
  browserHasDip,
  createWalletNode,
  DIP_PROBE_TIMEOUT_MS,
  exposeRealLockArgs,
  InvoiceBook,
  NODE_POLL_TIMEOUT_MS,
  openPage,
  openWalletPopup,
  PAYEE_NODE_ID,
  WALLET_PASSWORD,
  WALLET_TIMEOUT_MS,
  WALLET_WINDOW_PATH,
} from "./support/fiber-wallet";
import { isolate, LiveHub } from "./support/live-hub";
import { STEP_TIMEOUT_MS } from "./support/swap-card";

/*
 * Pay on /app (docs/pay-get-paid.md, part B), with the fake hub (support/live-hub.ts) and the browser node's fake
 * fiber-js (support/fiber-node.ts): a Lightning invoice paid as a CKB to BTC swap, exact out, the node paying the hub's
 * hold invoice; a Fiber invoice the node pays only once the visitor confirmed it in the node, its hash in History before
 * send_payment, the fee it took next to the max, and History reading a pending payment again after a reload; CKB on
 * chain to an address, confirmed in the node with its password, exactly the amount with the change back; the refusals;
 * axe and a 390 px screen. Where the browser has Document-Isolation-Policy (PW_CHANNEL=chrome) the node runs in the
 * header's popup and Confirm shows there; Playwright's own Chromium has none, so the node runs in its window, a page of
 * its own next to /app, and Confirm shows there (support/fiber-wallet.ts). Nothing reaches a real network.
 */

const TEST_TIMEOUT_MS = 150_000;
const PAY_TIMEOUT_MS = 20_000;
/** The page asks the node tab for its status every 5 s. */
const NODE_STATUS_TIMEOUT_MS = 15_000;
const PHONE = { width: 390, height: 844 };
const SECP_CODE_HASH = "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8";
const CKB_RPC = CKB_RPC_DEFAULT_URL.testnet;
/** As the fake hub prices it (1 BTC = 40,000,000 CKB, 1 % fee): the visitor's invoice for 24,750 sats costs 10,000 CKB. */
const CKB_TO_BTC = { sats: 24_750, satsText: "24,750", ckb: "10,000" } as const;

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

/** The Pay tab and its parts. */
const pay = (page: Page) => {
  const id = (testId: string) => page.getByTestId("mode-pay").getByTestId(testId);
  return {
    input: id("pay-input"),
    scan: id("pay-scan"),
    preview: id("pay-preview"),
    confirm: id("pay-confirm"),
    result: id("pay-result"),
    error: id("pay-error"),
    waiting: id("pay-waiting"),
    amount: id("pay-amount"),
  };
};

async function openPay(page: Page, path = "/app?mode=pay") {
  await page.goto(path);
  await expect(page.getByTestId("mode-pay").getByTestId("pay-card")).toBeVisible({ timeout: WALLET_TIMEOUT_MS });
}

/** The node the visitor confirms in: the header's popup (with DIP) or its window, a page of its own (without). */
interface ConfirmingNode {
  /** Where its pages are. */
  ui: FrameLocator | Page;
  /** Where its fake fiber-js runs. */
  scope: NodeScope;
  popup: boolean;
  /** Shows the node again (the popover opens; a window is already there). */
  show: () => Promise<void>;
  /** Closes the popover, so the Pay card is in view again (a window: nothing to do). */
  hide: () => Promise<void>;
}

async function confirmingNode(page: Page, context: BrowserContext, dip: boolean): Promise<ConfirmingNode> {
  if (dip) {
    const wallet = await openWalletPopup(page, "/app?mode=pay");
    await createWalletNode(wallet.ui);
    const node: ConfirmingNode = {
      ui: wallet.ui,
      scope: wallet.scope,
      popup: true,
      show: async () => {
        if (!(await page.getByTestId("fiber-wallet-popover").isVisible())) await page.getByTestId("fiber-wallet-button").click();
      },
      hide: async () => {
        if (await page.getByTestId("fiber-wallet-popover").isVisible()) await page.getByTestId("fiber-wallet-close").click();
      },
    };
    await node.hide();
    return node;
  }
  const window = await context.newPage();
  await window.goto(WALLET_WINDOW_PATH);
  await expect(window.getByTestId("fiber-wallet")).toBeVisible({ timeout: WALLET_TIMEOUT_MS });
  await createWalletNode(window);
  await openPay(page);
  return {
    ui: window,
    scope: window,
    popup: false,
    show: async () => undefined,
    // Pay opens the header's popover on Confirm; without DIP it offers the node's window, which already runs.
    hide: async () => {
      if (await page.getByTestId("fiber-wallet-popover").isVisible()) await page.getByTestId("fiber-wallet-close").click();
    },
  };
}

/** The CKB testnet RPC as a whole fake chain (CCC builds and sends the on-chain send), with CORS like the real one. */
async function installChain(context: BrowserContext, chain: FakeCkbChain) {
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST, OPTIONS" };
  await context.route(`${CKB_RPC}**`, (route: Route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const payload = request.postDataJSON() as JsonRpcRequest | JsonRpcRequest[];
    const answer = Array.isArray(payload) ? payload.map((p) => chain.handle(p)) : chain.handle(payload);
    return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify(answer) });
  });
}

const walletAddress = () => {
  const lock: Script = { codeHash: SECP_CODE_HASH, hashType: "type", args: `0x${randomBytes(20).toString("hex")}` };
  return { lock, address: ccc.Address.from({ script: lock, prefix: "ckt" }).toString() };
};

/**
 * Unlocks the node in a new document once the closed one let go of its Web Lock: under load the browser may take a few
 * seconds to tear the old document down, and until then the node says it runs in another tab (and Unlock is tried again).
 */
async function unlockOnceFree(ui: FrameLocator | Page) {
  const home = ui.getByTestId("fiber-wallet-home");
  await expect(async () => {
    await home.getByLabel("Password", { exact: true }).fill(WALLET_PASSWORD);
    await home.getByRole("button", { name: "Unlock and start node" }).click();
    await expect(ui.getByTestId("fiber-wallet-balance")).toBeVisible({ timeout: 10_000 });
  }).toPass({ timeout: 60_000 });
}

const shorten = (s: string, n: number) => (s.length > n * 2 + 3 ? `${s.slice(0, n)}…${s.slice(-n)}` : s);

/* ===================================================================================== a Lightning invoice */

test.describe("Pay a Lightning invoice: a CKB to BTC swap, exact out", () => {
  test("preview (what they get, what you pay, the fee, the quote's countdown); Pay runs the swap; the node pays the hub's hold invoice once", async ({
    page,
    context,
    hub,
  }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    await installFakeNode(context, { channels: [hubChannel({ local: units(20_000), remote: units(0) })] });
    const node = await openRunningNode(context);
    await openPay(page);
    const p = pay(page);
    const invoice = lightningInvoice({ sats: CKB_TO_BTC.sats });
    await p.input.fill(invoice);
    await expect(page.getByTestId("pay-kind")).toHaveText("Lightning invoice");
    await expect(p.preview).toContainText(`${CKB_TO_BTC.satsText} sats`);
    await expect(p.preview.getByTestId("pay-amount-due")).toHaveText(`${CKB_TO_BTC.ckb} CKB`, { timeout: STEP_TIMEOUT_MS });
    await expect(p.preview).toContainText("1%");
    await expect(p.preview.getByTestId("swap-quote-timer")).toBeVisible();
    expect(hub.quoteBodies.at(-1)).toEqual({ direction: "fiber_to_ln", asset: "CKB", side: "receive", amount: String(CKB_TO_BTC.sats) });
    await expect(p.confirm).toHaveText(`Pay ${CKB_TO_BTC.ckb} CKB`, { timeout: NODE_STATUS_TIMEOUT_MS });
    await expect(p.confirm).toBeEnabled();
    await p.confirm.click();

    await expect(p.result.getByTestId("swap-step-1")).toHaveAttribute("data-status", "done", { timeout: STEP_TIMEOUT_MS });
    await expect(p.result.getByTestId("swap-step-1")).toContainText("Your pasted invoice");
    expect(hub.swapBodies).toEqual([expect.objectContaining({ quoteId: hub.lastQuote.id, payoutInvoice: invoice.toLowerCase() })]);
    await expect(p.result.getByTestId("swap-step-3")).toContainText("Sent; waiting for the hub", { timeout: STEP_TIMEOUT_MS });
    expect(await nodeCalls(node, "send_payment")).toEqual([expect.objectContaining({ invoice: hub.current.pay.invoice })]);
    // Paying a swap's hold invoice is the swap rule's (the hub confirms it): no Confirm in the node for it.
    expect(await nodeCalls(node, "parse_invoice")).toEqual([]);
    await expect(p.input).toHaveAttribute("readonly", "");

    hub.holdPayment();
    hub.startPayout();
    hub.settle();
    await expect(p.result.getByTestId("swap-result")).toContainText("Swap complete", { timeout: STEP_TIMEOUT_MS });
    await expect(p.result).toContainText(`${CKB_TO_BTC.satsText} sats`);
    expect(await nodeCalls(node, "send_payment")).toHaveLength(1);
    // The swap is in the node's History, as the swap card's are: the node's payment of the hold invoice and the swap the
    // page kept are one entry. The node runs in its own tab here, so the result has no "View in History".
    const swap = node.getByTestId("fiber-node-activity-list").locator('[data-testid="history-entry"][data-kind="swap"]');
    await expect(swap).toHaveCount(1);
    await expect(swap).toContainText(`Swap: ${CKB_TO_BTC.ckb} CKB → ${CKB_TO_BTC.satsText} sats`);
    await expect(swap).toContainText("Completed");
    await expect(p.result.getByTestId("history-entry-view")).toHaveCount(0);
    await p.result.getByTestId("pay-new").click();
    await expect(p.input).toHaveValue("");
  });

  test("refused in one line before any quote: no amount, mainnet, expired; RUSD is picked with the token picker", async ({ page, hub }) => {
    await openPay(page);
    const p = pay(page);
    await p.input.fill(amountlessInvoice());
    await expect(p.error).toHaveText("This invoice has no amount. Make one with an amount.");
    await p.input.fill(lightningInvoice({ sats: 2_000, network: "mainnet" }));
    await expect(p.error).toHaveText("This is a mainnet invoice. Use one on Bitcoin signet.");
    await p.input.fill(lightningInvoice({ sats: 2_000, timestamp: Math.floor(Date.now() / 1000) - 7_200, expirySeconds: 600 }));
    await expect(p.error).toHaveText("This invoice has expired. Make a new one.");
    await expect(p.input).toHaveAttribute("aria-invalid", "true");
    expect(hub.quoteBodies).toEqual([]);
    // Without the node running Pay says so, with the way to open it.
    await p.input.fill(lightningInvoice({ sats: 2_000 }));
    await expect(page.getByTestId("mode-pay").getByTestId("pay-needs-node")).toHaveText(/Pay needs your Fiber node running\./, { timeout: NODE_STATUS_TIMEOUT_MS });
    await expect(page.getByTestId("mode-pay").getByTestId("pay-open-node")).toBeVisible();
    await expect(p.confirm).toBeDisabled();
    await page.getByTestId("mode-pay").getByTestId("pay-token").click();
    await page.getByTestId("swap-token-list").getByRole("button", { name: /RUSD/ }).click();
    await expect.poll(() => hub.quoteBodies.at(-1)?.asset).toBe("RUSD");
  });
});

/* ======================================================================================= a Fiber invoice */

test.describe("Pay a Fiber invoice: the node pays it once the visitor confirms it in the node", () => {
  test("preview, Confirm in the node, History before send_payment with the max fee, the fee it took; Decline sends nothing", async ({
    page,
    context,
    hub: _hub,
    book,
    dip,
  }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    await installFakeNode(context, { channels: [hubChannel({ local: units(1_000), remote: units(0) })], sendPayment: { status: "Inflight", failedError: null, throws: null, fee: "0x186a0" } });
    const node = await confirmingNode(page, context, dip);
    const p = pay(page);
    const invoice = book.add({ amount: units(5), description: "A coffee" });
    await p.input.fill(invoice);
    await expect(page.getByTestId("pay-kind")).toHaveText("Fiber invoice");
    await expect(p.preview).toContainText("5 CKB", { timeout: PAY_TIMEOUT_MS });
    await expect(p.preview).toContainText("0.025 CKB");
    await expect(p.preview).toContainText(shorten(PAYEE_NODE_ID, 8));
    expect(await nodeCalls(node.scope, "parse_invoice")).toEqual([{ invoice }]);
    // Its own route works: one dry run, with the max fee, no trampoline.
    await expect(p.preview.getByTestId("pay-route")).toHaveAttribute("data-route", "direct");
    await expect(p.preview.getByTestId("pay-route")).toContainText("Direct");
    expect(await nodeDryRuns(node.scope)).toEqual([{ invoice, max_fee_amount: "0x2625a0", dry_run: true }]);
    await expect(p.confirm).toHaveText("Pay 5 CKB");

    // Decline first: nothing is sent, and the page says so in one line.
    await p.confirm.click();
    await expect(p.waiting).toBeVisible();
    await node.show();
    const request = node.ui.getByTestId("fiber-wallet-confirm-request");
    await expect(request).toHaveAttribute("data-kind", "fiber-payment", { timeout: PAY_TIMEOUT_MS });
    await expect(node.ui.getByTestId("fiber-wallet-page-title")).toHaveText("Confirm");
    await expect(request).toContainText("5 CKB");
    await expect(request).toContainText("0.025 CKB");
    await expect(request).toContainText("A coffee");
    await expect(request.getByTestId("fiber-wallet-confirm-route")).toHaveText(/Direct/);
    await answerInNode(node, "decline");
    await expect(node.ui.getByTestId("fiber-wallet-confirm-outcome")).toHaveAttribute("data-status", "declined");
    await node.hide();
    await expect(p.error).toHaveText("You declined it in your Fiber node. Nothing was sent.");
    expect(await nodeSends(node.scope)).toEqual([]);

    // Then Confirm: the hash goes to History, then send_payment with the max fee shown.
    await p.confirm.click();
    await node.show();
    await answerInNode(node, "accept");
    await expect(node.ui.getByTestId("fiber-wallet-confirm-outcome")).toHaveAttribute("data-status", "sent", { timeout: PAY_TIMEOUT_MS });
    const sent = await nodeSends(node.scope);
    expect(sent).toEqual([{ invoice, max_fee_amount: "0x2625a0" }]);
    await openPage(node.ui, "history");
    const entry = node.ui.getByTestId("fiber-wallet-history-list").getByTestId("history-entry");
    await expect(entry).toHaveAttribute("data-kind", "payment");
    await expect(entry).toContainText("Payment of 5 CKB");
    await node.hide();
    await expect(p.result).toBeVisible({ timeout: PAY_TIMEOUT_MS });
    await expect(p.result).toContainText("Sending…");

    // fnn settles it: the page reads it, and shows the fee it took next to the max.
    await settleNodePayments(node.scope, "Success");
    await expect(p.result).toHaveAttribute("data-status", "Success", { timeout: PAY_TIMEOUT_MS });
    await expect(p.result).toContainText("Paid");
    await expect(p.result).toContainText("0.001 CKB (max 0.025 CKB)");
    await expect(p.result).toContainText(shorten(book.hashOf(invoice), 10));
    await node.show();
    await expect(entry).toHaveAttribute("data-status", "Success", { timeout: NODE_POLL_TIMEOUT_MS });
    await expect(entry).toContainText("Paid 5 CKB");
    await node.hide();
    await p.result.getByTestId("pay-new").click();
    await expect(p.input).toHaveValue("");
  });

  test("after a reload, History reads a payment still in flight again with get_payment until it is paid", async ({ page, context, hub: _hub, book, dip }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    await installFakeNode(context, { channels: [hubChannel({ local: units(1_000), remote: units(0) })] });
    const node = await confirmingNode(page, context, dip);
    const p = pay(page);
    const invoice = book.add({ amount: units(7) });
    const hash = book.hashOf(invoice);
    await p.input.fill(invoice);
    await expect(p.confirm).toHaveText("Pay 7 CKB", { timeout: PAY_TIMEOUT_MS });
    await p.confirm.click();
    await node.show();
    await answerInNode(node, "accept");
    await expect(node.ui.getByTestId("fiber-wallet-confirm-outcome")).toHaveAttribute("data-status", "sent", { timeout: PAY_TIMEOUT_MS });

    // The node's document goes (the tab that held the popup, or the node's window) and a new one opens: the key is asked
    // for again, and the payment is still Inflight. Closing it, rather than reloading, frees the node's Web Lock at once.
    let ui: FrameLocator | Page;
    let scope: NodeScope;
    if (node.popup) {
      await page.close({ runBeforeUnload: false });
      const again = await openWalletPopup(await context.newPage(), "/app?mode=pay");
      ui = again.ui;
      scope = again.scope;
    } else {
      const old = node.ui as Page;
      await old.close({ runBeforeUnload: false });
      const window = await context.newPage();
      await window.goto(WALLET_WINDOW_PATH);
      ui = window;
      scope = window;
    }
    await unlockOnceFree(ui);
    await openPage(ui, "history");
    const entry = ui.getByTestId("fiber-wallet-history-list").getByTestId("history-entry");
    await expect(entry).toHaveAttribute("data-kind", "payment");
    await expect(entry).toHaveAttribute("data-status", "Inflight");
    // fnn kept the session (the fake's memory went with the reload: put it back as fnn would report it).
    await scope.evaluate(
      ([h]) => {
        (window as unknown as { __fakeFiber: { payments: Record<string, unknown> } }).__fakeFiber.payments[h] = { invoice: "", status: "Success", failed_error: null, fee: "0x3e8" };
      },
      [hash] as const,
    );
    await expect(entry).toHaveAttribute("data-status", "Success", { timeout: NODE_POLL_TIMEOUT_MS });
    expect((await nodeCalls(scope, "get_payment")).some((c) => c?.payment_hash === hash)).toBe(true);
    expect(await nodeSends(scope)).toEqual([]);
  });

  test("the node page in another tab puts the request up too, and pays it on its Confirm; the header's popup stays shut", async ({ page, context, hub: _hub, book }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    await installFakeNode(context, { channels: [hubChannel({ local: units(1_000), remote: units(0) })] });
    const nodePage = await openRunningNode(context);
    await openPay(page);
    const p = pay(page);
    const invoice = book.add({ amount: units(3) });
    await p.input.fill(invoice);
    await expect(p.confirm).toHaveText("Pay 3 CKB", { timeout: PAY_TIMEOUT_MS });
    await p.confirm.click();
    await expect(p.waiting).toHaveText("Confirm it in your Fiber node.");
    // The popup does not run the node here, so it is not opened: the node page shows the request by itself.
    await expect(page.getByTestId("fiber-wallet-popover")).toHaveCount(0);
    const section = nodePage.getByTestId("fiber-node-confirm");
    await expect(section.getByTestId("fiber-wallet-confirm-request")).toHaveAttribute("data-kind", "fiber-payment", { timeout: PAY_TIMEOUT_MS });
    expect(await nodeSends(nodePage)).toEqual([]);
    await section.getByTestId("fiber-wallet-confirm-accept").click();
    await expect(section.getByTestId("fiber-wallet-confirm-outcome")).toHaveAttribute("data-status", "sent", { timeout: PAY_TIMEOUT_MS });
    await expect(p.result).toBeVisible({ timeout: PAY_TIMEOUT_MS });
    expect(await nodeSends(nodePage)).toEqual([{ invoice, max_fee_amount: "0x16e360" }]);
  });

  test("refused: another network in the page; expired, an unknown token or more than the channels hold in the node; a node that cannot send", async ({
    page,
    context,
    hub: _hub,
    book,
    dip,
  }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    await installFakeNode(context, { channels: [hubChannel({ local: units(10), remote: units(0) })], sendPayment: { status: "Inflight", failedError: null, throws: "Failed to send payment: no path found" } });
    const node = await confirmingNode(page, context, dip);
    const p = pay(page);
    await p.input.fill(demoFiberInvoice("mainnet", units(5)));
    await expect(p.error).toHaveText("This invoice is for CKB mainnet. Use a CKB testnet invoice (fibt…).");
    await p.input.fill(book.add({ amount: units(5), createdAtMs: Date.now() - 7_200_000, expirySeconds: 3_600 }));
    await expect(p.error).toHaveText("This invoice has expired. Ask for a new one.", { timeout: PAY_TIMEOUT_MS });
    await p.input.fill(book.add({ amount: units(5), udt: { ...RUSD_SCRIPT, args: "0x01" } }));
    await expect(p.error).toHaveText("This invoice asks for a token your node does not hold.", { timeout: PAY_TIMEOUT_MS });
    await p.input.fill(book.add({ amount: units(50) }));
    await expect(p.error).toHaveText("Your channels can send 10 CKB now. Not enough for this and its fee.", { timeout: PAY_TIMEOUT_MS });
    await expect(p.confirm).toBeDisabled();

    // fnn refuses to send: History keeps the payment as Failed (its hash was written first), the page says why.
    await p.input.fill(book.add({ amount: units(2) }));
    await expect(p.confirm).toHaveText("Pay 2 CKB", { timeout: PAY_TIMEOUT_MS });
    await p.confirm.click();
    await node.show();
    await answerInNode(node, "accept");
    await expect(node.ui.getByTestId("fiber-wallet-confirm-outcome")).toHaveAttribute("data-status", "failed", { timeout: PAY_TIMEOUT_MS });
    await openPage(node.ui, "history");
    const entry = node.ui.getByTestId("fiber-wallet-history-list").getByTestId("history-entry");
    await expect(entry).toHaveAttribute("data-status", "Failed");
    await node.hide();
    await expect(p.error).toContainText("no path found");
  });
});

/* ============================================================================ a Fiber invoice: its route */

test.describe("Pay a Fiber invoice: the route, its own or through the CKBolt hub", () => {
  test("a payee behind the hub (no route of its own): the preview says so, Confirm shows it, the send carries the hub as its trampoline; axe and 390 px", async ({
    page,
    context,
    hub: _hub,
    book,
    dip,
  }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    await page.setViewportSize(PHONE);
    // Every browser node's channel with the hub is private, so the payer cannot see the payee's: fnn finds no route.
    await installFakeNode(context, { channels: [hubChannel({ local: units(1_000), remote: units(0) })], routes: { direct: NO_ROUTE_ERROR, trampoline: null } });
    const node = await confirmingNode(page, context, dip);
    const p = pay(page);
    const invoice = book.add({ amount: units(5) });
    await p.input.fill(invoice);
    const route = p.preview.getByTestId("pay-route");
    await expect(route).toHaveAttribute("data-route", "hub", { timeout: PAY_TIMEOUT_MS });
    await expect(route).toContainText("Through the CKBolt hub");
    await expect(p.error).toHaveCount(0);
    // Its own route first, then through the hub, both dry runs; nothing paid yet.
    expect(await nodeDryRuns(node.scope)).toEqual([
      { invoice, max_fee_amount: "0x2625a0", dry_run: true },
      { invoice, max_fee_amount: "0x2625a0", trampoline_hops: [HUB_FIBER_NODE.nodeId], dry_run: true },
    ]);
    expect(await nodeSends(node.scope)).toEqual([]);
    await page.getByRole("button", { name: "About the route", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "About the route" })).toContainText("cannot keep it");
    await expectNoSeriousAxe(page);
    await expectNoHorizontalOverflow(page);
    await page.keyboard.press("Escape");

    await expect(p.confirm).toHaveText("Pay 5 CKB");
    await p.confirm.click();
    await node.show();
    const request = node.ui.getByTestId("fiber-wallet-confirm-request");
    await expect(request).toHaveAttribute("data-kind", "fiber-payment", { timeout: PAY_TIMEOUT_MS });
    await expect(request.getByTestId("fiber-wallet-confirm-route")).toHaveAttribute("data-route", "hub");
    await expect(request.getByTestId("fiber-wallet-confirm-route")).toContainText("Through the CKBolt hub");
    const nodePage = node.popup ? page : (node.ui as Page);
    if (!node.popup) await nodePage.setViewportSize(PHONE);
    await expectNoSeriousAxe(nodePage);
    await expectNoHorizontalOverflow(nodePage);
    await answerInNode(node, "accept");
    await expect(node.ui.getByTestId("fiber-wallet-confirm-outcome")).toHaveAttribute("data-status", "sent", { timeout: PAY_TIMEOUT_MS });
    // The real send: exactly the route the read found, the hub as its one trampoline hop, with the max fee.
    expect(await nodeSends(node.scope)).toEqual([{ invoice, max_fee_amount: "0x2625a0", trampoline_hops: [HUB_FIBER_NODE.nodeId] }]);
    await node.hide();
    await expect(p.result).toBeVisible({ timeout: PAY_TIMEOUT_MS });
    await settleNodePayments(node.scope, "Success");
    await expect(p.result).toHaveAttribute("data-status", "Success", { timeout: PAY_TIMEOUT_MS });
  });

  test("no route, its own nor through the hub: one line with fnn's reason behind a ?, Pay stays off, nothing sent nor in History", async ({
    page,
    context,
    hub: _hub,
    book,
    dip,
  }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    await installFakeNode(context, {
      channels: [hubChannel({ local: units(1_000), remote: units(0) })],
      routes: { direct: NO_ROUTE_ERROR, trampoline: "Failed to build route: the trampoline found no path" },
    });
    const node = await confirmingNode(page, context, dip);
    const p = pay(page);
    const invoice = book.add({ amount: units(5) });
    await p.input.fill(invoice);
    await expect(p.error).toHaveText("No route to this payee now. Their node may be offline.", { timeout: PAY_TIMEOUT_MS });
    await expect(p.preview).toHaveCount(0);
    await expect(p.confirm).toBeDisabled();
    await p.error.getByRole("button", { name: "About this error" }).click();
    await expect(page.getByRole("dialog", { name: "About this error" })).toContainText("the trampoline found no path");
    await page.keyboard.press("Escape");
    expect(await nodeDryRuns(node.scope)).toHaveLength(2);
    expect(await nodeSends(node.scope)).toEqual([]);
    await node.show();
    await openPage(node.ui, "history");
    await expect(node.ui.getByTestId("fiber-wallet-history").locator('[data-testid="history-entry"][data-kind="payment"]')).toHaveCount(0);
    await node.hide();

    // Once the payee is reachable (its node came back), the same invoice reads again with a route.
    await setNodeRoutes(node.scope, { direct: null, trampoline: null });
    await p.input.fill("");
    await p.input.fill(invoice);
    await expect(p.preview.getByTestId("pay-route")).toHaveAttribute("data-route", "direct", { timeout: PAY_TIMEOUT_MS });
    await expect(p.confirm).toBeEnabled();
  });
});

/* ========================================================================================= a CKB address */

test.describe("Send CKB on chain to an address: confirmed in the node with its password", () => {
  test("the node prices it, asks for its password in the node; exactly the amount goes, the change back to the node", async ({ page, context, hub: _hub, dip }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    const chain = new FakeCkbChain();
    await installChain(context, chain);
    await exposeRealLockArgs(context);
    await installFakeNode(context);
    const node = await confirmingNode(page, context, dip);
    const { lockArgs } = await nodeIdentity(node.scope);
    const nodeLock: Script = { codeHash: SECP_CODE_HASH, hashType: "type", args: lockArgs! };
    chain.addCell({ lock: nodeLock, capacity: units(750) });
    await node.show();
    await openPage(node.ui, "add-funds");
    await node.ui.getByRole("button", { name: "Refresh balance" }).click();
    await openPage(node.ui, "home");
    await expect(node.ui.getByTestId("fiber-wallet-balance")).toHaveText("750 CKB");
    await node.hide();

    const p = pay(page);
    const wallet = walletAddress();
    await p.input.fill(wallet.address);
    await expect(page.getByTestId("pay-kind")).toHaveText("CKB address");
    await expect(page.getByTestId("mode-pay").getByText("On chain: 750 CKB")).toBeVisible({ timeout: NODE_STATUS_TIMEOUT_MS });
    await p.amount.fill("900");
    await expect(p.error).toHaveText("Your node holds 750 CKB on chain. Send less.");
    await p.amount.fill("100");
    await expect(p.preview).toContainText("100 CKB");
    await expect(p.confirm).toHaveText("Send 100 CKB");
    await p.confirm.click();
    await expect(p.waiting).toContainText("with its password");

    await node.show();
    const request = node.ui.getByTestId("fiber-wallet-confirm-request");
    await expect(request).toHaveAttribute("data-kind", "on-chain", { timeout: PAY_TIMEOUT_MS });
    await expect(request).toContainText("100 CKB");
    await expect(request).toContainText(shorten(wallet.address, 12));
    await expect(request).toContainText("Network fee");
    const accept = request.getByTestId("fiber-wallet-confirm-accept");
    await expect(accept).toBeDisabled();
    await request.getByLabel("Node password").fill("not the password");
    await answerInNode(node, "accept");
    await expect(request.getByTestId("fiber-wallet-confirm-error")).toHaveText("Wrong password, or the stored node key was changed.", { timeout: PAY_TIMEOUT_MS });
    await expect(request.getByLabel("Node password")).toHaveValue("");
    expect(chain.sent).toEqual([]);
    await request.getByLabel("Node password").fill(WALLET_PASSWORD);
    await answerInNode(node, "accept");
    await expect(node.ui.getByTestId("fiber-wallet-confirm-outcome")).toHaveAttribute("data-status", "sent", { timeout: PAY_TIMEOUT_MS });

    expect(chain.sent).toHaveLength(1);
    const [tx] = chain.sent;
    expect(tx.outputs).toHaveLength(2);
    expect(tx.outputs[0].lock.args).toBe(wallet.lock.args);
    expect(BigInt(tx.outputs[0].capacity)).toBe(units(100));
    expect(tx.outputs[1].lock.args).toBe(lockArgs);
    expect(BigInt(tx.outputs[1].capacity)).toBeGreaterThan(units(649));
    await openPage(node.ui, "history");
    const entry = node.ui.getByTestId("fiber-wallet-history-list").getByTestId("history-entry");
    await expect(entry).toHaveAttribute("data-kind", "withdraw");
    await expect(entry).toContainText("Withdrew 100 CKB");
    await node.hide();

    await expect(p.result).toContainText("Sent 100 CKB", { timeout: PAY_TIMEOUT_MS });
    await expect(p.result.getByTestId("pay-explorer")).toHaveAttribute("href", /explorer.*\/transaction\/0x/);
    // The password never left the node: no request of the page carried it.
    expect(JSON.stringify(chain.calls)).not.toContain(WALLET_PASSWORD);
  });

  test("an address on another network is refused in the page; the node's own address in the node", async ({ page, context, hub: _hub, dip }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    await installFakeNode(context);
    const node = await confirmingNode(page, context, dip);
    const p = pay(page);
    const mainnet = ccc.Address.from({ script: walletAddress().lock, prefix: "ckb" }).toString();
    await p.input.fill(mainnet);
    await expect(p.error).toHaveText("This address is not on CKB testnet. Use a CKB testnet address.");
    const { lockArgs } = await nodeIdentity(node.scope);
    const own = ccc.Address.from({ script: { codeHash: SECP_CODE_HASH, hashType: "type", args: lockArgs! }, prefix: "ckt" }).toString();
    await p.input.fill(own);
    await p.amount.fill("100");
    await p.confirm.click();
    await expect(p.error).toHaveText("This is the node's own address. Paste your wallet's address.", { timeout: PAY_TIMEOUT_MS });
  });
});

/* ===================================================================================== layout, accessibility */

test.describe("Pay's layout and accessibility", () => {
  test("axe finds nothing serious, and nothing is wider than a 390 px screen: at rest, each preview, the node's Confirm page", async ({
    page,
    context,
    hub: _hub,
    book,
    dip,
  }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    await page.setViewportSize(PHONE);
    await installFakeNode(context, { channels: [hubChannel({ local: units(20_000), remote: units(0) })] });
    await openPay(page);
    await expectNoSeriousAxe(page);
    await expectNoHorizontalOverflow(page);
    const node = await confirmingNode(page, context, dip);
    const p = pay(page);
    await p.input.fill(lightningInvoice({ sats: CKB_TO_BTC.sats }));
    await expect(p.preview.getByTestId("pay-amount-due")).toHaveText(`${CKB_TO_BTC.ckb} CKB`, { timeout: STEP_TIMEOUT_MS });
    await expectNoSeriousAxe(page);
    await expectNoHorizontalOverflow(page);
    await p.input.fill(walletAddress().address);
    await p.amount.fill("100");
    await expectNoSeriousAxe(page);
    await expectNoHorizontalOverflow(page);
    const invoice = book.add({ amount: units(5), description: "A long note ".repeat(20) });
    await p.input.fill(invoice);
    await expect(p.confirm).toHaveText("Pay 5 CKB", { timeout: PAY_TIMEOUT_MS });
    await expectNoSeriousAxe(page);
    await expectNoHorizontalOverflow(page);
    await p.confirm.click();
    await node.show();
    await expect(node.ui.getByTestId("fiber-wallet-confirm-request")).toBeVisible({ timeout: PAY_TIMEOUT_MS });
    const nodePage = node.popup ? page : (node.ui as Page);
    if (!node.popup) await nodePage.setViewportSize(PHONE);
    await expectNoSeriousAxe(nodePage);
    await expectNoHorizontalOverflow(nodePage);
    // Chrome, its viewport set by setViewportSize, sends a pointer click low in the popover's out-of-process iframe to the
    // page instead (from about 600 px down); the long note puts Decline there, so the keyboard answers. Clicks: above.
    const decline = node.ui.getByTestId("fiber-wallet-confirm-request").getByTestId("fiber-wallet-confirm-decline");
    await expect(decline).toBeEnabled({ timeout: WALLET_TIMEOUT_MS });
    await decline.press("Enter");
    await node.hide();
    await expect(p.error).toBeVisible({ timeout: PAY_TIMEOUT_MS });
  });
});
