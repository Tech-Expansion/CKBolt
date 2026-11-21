import { createHash, randomBytes } from "node:crypto";
import { test as base, expect, type BrowserContext, type FrameLocator, type Locator, type Page } from "@playwright/test";
import { CONFIRM_COPY } from "../../components/app/fiber-node/copy";
import type { SwapDto } from "../../lib/hub/contract";
import { demoFiberInvoice } from "../../lib/payment-request";
import { PROGRESS_COPY, RUN_ERROR, STEP_LINE } from "../../lib/swap/copy";
import { SWAP_PAYMENT_MESSAGE } from "../../lib/wallets/fiber-browser/swap-requests";
import { LN_WALLET_MESSAGE } from "../../lib/wallets/lightning/messages";
import { lightningInvoice } from "./fakes/hub";
import { FakeWebln } from "./fakes/lightning-wallet";
import { hubChannel, installFakeNode, nodeCalls, nodeSends, openRunningNode, units, type NodeScope } from "./support/fiber-node";
import {
  answerInNode,
  browserHasDip,
  createWalletNode,
  DIP_PROBE_TIMEOUT_MS,
  openWalletPopup,
  WALLET_TIMEOUT_MS,
  WALLET_WINDOW_PATH,
} from "./support/fiber-wallet";
import { isolate, LiveHub } from "./support/live-hub";
import { STEP_TIMEOUT_MS, SwapCard } from "./support/swap-card";

/*
 * The live swap card against a hub whose invoices are not what the visitor accepted (../ckbolt-hub/docs/
 * security-review-2026-11.md, W1 and W2):
 * - CKB to BTC: the browser node reads the hub's Fiber hold invoice itself, then puts the payment up on its Confirm page
 *   (amount, what the visitor gets in sats, the hub as payee, the max fee, the expiry); Confirm pays it with that max
 *   fee, Decline fails the step with a plain sentence and pays nothing, and a hold invoice the node refuses never gets
 *   that far.
 * - BTC to CKB: the card refuses a Lightning hold invoice that is not the swap the visitor accepted (another amount,
 *   another payout invoice, another hash than the node's invoice): not shown, not payable from a browser wallet.
 * The hub is the fake of support/live-hub.ts, which locks each swap to its payout invoice's hash as the hub does; the
 * browser node is the real node page with fiber-js replaced by the test hook. Where the browser has
 * Document-Isolation-Policy (PW_CHANNEL=chrome) the node runs in the header's popup and its Confirm page is there;
 * Playwright's own Chromium has none, so the node runs in its window, a page of its own next to /app.
 */

const TEST_TIMEOUT_MS = 150_000;
/** As the fake hub prices it (1 BTC = 40,000,000 CKB, 1 % fee): the visitor's invoice for 24,750 sats costs 10,000 CKB. */
const CKB_TO_BTC = { sats: 24_750, satsText: "24,750", ckb: "10,000" } as const;
/** 0.5 % of 10,000 CKB, in shannons, as send_payment's max_fee_amount. */
const MAX_FEE_HEX = `0x${((units(10_000) * BigInt(5)) / BigInt(1_000)).toString(16)}`;
const BTC_TO_CKB = { sats: "2000", ckb: "792" } as const;
/** The card reads the swap every 2 s: long enough for anything it would do with a refused invoice to have happened. */
const QUIET_PERIOD_MS = 5_000;
/** "Mon dd, yyyy, h:mm AM", as the Confirm page writes a date. */
const DATE_TIME = /^[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2}\s?[AP]M$/;

interface Fixtures {
  hub: LiveHub;
  card: SwapCard;
  dip: boolean;
}

const test = base.extend<Fixtures>({
  hub: async ({ context }, use) => {
    await isolate(context);
    const hub = new LiveHub();
    await hub.install(context);
    await use(hub);
  },
  card: async ({ page, hub: _hub }, use) => {
    await use(new SwapCard(page));
  },
  dip: [
    async ({ browser, baseURL }, use) => {
      await use(await browserHasDip(browser, baseURL!));
    },
    { timeout: DIP_PROBE_TIMEOUT_MS },
  ],
});

/** The node the visitor confirms in: the header's popup (with DIP) or its window, a page of its own (without). */
interface ConfirmingNode {
  ui: FrameLocator | Page;
  scope: NodeScope;
  popup: boolean;
}

/**
 * A running node with outbound CKB to the hub, and /app open with the card. With DIP the node is created in the header's
 * popup on /app itself (so the page is not reloaded after), and the popup is closed again.
 */
async function nodeForSwaps(page: Page, context: BrowserContext, card: SwapCard, dip: boolean): Promise<ConfirmingNode> {
  await installFakeNode(context, { channels: [hubChannel({ local: units(20_000), remote: units(0) })] });
  if (dip) {
    const wallet = await openWalletPopup(page, "/app");
    await createWalletNode(wallet.ui);
    await page.getByTestId("fiber-wallet-close").click();
    await expect(card.card).toBeVisible();
    return { ui: wallet.ui, scope: wallet.scope, popup: true };
  }
  const window = await context.newPage();
  await window.goto(WALLET_WINDOW_PATH);
  await expect(window.getByTestId("fiber-wallet")).toBeVisible({ timeout: WALLET_TIMEOUT_MS });
  await createWalletNode(window);
  await page.bringToFront();
  await card.open();
  return { ui: window, scope: window, popup: false };
}

/** CKB to BTC with the browser node: the visitor's own invoice for 24,750 sats fixes 10,000 CKB; Swap runs it. */
async function swapCkbToBtc(card: SwapCard) {
  await card.chooseFiber("browser-node");
  await card.flipTo("fiber_to_ln");
  await card.pasteInvoice(lightningInvoice({ sats: CKB_TO_BTC.sats }));
  await expect(card.amount).toHaveValue(CKB_TO_BTC.ckb, { timeout: STEP_TIMEOUT_MS });
  await card.swap();
  await card.expectStep(1, "done", "Your pasted invoice");
  await card.expectStep(2, "done", "Locked");
}

/** The swap dialog's "Confirm in your Fiber node": there only while the header's popup runs the node and it waits. */
const confirmInNodeButton = (card: SwapCard): Locator => card.progress.getByTestId("swap-confirm-in-node");

/**
 * Shows the node's Confirm page. While the node waits, step 3 says to confirm it there. The popup cannot be used under
 * the swap's modal dialog: the dialog's "Confirm in your Fiber node" hides it and opens the popup on Confirm (`button`),
 * or the visitor hides it and opens the popup from the header (`hide`). A window shows the request already, and the
 * dialog offers no button for it.
 */
async function showConfirm(page: Page, card: SwapCard, node: ConfirmingNode, via: "button" | "hide" = "button"): Promise<Locator> {
  await card.expectStep(3, "active", STEP_LINE.CONFIRM_IN_NODE);
  if (node.popup) {
    if (via === "button") {
      await expect(confirmInNodeButton(card)).toHaveText(PROGRESS_COPY.CONFIRM_IN_NODE);
      await confirmInNodeButton(card).click();
    } else {
      await card.progress.getByRole("button", { name: "Hide" }).click();
      await expect(card.progress).toBeHidden();
      await page.getByTestId("fiber-wallet-button").click();
    }
    await expect(card.progress).toBeHidden();
    await expect(card.banner).toContainText("Swap in progress");
    await expect(page.getByTestId("fiber-wallet-popover")).toBeVisible();
    await expect(node.ui.getByTestId("fiber-wallet-page-confirm")).toBeVisible({ timeout: WALLET_TIMEOUT_MS });
    await expect(node.ui.getByTestId("fiber-wallet-page-title")).toHaveText("Confirm");
  } else {
    await expect(confirmInNodeButton(card)).toHaveCount(0);
  }
  const request = node.ui.getByTestId("fiber-wallet-confirm-request");
  await expect(request).toBeVisible({ timeout: WALLET_TIMEOUT_MS });
  return request;
}

/** Back to the swap: the popover closed and the swap's dialog shown again. */
async function backToSwap(page: Page, card: SwapCard, node: ConfirmingNode) {
  if (!node.popup) return;
  await page.getByTestId("fiber-wallet-close").click();
  await expect(page.getByTestId("fiber-wallet-popover")).toBeHidden();
  await card.banner.getByRole("button", { name: "View" }).click();
  await expect(card.progress).toBeVisible();
}

/** One row of the Confirm page's list, by its label. */
const confirmRow = (request: Locator, label: string): Locator => request.locator("dl > div").filter({ hasText: new RegExp(`^${label}`) });

/* ======================================================================== CKB to BTC: Confirm in the node */

test.describe("CKB to BTC: the swap payment waits for Confirm in the node (W2)", () => {
  test("the pay request opens the node's Confirm page with what the swap pays and gets; Confirm pays it once, with the max fee", async ({
    page,
    context,
    hub,
    card,
    dip,
  }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    const node = await nodeForSwaps(page, context, card, dip);
    await swapCkbToBtc(card);
    // Nothing is sent while the node waits for the visitor.
    await card.expectStep(3, "active");

    const request = await showConfirm(page, card, node);
    await expect(request).toHaveAttribute("data-kind", "swap-payment");
    await expect(node.ui.getByTestId("fiber-wallet-confirm")).toBeVisible();
    await expect(request).toContainText(CONFIRM_COPY.LEAD_SWAP);
    // Amount, You get, To, Max fee, Invoice expires: nothing else, no node id, no route.
    await expect(request.locator("dl > div")).toHaveCount(5);
    await expect(confirmRow(request, CONFIRM_COPY.AMOUNT).locator("dd")).toHaveText(`${CKB_TO_BTC.ckb} CKB`);
    await expect(confirmRow(request, CONFIRM_COPY.YOU_GET).locator("dd")).toHaveText(`${CKB_TO_BTC.satsText} sats on Lightning`);
    await expect(confirmRow(request, CONFIRM_COPY.TO).locator("dd")).toHaveText(CONFIRM_COPY.HUB);
    await expect(confirmRow(request, CONFIRM_COPY.MAX_FEE).locator("dd")).toHaveText("50 CKB");
    await expect(confirmRow(request, CONFIRM_COPY.EXPIRES).locator("dd")).toHaveText(DATE_TIME);
    await expect(request.getByTestId("fiber-wallet-confirm-route")).toHaveCount(0);
    await expect(request.getByTestId("fiber-wallet-confirm-password")).toHaveCount(0);
    await expect(request.getByTestId("fiber-wallet-confirm-accept")).toHaveText(`Pay ${CKB_TO_BTC.ckb} CKB`);
    // The node read the hub's hold invoice itself before asking, and sent nothing yet.
    expect(await nodeCalls(node.scope, "parse_invoice")).toEqual([{ invoice: hub.current.pay.invoice }]);
    expect(await nodeSends(node.scope)).toEqual([]);
    expect(hub.current.state).toBe("pending");

    await answerInNode(node, "accept");
    await expect(node.ui.getByTestId("fiber-wallet-confirm-outcome")).toHaveAttribute("data-status", "sent", { timeout: WALLET_TIMEOUT_MS });
    expect(await nodeSends(node.scope)).toEqual([{ invoice: hub.current.pay.invoice, max_fee_amount: MAX_FEE_HEX }]);

    await backToSwap(page, card, node);
    await card.expectStep(3, "active", "Sent; waiting for the hub");
    // Sent: nothing more to confirm.
    await expect(confirmInNodeButton(card)).toHaveCount(0);
    hub.holdPayment();
    hub.startPayout();
    hub.settle();
    await expect(card.result).toContainText("Swap complete", { timeout: STEP_TIMEOUT_MS });
    await expect(card.result).toContainText(`${CKB_TO_BTC.satsText} sats`);
    expect(await nodeSends(node.scope)).toHaveLength(1);
  });

  test("Decline (reached by Hide and the header, as before the button) fails the step plainly, pays nothing; Try again, Confirm pays once", async ({
    page,
    context,
    hub,
    card,
    dip,
  }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    const node = await nodeForSwaps(page, context, card, dip);
    await swapCkbToBtc(card);

    // The manual path still works: Hide, then the header's Fiber node.
    const request = await showConfirm(page, card, node, "hide");
    await expect(request).toHaveAttribute("data-kind", "swap-payment");
    await answerInNode(node, "decline");
    await expect(node.ui.getByTestId("fiber-wallet-confirm-outcome")).toHaveAttribute("data-status", "declined");
    await expect(node.ui.getByTestId("fiber-wallet-confirm-outcome")).toContainText(CONFIRM_COPY.OUTCOME.declined);
    await backToSwap(page, card, node);

    // One plain sentence on the step, nothing behind a "?": the visitor said no, nothing moved.
    await card.expectStep(3, "failed", "You declined it in your Fiber node. Nothing was sent.");
    await expect(card.step(3).getByRole("button", { name: RUN_ERROR.DETAIL_LABEL })).toHaveCount(0);
    await expect(confirmInNodeButton(card)).toHaveCount(0);
    expect(await nodeSends(node.scope)).toEqual([]);
    await page.waitForTimeout(QUIET_PERIOD_MS);
    expect(await nodeSends(node.scope)).toEqual([]);
    expect(hub.current.state).toBe("pending");

    // The swap still waits: Try again puts the payment up again.
    await card.progress.getByRole("button", { name: "Try again" }).click();
    const again = await showConfirm(page, card, node);
    await expect(again).toHaveAttribute("data-kind", "swap-payment");
    await answerInNode(node, "accept");
    await expect(node.ui.getByTestId("fiber-wallet-confirm-outcome")).toHaveAttribute("data-status", "sent", { timeout: WALLET_TIMEOUT_MS });
    await backToSwap(page, card, node);
    await card.expectStep(3, "active", "Sent; waiting for the hub");
    expect(await nodeSends(node.scope)).toEqual([{ invoice: hub.current.pay.invoice, max_fee_amount: MAX_FEE_HEX }]);
  });

  test("a node in a tab of its own: the dialog offers no button, step 3 says to confirm it in the node, and its page pays it", async ({
    page,
    context,
    hub,
    card,
  }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    await installFakeNode(context, { channels: [hubChannel({ local: units(20_000), remote: units(0) })] });
    const nodePage = await openRunningNode(context);
    await page.bringToFront();
    await card.open();
    await swapCkbToBtc(card);
    await card.expectStep(3, "active", STEP_LINE.CONFIRM_IN_NODE);
    // The header's popup does not run the node here: nothing to open from the dialog.
    await expect(card.progress.getByRole("button", { name: "Hide" })).toBeVisible();
    await expect(confirmInNodeButton(card)).toHaveCount(0);
    await expect(page.getByTestId("fiber-wallet-popover")).toHaveCount(0);

    const section = nodePage.getByTestId("fiber-node-confirm");
    await expect(section.getByTestId("fiber-wallet-confirm-request")).toHaveAttribute("data-kind", "swap-payment", { timeout: WALLET_TIMEOUT_MS });
    expect(await nodeSends(nodePage)).toEqual([]);
    await answerInNode({ ui: nodePage, scope: nodePage }, "accept");
    await card.expectStep(3, "active", "Sent; waiting for the hub");
    expect(await nodeSends(nodePage)).toEqual([{ invoice: hub.current.pay.invoice, max_fee_amount: MAX_FEE_HEX }]);
  });

  test("a hold invoice the node refuses (not locked to the visitor's invoice) never reaches Confirm, and nothing is paid (W1)", async ({
    page,
    context,
    hub,
    card,
    dip,
  }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    // The hub's swap says the visitor's hash, but its Fiber hold invoice is locked to another one: it could settle the
    // visitor's CKB without paying their invoice out.
    const lock = hub.holdInvoice!;
    hub.holdInvoice = (swap: SwapDto) => {
      const hold = lock(swap);
      hub.book.register(hold, {
        amount: BigInt(swap.pay.amount),
        udt: null,
        payee: hub.fiberNode.nodeId,
        paymentHash: `0x${randomBytes(32).toString("hex")}`,
        expirySeconds: 150,
      });
      return hold;
    };
    const node = await nodeForSwaps(page, context, card, dip);
    await swapCkbToBtc(card);

    await card.expectStep(3, "failed", RUN_ERROR.NODE_REFUSED);
    await card.step(3).getByRole("button", { name: RUN_ERROR.DETAIL_LABEL }).click();
    await expect(page.getByRole("dialog", { name: RUN_ERROR.DETAIL_LABEL })).toContainText(SWAP_PAYMENT_MESSAGE.WRONG_HASH);
    await page.keyboard.press("Escape");
    expect(await nodeCalls(node.scope, "parse_invoice")).toEqual([{ invoice: hub.current.pay.invoice }]);
    expect(await nodeSends(node.scope)).toEqual([]);
    // Nothing was put up in the node.
    await expect(node.ui.getByTestId("fiber-wallet-confirm-request")).toHaveCount(0);
    expect(hub.current.state).toBe("pending");
  });
});

/* =========================================================== BTC to CKB: the card checks the hold invoice */

test.describe("BTC to CKB: a hold invoice that is not the swap the visitor accepted is refused by the card (W1)", () => {
  /** The browser node in its tab, ready to receive CKB; a browser wallet (WebLN) on /app that would pay at once. */
  async function readyToSwap(page: Page, context: BrowserContext, card: SwapCard) {
    await installFakeNode(context, { channels: [hubChannel({ local: units(0), remote: units(5_000) })] });
    const node = await openRunningNode(context);
    const webln = new FakeWebln();
    await webln.install(page);
    await page.bringToFront();
    await card.open();
    await card.chooseFiber("browser-node");
    await card.type(BTC_TO_CKB.sats);
    await expect(card.receiveAmount).toHaveText(BTC_TO_CKB.ckb, { timeout: STEP_TIMEOUT_MS });
    return { node, webln };
  }

  /** Step 3 refuses the hold invoice in one line: no QR code, nothing to copy or open, no browser wallet; nothing paid. */
  async function expectRefused(page: Page, card: SwapCard, hub: LiveHub, webln: FakeWebln) {
    await card.expectStep(1, "done", "Invoice ready");
    await card.expectStep(2, "done", "Locked");
    await card.expectStep(3, "failed", LN_WALLET_MESSAGE.HOLD_INVOICE_MISMATCH);
    await expect(card.holdInvoice).toHaveCount(0);
    await expect(card.progress.getByTestId("swap-hold-qr")).toHaveCount(0);
    await expect(card.progress.getByTestId("swap-webln")).toHaveCount(0);
    await expect(page.getByText(hub.current.pay.invoice)).toHaveCount(0);
    await expect(card.progress.getByRole("button", { name: "Try again" })).toHaveCount(0);
    await page.waitForTimeout(QUIET_PERIOD_MS);
    expect(webln.of("sendPayment")).toEqual([]);
    expect(hub.current.state).toBe("pending");
    await card.expectStep(3, "failed");
  }

  test("the hub's swap and hold invoice both ask one sat more than the quote the visitor accepted", async ({ page, context, hub, card }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    const { webln } = await readyToSwap(page, context, card);
    // Between the quote the page shows and the swap, the hub's copy of the quote changes: the swap and its hold invoice
    // (made from the swap) agree with each other, not with what the visitor accepted.
    const quotes = hub.quotes.length;
    const accepted = hub.lastQuote.pay.amount;
    hub.lastQuote.pay = { ...hub.lastQuote.pay, amount: String(Number(accepted) + 1) };
    await card.swap();
    expect(hub.quotes).toHaveLength(quotes);
    await expect.poll(() => hub.swap?.pay.amount).toBe(String(Number(accepted) + 1));
    await expectRefused(page, card, hub, webln);
  });

  test("the hub's swap pays out to another invoice than the one the page sent", async ({ page, context, hub, card }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    const lock = hub.holdInvoice!;
    const someoneElse = demoFiberInvoice("testnet", units(792));
    hub.holdInvoice = (swap: SwapDto) => {
      const hold = lock(swap);
      swap.receive = { ...swap.receive, invoice: someoneElse };
      return hold;
    };
    const { webln } = await readyToSwap(page, context, card);
    await card.swap();
    await expect.poll(() => hub.swap?.receive.invoice).toBe(someoneElse);
    expect(hub.swapBodies[0].payoutInvoice).not.toBe(someoneElse);
    await expectRefused(page, card, hub, webln);
  });

  test("the hub's swap and hold invoice are locked to another hash than the node's payout invoice", async ({ page, context, hub, card }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    const lock = hub.holdInvoice!;
    const otherHash = createHash("sha256").update(randomBytes(32)).digest();
    hub.holdInvoice = (swap: SwapDto) => {
      lock(swap);
      swap.paymentHash = otherHash.toString("hex");
      return lightningInvoice({ sats: Number(swap.pay.amount), hash: otherHash, expirySeconds: 150 });
    };
    const { webln } = await readyToSwap(page, context, card);
    await card.swap();
    await expectRefused(page, card, hub, webln);
  });
});
