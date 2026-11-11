import { test as base, expect, type Page } from "@playwright/test";
import QRCode from "qrcode";
import { demoFiberInvoice } from "../../lib/payment-request";
import { amountlessInvoice, apiError, hubAsset, installNoHub, lightningInvoice } from "./fakes/hub";
import { deferred, FakeWebln, type WeblnReply } from "./fakes/lightning-wallet";
import { expectNoHorizontalOverflow, expectNoSeriousAxe } from "./page-checks";
import { hubChannel, installFakeNode, nodeCalls, nodeInvoices, openRunningNode, RUSD_SCRIPT, units } from "./support/fiber-node";
import { createWalletNode, withoutWalletIsolation } from "./support/fiber-wallet";
import { isolate, LiveHub } from "./support/live-hub";
import { CARD_TIMEOUT_MS, expectInsideViewport, STEP_TIMEOUT_MS, SwapCard, visibleSentences, visibleWords } from "./support/swap-card";

/*
 * The live swap card (components/app/swap, docs/live-swap-ui.md) with one wallet, the visitor's Fiber node: every state
 * of its one button; the Lightning side by QR code or pasted invoice (BTC to CKB: the hub's hold invoice as a QR code
 * with Copy, Open in wallet and, with WebLN, Pay with browser wallet; CKB to BTC: the visitor's own invoice, pasted or
 * scanned, fixes the amount); the browser node and the visitor's own node both ways; refunds and cancels; and the
 * spec's word budget, screen width and accessibility.
 * Nothing here reaches a real network: the hub is tests/e2e/fakes/hub.ts (with ./support/live-hub.ts), WebLN a fake
 * `window.webln`, and the browser node the real node page with fiber-js replaced by `window.__ckboltTestFiberNode`;
 * every other host is refused (support/live-hub.ts `isolate`). Paying a QR code from a wallet happens outside the page:
 * the fake hub's state stands in for it.
 */

/* ------------------------------------------------------------------------------------------------ fixtures */

/** docs/live-swap-ui.md, Goals: at most 25 visible words at rest, no sentence longer than 12 words. */
const WORD_BUDGET = 25;
const MAX_SENTENCE_WORDS = 12;
/** Tests that open the node page create keys (scrypt) and wait for the bridge. */
const NODE_TEST_TIMEOUT_MS = 120_000;
/** Seven axe scans and two swap runs: 15 to 20 s alone, past the default 30 s once under a full parallel run. */
const AXE_TEST_TIMEOUT_MS = 60_000;
/** The card asks the node tab for its status every 5 s. */
const NODE_STATUS_TIMEOUT_MS = 15_000;
/** A quote short enough to watch it expire. */
const SHORT_QUOTE_TTL_MS = 5_000;
/** Long enough for the page to read the swap twice (every 2 s): anything it would do again, it would have done. */
const QUIET_PERIOD_MS = 5_000;
/** Longer than the quote's debounce, so a quote the card would ask for has been asked. */
const QUOTE_SETTLE_MS = 1_500;
/** Narrowest screen the card must fit (docs/style-guide.md). */
const PHONE = { width: 390, height: 844 };

/** As the fake prices it (1 BTC = 40,000,000 CKB, 1% fee): what each test pays and receives. */
const BTC_TO_CKB = { sats: "2000", ckb: "792", usdPay: "≈ $1.60", usdReceive: "≈ $1.58" } as const;
const CKB_TO_BTC = { ckb: "10,000", sats: 24_750, satsText: "24,750" } as const;
const BTC_TO_RUSD = { sats: "2000", rusd: "1.584" } as const;

const PASTE_LN = "Paste your Lightning invoice";

/** The JSON-RPC body inside a copyable curl line (`-d '<json>'`). */
const rpcOf = (curl: string | null): { jsonrpc: string; id: number; method: string; params: Record<string, unknown>[] } => {
  const body = /-d '([\s\S]*)'$/.exec(curl ?? "")?.[1];
  if (!body) throw new Error(`not a curl line with a body: ${curl}`);
  return JSON.parse(body) as { jsonrpc: string; id: number; method: string; params: Record<string, unknown>[] };
};

interface Fixtures {
  hub: LiveHub;
  card: SwapCard;
}

const test = base.extend<Fixtures>({
  hub: async ({ context }, use) => {
    await isolate(context);
    const hub = new LiveHub();
    await hub.install(context);
    await use(hub);
  },
  // Takes the hub so it is in place before the page loads.
  card: async ({ page, hub: _hub }, use) => {
    await use(new SwapCard(page));
  },
});

/** The visitor's own Lightning invoice, as their wallet makes it: on Mutinynet (signet), for exactly `sats`. */
const visitorInvoice = (sats: number = CKB_TO_BTC.sats, o: { expirySeconds?: number; network?: "signet" | "mainnet"; timestamp?: number } = {}) =>
  lightningInvoice({ sats, expirySeconds: o.expirySeconds ?? 600, network: o.network, timestamp: o.timestamp });

/** The page's own node made a payout invoice for exactly the quote's receive amount (own node, BTC to Fiber). */
const ownNodeInvoice = (hub: LiveHub) => demoFiberInvoice("testnet", BigInt(hub.lastQuote.receive.amount));

/** The own node, BTC to CKB, the payout invoice pasted: Swap is ready; the visitor will pay the hold invoice. */
async function readyOwnNodeToFiber(card: SwapCard, hub: LiveHub) {
  await card.open();
  await card.chooseFiber("own-node");
  await card.type(BTC_TO_CKB.sats);
  await card.expectPrimary("Paste your Fiber invoice", { enabled: true });
  await card.ownInvoice.fill(ownNodeInvoice(hub));
  await card.expectPrimary("Swap", { enabled: true });
}

/** The own node, CKB to BTC, the visitor's invoice pasted: Swap is ready; they will pay the hold invoice from their node. */
async function readyOwnNodeToLightning(card: SwapCard, invoice = visitorInvoice()) {
  await card.open();
  await card.chooseFiber("own-node");
  await card.flipTo("fiber_to_ln");
  await card.pasteInvoice(invoice);
  await expect(card.amount).toHaveValue(CKB_TO_BTC.ckb, { timeout: STEP_TIMEOUT_MS });
  await card.expectPrimary("Swap", { enabled: true });
}

/** The hub holds the payment, pays out and settles; the dialog follows each step. */
async function hubCompletes(card: SwapCard, hub: LiveHub) {
  hub.holdPayment();
  await card.expectStep(3, "done", "The hub holds your payment");
  hub.startPayout();
  await card.expectStep(4, "active", "Paying you out…");
  hub.settle();
  await expect(card.result).toContainText("Swap complete", { timeout: STEP_TIMEOUT_MS });
}

/**
 * Opens the "?" named `label` (Radix renders its popover as a dialog with that name), reads it and closes it again,
 * waiting until it is gone: a popover still closing would take the next Escape meant for the dialog under it.
 */
async function readTip(page: Page, label: string): Promise<string> {
  await page.getByRole("button", { name: label, exact: true }).click();
  const tip = page.getByRole("dialog", { name: label });
  await expect(tip).toBeVisible();
  const text = (await tip.textContent()) ?? "";
  await page.keyboard.press("Escape");
  await expect(tip).toBeHidden();
  return text;
}

/* ------------------------------------------------------------------------------------------- at rest */

test.describe("the live swap card at rest", () => {
  test("reads like a DEX swap: two boxes, BTC to CKB, the Fiber node's chip, one button, at most 25 words", async ({ card, hub, page }) => {
    await card.open();
    await expect(card.card.getByRole("heading", { name: "Swap" })).toBeVisible();
    await expect(card.card).toContainText("Testnet");
    await expect(card.payBox).toContainText("You pay");
    await expect(card.payBox.getByTestId("swap-token-pay")).toHaveText("BTC");
    await expect(card.payBox).toContainText("Max 100,000 sats");
    await expect(card.receiveBox).toContainText("You receive");
    // One wallet: the Fiber node, on the Fiber side. No Lightning wallet to connect.
    await expect(card.receiveBox.getByTestId("wallet-button-fiber")).toHaveText("Connect Fiber");
    await expect(page.getByTestId("wallet-button-lightning")).toHaveCount(0);
    await expect(card.card).not.toContainText(/Connect Lightning|NWC|Nostr/);
    await expect(card.receiveBox.getByTestId("swap-token-receive")).toHaveAccessibleName("You receive CKB, change token");
    await expect(card.receiveAmount).toHaveText("—");
    await card.expectPrimary("Enter an amount", { enabled: false });
    await expect(card.error).toHaveCount(0);

    // No L1 wallet bar, no JoyID, no demo wallet on /app.
    for (const id of ["ckb-wallet", "btc-wallet"]) await expect(page.getByTestId(id)).toHaveCount(0);
    await expect(page.getByTestId("mode-swap")).not.toContainText(/JoyID|demo wallet/i);

    const words = await visibleWords(card.card);
    test.info().annotations.push({ type: "words at rest", description: `${words.length}: ${words.join(" ")}` });
    expect(words.length, `words at rest: ${words.join(" ")}`).toBeLessThanOrEqual(WORD_BUDGET);
    for (const sentence of await visibleSentences(card.card)) expect(sentence.words, sentence.text).toBeLessThanOrEqual(MAX_SENTENCE_WORDS);
    expect(hub.count("POST /v1/quotes")).toBe(0);
  });

  test("explanations open on demand: How it works in a dialog, the fee behind a ?, the route and limits under Details", async ({ card, page }) => {
    await card.open();
    await page.getByTestId("how-it-works").click();
    const guide = page.getByRole("dialog", { name: "How it works" });
    await expect(guide).toBeVisible();
    await expect(guide.getByRole("heading", { level: 3 })).toHaveText(["What happens", "Wallets you need", "Is it safe?", "Test networks only"]);
    // Lightning: any wallet, by QR code or paste.
    await expect(guide).toContainText("Any wallet on Mutinynet, by QR code or pasted invoice.");
    await expect(guide).not.toContainText(/NWC|Nostr/);
    for (const sentence of await visibleSentences(guide)) expect(sentence.words, sentence.text).toBeLessThanOrEqual(MAX_SENTENCE_WORDS);
    await card.closeDialog(guide);

    await card.type(BTC_TO_CKB.sats);
    await expect(card.receiveAmount).toHaveText(BTC_TO_CKB.ckb, { timeout: STEP_TIMEOUT_MS });
    await expect(card.payBox).toContainText(BTC_TO_CKB.usdPay);
    await expect(card.receiveBox).toContainText(BTC_TO_CKB.usdReceive);
    await expect(card.timer).toHaveAccessibleName(/^Quote expires in \d+ seconds$/);
    await expect(card.details).toContainText("1 BTC = 40M CKB");
    await expect(card.details).toContainText("Fee 1%");
    expect(await readTip(page, "About the hub fee")).toContain("It is already in the amounts.");

    const toggle = card.details.getByRole("button", { name: "Details" });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    const route = card.details.getByText("Lightning → CKBolt hub → Fiber");
    await expect(route).toBeHidden();
    await toggle.click();
    await expect(route).toBeVisible();
    await expect(card.details.getByText("1,000 to 100,000 sats")).toBeVisible();
    await expect(card.details.getByText(/median of 3 exchanges/)).toBeVisible();

    // Every "?" is a button that says what it explains; quoted, the card still has no long sentence.
    for (const tip of await card.card.getByTestId("info-tip").all()) await expect(tip).toHaveAttribute("aria-label", /\S/);
    for (const sentence of await visibleSentences(card.card)) expect(sentence.words, sentence.text).toBeLessThanOrEqual(MAX_SENTENCE_WORDS);
  });
});

/* -------------------------------------------------------------------------------------- the primary button */

test.describe("the primary button", () => {
  test("the amount, the per-swap limits and liquidity disable it; then it opens the Fiber dialog; a Fiber amount is sized by the hub", async ({ card, hub, page }) => {
    await card.open();
    await card.type("0");
    await card.expectPrimary("Enter an amount", { enabled: false });
    await card.type("1.5");
    await card.expectPrimary("Enter a valid amount", { enabled: false });
    await card.type("500");
    await card.expectPrimary("Min 1,000 sats", { enabled: false });
    await card.type("200000");
    await card.expectPrimary("Max 100,000 sats", { enabled: false });
    // The BTC side's limits are checked in the page: the hub was not asked.
    expect(hub.count("POST /v1/quotes")).toBe(0);

    hub.fail("POST /v1/quotes", { status: 409, body: apiError("insufficient_liquidity", "The hub can pay out at most 30,000 CKB now."), times: 1 });
    await card.type("99000");
    await card.expectPrimary("Not enough liquidity", { enabled: false });
    await expect(card.error).toContainText("The hub cannot pay out this much right now.");
    expect(await readTip(page, "About this error")).toContain("at most 30,000 CKB");

    // A quote comes before the wallet, so the visitor sees the amount first; no Lightning wallet is asked for.
    await card.type(BTC_TO_CKB.sats);
    await card.expectPrimary("Connect Fiber node", { enabled: true });
    await expect(card.receiveAmount).toHaveText(BTC_TO_CKB.ckb);
    await card.primary.click();
    await expect(card.walletDialog()).toBeVisible();
    await card.closeDialog(card.walletDialog());

    // A Fiber amount is sized by the hub: its refusal names the limit, priced from the earlier CKB quote.
    await card.flipTo("fiber_to_ln");
    await expect(card.amount).toHaveValue(BTC_TO_CKB.ckb);
    await expect(card.receiveAmount).toHaveText("1,960", { timeout: STEP_TIMEOUT_MS });
    const refused = { status: 422, body: apiError("validation_failed", "The Lightning side of this swap is outside 1,000 to 100,000 sats."), times: 1 };
    hub.fail("POST /v1/quotes", refused);
    await card.type("1");
    await card.expectPrimary("Min 1,000 sats", { enabled: false });
    hub.fail("POST /v1/quotes", refused);
    await card.type("100000");
    await card.expectPrimary("Max 100,000 sats", { enabled: false });
  });

  test("a hub that swaps nothing this way says Hub unavailable; a Fiber amount it refuses, with no price known yet, is out of range", async ({ card, hub }) => {
    hub.assets = [hubAsset("CKB", ["fiber_to_ln"]), hubAsset("RUSD", ["fiber_to_ln"])];
    await card.open();
    await card.expectPrimary("Hub unavailable", { enabled: false });
    await card.flipTo("fiber_to_ln");
    // The hub does not swap this pair the other way, so the flip is blocked and says why.
    await expect(card.flipButton).toBeDisabled();
    await expect(card.flipButton).toHaveAccessibleName("Switch direction: the hub does not swap this pair the other way");
    hub.fail("POST /v1/quotes", { status: 422, body: apiError("validation_failed", "The Lightning side would be 2 sats."), times: 1 });
    await card.type("1");
    await card.expectPrimary("Amount out of range", { enabled: false });
    await expect(card.error).toContainText("Swaps run from 1,000 to 100,000 sats.");
  });

  test("own node: Paste your Fiber invoice, Paste your Lightning invoice focus their fields; then Getting quote…, Try again, Refresh quote, Swap", async ({ card, hub }) => {
    await card.open();
    await card.chooseFiber("own-node");
    await expect(card.walletButton()).toHaveText("External node");
    await card.type(BTC_TO_CKB.sats);
    await card.expectPrimary("Paste your Fiber invoice", { enabled: true });
    await card.primary.click();
    await expect(card.ownInvoice).toBeFocused();
    // An invoice for another amount, or a Lightning invoice, does not fit the quote.
    for (const wrong of [demoFiberInvoice("testnet", units(1)), lightningInvoice({ sats: Number(BTC_TO_CKB.sats) })]) {
      await card.ownInvoice.fill(wrong);
      await expect(card.error).toContainText("This invoice does not match the quote.");
      await card.expectPrimary("Paste your Fiber invoice", { enabled: true });
    }
    await card.ownInvoice.fill(ownNodeInvoice(hub));
    await expect(card.error).toHaveCount(0);
    await card.expectPrimary("Swap", { enabled: true });

    // CKB to BTC: no Fiber invoice to paste, but the visitor's own Lightning invoice.
    await card.flipTo("fiber_to_ln");
    await expect(card.ownInvoice).toHaveCount(0);
    await card.expectPrimary(PASTE_LN, { enabled: true });
    await card.primary.click();
    await expect(card.lnInvoice).toBeFocused();
    hub.latencyMs.set("POST /v1/quotes", 2_000);
    await card.pasteInvoice(visitorInvoice());
    await card.expectPrimary("Getting quote…", { enabled: false });
    await card.expectPrimary("Swap", { enabled: true });
    await expect(card.receiveAmount).toHaveText(CKB_TO_BTC.satsText);
    hub.latencyMs.delete("POST /v1/quotes");

    hub.fail("POST /v1/quotes", { status: 503, body: apiError("quote_unavailable", "No exchange answered in time."), times: 1 });
    await card.pasteInvoice(visitorInvoice(30_000));
    await card.expectPrimary("Try again", { enabled: true });
    await expect(card.error).toContainText("No fresh price right now. Try again soon.");
    await card.primary.click();
    await card.expectPrimary("Swap", { enabled: true });
    await expect(card.error).toHaveCount(0);

    // A quote holds for its lifetime only: then the button asks for a new one, and gets it.
    const ttl = hub.quoteTtlMs;
    hub.quoteTtlMs = SHORT_QUOTE_TTL_MS;
    await card.pasteInvoice(visitorInvoice(20_000));
    await card.expectPrimary("Swap", { enabled: true });
    await expect(card.primary).toHaveText("Refresh quote", { timeout: SHORT_QUOTE_TTL_MS + STEP_TIMEOUT_MS });
    await expect(card.timer).toHaveText(/Expired/);
    hub.quoteTtlMs = ttl;
    const quotes = hub.count("POST /v1/quotes");
    await card.primary.click();
    await card.expectPrimary("Swap", { enabled: true });
    expect(hub.count("POST /v1/quotes")).toBe(quotes + 1);
    expect(hub.count("POST /v1/swaps")).toBe(0);
  });

  test("the browser node: Open your Fiber node until its node runs; then what the node can send and receive decides", async ({ card, context, page }) => {
    test.setTimeout(NODE_TEST_TIMEOUT_MS);
    await installFakeNode(context, { channels: [hubChannel({ local: units(1_000), remote: units(1_000) })] });
    // As in a browser without Document-Isolation-Policy, the header's wallet offers a window, which this test can close.
    // The popup itself, isolated, is tests/e2e/fiber-wallet-popup.spec.ts.
    await withoutWalletIsolation(page);
    await card.open();
    await card.type(BTC_TO_CKB.sats);
    await card.chooseFiber("browser-node");
    await card.expectPrimary("Open your Fiber node", { enabled: true });

    // The button opens the header's Fiber node over the page; without isolation it offers its window.
    await card.primary.click();
    await expect(page.getByTestId("fiber-wallet-popover")).toBeVisible();
    const fallback = page.frameLocator('[data-testid="fiber-wallet-frame"]').getByTestId("fiber-wallet-fallback");
    const [nodePage] = await Promise.all([context.waitForEvent("page"), fallback.getByRole("button", { name: /^Open the node in a window/ }).click()]);
    await createWalletNode(nodePage);
    await page.getByTestId("fiber-wallet-close").click();
    const again = await card.openWalletDialog();
    await expect(again.getByTestId("fiber-node-phase")).toHaveText("Running", { timeout: NODE_STATUS_TIMEOUT_MS });
    await expect(again.getByTestId("fiber-node-hub")).toHaveText("Connected");
    await expect(again.getByTestId("fiber-node-liquidity").getByRole("row", { name: /CKB/ })).toContainText("1,000");
    await card.closeDialog(again);
    await expect(card.walletButton()).toHaveAccessibleName("Fiber node: CKBolt node, ready");

    // 792 CKB fits what the node can receive; 1,188 CKB does not: the button opens the Fiber node again.
    await card.expectPrimary("Swap", { enabled: true });
    await card.type("3000");
    await card.expectPrimary("Your node can't receive this much CKB", { enabled: true });
    await card.primary.click();
    await expect(page.getByTestId("fiber-wallet-popover")).toBeVisible();
    await page.getByTestId("fiber-wallet-close").click();

    await card.flipTo("fiber_to_ln");
    await card.type("500");
    await expect(card.payBox).toContainText("Can send 1,000 CKB");
    await card.expectPrimary(PASTE_LN, { enabled: true });
    await card.type("2000");
    await card.expectPrimary("Not enough CKB to send", { enabled: true });
    await card.primary.click();
    await expect(page.getByTestId("fiber-wallet-popover")).toBeVisible();
    await page.getByTestId("fiber-wallet-close").click();

    // The wallet's window closes: the card asks for the node again.
    await card.type("500");
    await card.expectPrimary(PASTE_LN, { enabled: true });
    await nodePage.close();
    await expect(card.primary).toHaveText("Open your Fiber node", { timeout: NODE_STATUS_TIMEOUT_MS });
  });
});

/* ----------------------------------------------------------------------- the Lightning side: a paste or a QR */

test.describe("CKB to BTC: the visitor's own Lightning invoice", () => {
  test("pasted, it fixes the swap exact out: the receive side is its sats, the pay box the CKB it needs, read-only", async ({ card, hub }) => {
    await card.open();
    await card.chooseFiber("own-node");
    await card.flipTo("fiber_to_ln");
    await expect(card.lnInvoice).toHaveAttribute("placeholder", "lntbs…");
    await expect(card.receiveBox.getByLabel("Your Lightning invoice", { exact: true })).toBeVisible();
    await card.expectPrimary(PASTE_LN, { enabled: true });

    const invoice = visitorInvoice();
    await card.pasteInvoice(invoice);
    await expect(card.receiveAmount).toHaveText(CKB_TO_BTC.satsText);
    await expect(card.amount).toHaveValue(CKB_TO_BTC.ckb, { timeout: STEP_TIMEOUT_MS });
    await expect(card.amount).toHaveAttribute("readonly", "");
    expect(hub.quoteBodies.at(-1)).toEqual({ direction: "fiber_to_ln", asset: "CKB", side: "receive", amount: String(CKB_TO_BTC.sats) });
    await card.expectPrimary("Swap", { enabled: true });

    // Cleared, the amount can be typed again; typed first, the card asks for an invoice of exactly the quoted sats.
    await card.pasteInvoice("");
    await expect(card.amount).not.toHaveAttribute("readonly", "");
    await card.type("10000");
    await expect(card.page.getByTestId("swap-ln-invoice-ask")).toHaveText(`For exactly ${CKB_TO_BTC.satsText} sats`, { timeout: STEP_TIMEOUT_MS });
    expect(hub.quoteBodies.at(-1)).toEqual({ direction: "fiber_to_ln", asset: "CKB", side: "pay", amount: units(10_000).toString() });
    await card.expectPrimary(PASTE_LN, { enabled: true });
    await card.primary.click();
    await expect(card.lnInvoice).toBeFocused();

    // A pasted invoice wins over the typed amount: its sats are quoted.
    await card.pasteInvoice(`lightning:${visitorInvoice(12_000)}`);
    await expect(card.receiveAmount).toHaveText("12,000");
    await card.expectPrimary("Swap", { enabled: true });
    expect(hub.quoteBodies.at(-1)).toEqual({ direction: "fiber_to_ln", asset: "CKB", side: "receive", amount: "12000" });
    await expect(card.page.getByTestId("swap-ln-invoice-ask")).toHaveCount(0);
  });

  test("refused in one line: no amount, mainnet, expired, expiring before the quote, not an invoice; nothing is swapped", async ({ card, hub, page }) => {
    await card.open();
    await card.chooseFiber("own-node");
    await card.flipTo("fiber_to_ln");
    const refused = async (text: string, line: string | RegExp) => {
      await card.pasteInvoice(text);
      await expect(card.error).toHaveText(line);
      await expect(card.lnInvoice).toHaveAttribute("aria-invalid", "true");
      await card.expectPrimary(PASTE_LN, { enabled: true });
    };
    await refused(amountlessInvoice(), "This invoice has no amount. Make one with an amount.");
    await refused(visitorInvoice(CKB_TO_BTC.sats, { network: "mainnet" }), "This is a mainnet invoice. Use one on Bitcoin signet.");
    await refused(visitorInvoice(CKB_TO_BTC.sats, { timestamp: Math.floor(Date.now() / 1000) - 700 }), "This invoice has expired. Make a new one.");
    await refused(demoFiberInvoice("testnet", units(10)), "This is not a Lightning invoice.");
    await refused("satoshi@example.com", "This is not a Lightning invoice.");
    // The reason behind the "?": Lightning addresses are a later item.
    expect(await readTip(page, "About this error")).toContain("Lightning address");
    // Valid now, but it expires in 60 s and the quote holds for 150 s.
    await card.pasteInvoice(lightningInvoice({ sats: CKB_TO_BTC.sats, expirySeconds: 60 }));
    await expect(card.error).toHaveText("This invoice expires before the quote. Make a new one.", { timeout: STEP_TIMEOUT_MS });
    await card.expectPrimary(PASTE_LN, { enabled: true });
    expect(hub.count("POST /v1/swaps")).toBe(0);
  });

  test("scanned: the scan button opens the QR scanner, and an uploaded QR image fills the field", async ({ card }) => {
    await card.open();
    await card.chooseFiber("own-node");
    await card.flipTo("fiber_to_ln");
    const invoice = visitorInvoice();
    const scan = card.page.getByTestId("swap-ln-invoice-scan");
    await expect(scan).toHaveAccessibleName("Scan a QR code");
    await scan.click();
    await expect(scan).toHaveAttribute("aria-expanded", "true");
    const image = await QRCode.toBuffer(invoice.toUpperCase(), { margin: 2, width: 600 });
    await card.page.getByTestId("qr-upload").setInputFiles({ name: "invoice.png", mimeType: "image/png", buffer: image });
    await expect(card.lnInvoice).toHaveValue(invoice.toUpperCase());
    await expect(scan).toHaveAttribute("aria-expanded", "false");
    await expect(card.receiveAmount).toHaveText(CKB_TO_BTC.satsText);
    await card.expectPrimary("Swap", { enabled: true });
  });
});

test.describe("BTC to CKB: the hub's hold invoice, paid from any wallet", () => {
  test("own node: a QR code with Copy and Open in wallet; nothing else to connect; the hub's state moves the run", async ({ card, hub, context, page }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await readyOwnNodeToFiber(card, hub);
    await card.swap();
    await card.expectStep(1, "done", "Your pasted invoice");
    await card.expectStep(2, "done", "Locked");
    await card.expectStep(3, "active", "Pay the invoice below");
    await expect(card.step(3)).toContainText("Pay from your Lightning wallet");

    const hold = card.holdInvoice;
    await expect(hold).toContainText("Pay this from any Lightning wallet");
    await expect(hold.getByTestId("swap-hold-qr")).toHaveAccessibleName("QR code of the hub's Lightning invoice to pay");
    await expect(hold).toContainText(hub.current.pay.invoice);
    await expect(hold.getByTestId("swap-hold-open")).toHaveAttribute("href", `lightning:${hub.current.pay.invoice}`);
    await expect(hold.getByTestId("swap-hold-open")).toHaveText("Open in wallet");
    // No browser wallet on this page: no button for it.
    await expect(hold.getByTestId("swap-webln")).toHaveCount(0);
    expect(await readTip(page, "About paying this invoice")).toContain("Scan the code");
    await hold.getByTestId("swap-hold-copy").click();
    await expect(hold.getByRole("button", { name: "Copied" })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(hub.current.pay.invoice);

    // Paid from a wallet outside the page: the hub's state says so.
    hub.holdPayment();
    await card.expectStep(3, "done", "The hub holds your payment");
    await expect(card.holdInvoice).toHaveCount(0);
    hub.startPayout();
    hub.settle();
    await expect(card.result).toContainText("Swap complete", { timeout: STEP_TIMEOUT_MS });
    await expect(card.result).toContainText(`${BTC_TO_CKB.ckb} CKB`);
    // The spent invoice is forgotten: the next swap asks for a new one.
    await card.progress.getByRole("button", { name: "New swap" }).click();
    await expect(card.ownInvoice).toHaveValue("");
    await card.expectPrimary("Paste your Fiber invoice", { enabled: true });
  });

  test("with a browser wallet (WebLN): Pay with browser wallet; a refusal says why and may be asked again; it pays once", async ({ card, hub, page }) => {
    const webln = new FakeWebln();
    const held = deferred<WeblnReply>();
    const answers: (() => WeblnReply | Promise<WeblnReply>)[] = [() => ({ error: "User rejected" }), () => held.promise];
    webln.sendPayment = () => (answers.shift() ?? (() => ({ error: "asked too often" })))();
    await webln.install(page);
    await readyOwnNodeToFiber(card, hub);
    await card.swap();
    await card.expectStep(3, "active", "Pay the invoice below");
    // Nothing is asked of the wallet until the visitor presses it.
    await page.waitForTimeout(QUOTE_SETTLE_MS);
    expect(webln.calls).toEqual([]);

    const button = card.holdInvoice.getByTestId("swap-webln");
    await expect(button).toHaveText("Pay with browser wallet");
    await button.click();
    const error = card.holdInvoice.getByTestId("swap-webln-error");
    await expect(error).toContainText("Your browser wallet did not pay.");
    expect(await readTip(page, "About this error")).toContain("User rejected");
    // Still payable, by QR code or by the browser wallet again; twice before the page re-renders pays once.
    await expect(card.holdInvoice.getByTestId("swap-hold-qr")).toBeVisible();
    await button.evaluate((b: HTMLElement) => {
      b.click();
      b.click();
    });
    // A hold invoice keeps the wallet's payment pending until the hub settles; nothing is offered to pay again.
    await card.expectStep(3, "active", "Paying from your wallet…");
    await expect(card.holdInvoice).toHaveCount(0);
    expect(webln.of("sendPayment").map((c) => c.args)).toEqual([hub.current.pay.invoice, hub.current.pay.invoice]);
    expect(webln.of("enable")).toHaveLength(2);

    // Hidden, shown again, and two reads of the swap later, nothing was asked of the wallet again.
    await card.progress.getByRole("button", { name: "Hide" }).click();
    await card.banner.getByRole("button", { name: "View" }).click();
    await page.waitForTimeout(QUIET_PERIOD_MS);
    expect(webln.of("sendPayment")).toHaveLength(2);

    await hubCompletes(card, hub);
    held.resolve({ ok: { preimage: hub.preimage } });
    expect(webln.of("sendPayment")).toHaveLength(2);
    expect(hub.count("POST /v1/swaps")).toBe(1);
  });

  test("a browser wallet with no clear answer (a closed prompt) counts as sent and is never asked again", async ({ card, hub, page }) => {
    const webln = new FakeWebln();
    webln.sendPayment = () => ({ error: "Prompt was closed" });
    await webln.install(page);
    await readyOwnNodeToFiber(card, hub);
    await card.swap();
    await card.holdInvoice.getByTestId("swap-webln").click();
    await card.expectStep(3, "active", "Sent; waiting for the hub");
    await expect(card.holdInvoice).toHaveCount(0);
    await expect(card.progress.getByRole("button", { name: "Try again" })).toHaveCount(0);
    await page.waitForTimeout(QUIET_PERIOD_MS);
    expect(webln.of("sendPayment")).toHaveLength(1);
  });

  test("F8.1: a browser wallet with no route to the hub says so, and points to a channel on the guide's hub card", async ({ card, hub, page }) => {
    const webln = new FakeWebln();
    webln.sendPayment = () => ({ error: "Failed to send payment: RouteNotFound. User rejected" });
    await webln.install(page);
    await readyOwnNodeToFiber(card, hub);
    await card.swap();
    await card.holdInvoice.getByTestId("swap-webln").click();
    await expect(card.holdInvoice.getByTestId("swap-webln-error")).toContainText("Your wallet found no route to the hub.");
    expect(await readTip(page, "About this error")).toContain("RouteNotFound");
    const channel = card.holdInvoice.getByTestId("swap-step-help");
    await expect(channel).toHaveText("Get a Lightning channel from the hub (opens in a new tab)");
    await expect(channel).toHaveAttribute("href", "/app/guide#hub");
    await expect(channel).toHaveAttribute("target", "_blank");
    // The invoice is still there to pay once the wallet has its channel.
    await expect(card.holdInvoice.getByTestId("swap-webln")).toBeEnabled();
    await card.expectStep(3, "active", "Pay the invoice below");
  });

  test("a WebLN extension that loads after the page is offered too", async ({ card, hub, page }) => {
    const webln = new FakeWebln();
    await webln.install(page, { late: true });
    await readyOwnNodeToFiber(card, hub);
    await card.swap();
    await expect(card.holdInvoice).toBeVisible({ timeout: STEP_TIMEOUT_MS });
    await expect(card.holdInvoice.getByTestId("swap-webln")).toHaveCount(0);
    await webln.inject(page);
    await expect(card.holdInvoice.getByTestId("swap-webln")).toBeVisible();
  });
});

/* ---------------------------------------------------------------------------------- a swap with the browser node */

test.describe("a swap with the browser node", () => {
  test("BTC to CKB: the node makes the invoice, the swap locks, the visitor pays the QR code, the hub pays out", async ({ card, hub, context, page }) => {
    test.setTimeout(NODE_TEST_TIMEOUT_MS);
    await installFakeNode(context, { channels: [hubChannel({ local: units(0), remote: units(5_000) })] });
    const node = await openRunningNode(context);

    await card.open();
    await card.chooseFiber("browser-node");
    await card.type(BTC_TO_CKB.sats);
    await card.swap();
    await expect(page.getByRole("dialog", { name: "Swapping" })).toContainText(`2,000 sats to ${BTC_TO_CKB.ckb} CKB`);
    await card.expectStep(1, "done", "Invoice ready");
    await card.expectStep(2, "done", "Locked");
    await card.expectStep(3, "active", "Pay the invoice below");

    // The node's invoice, for exactly the quote, is what the hub got; the hold invoice waits for the visitor.
    const [asked] = await nodeCalls(node, "new_invoice");
    expect(BigInt(String(asked?.amount))).toBe(BigInt(hub.lastQuote.receive.amount));
    expect(hub.swapBodies).toHaveLength(1);
    expect(hub.swapBodies[0]).toMatchObject({ quoteId: hub.lastQuote.id, payoutInvoice: (await nodeInvoices(node))[0] });
    expect(hub.swapBodies[0].demo ?? false).toBe(false);
    await expect(card.holdInvoice.getByTestId("swap-hold-open")).toHaveAttribute("href", `lightning:${hub.current.pay.invoice}`);

    // While it runs the dialog cannot be dismissed, only hidden; the card then offers one way back and no second swap.
    await page.keyboard.press("Escape");
    await expect(card.progress).toBeVisible();
    await expect(card.progress.getByRole("button", { name: "Close" })).toHaveCount(0);
    await card.progress.getByRole("button", { name: "Hide" }).click();
    await expect(card.progress).toBeHidden();
    await expect(card.banner).toContainText("Swap in progress");
    await expect(card.primary).toHaveCount(0);
    await expect(card.amount).toHaveAttribute("readonly", "");
    await expect(card.walletButton()).toBeDisabled();
    await card.banner.getByRole("button", { name: "View" }).click();
    await expect(card.progress).toBeVisible();

    await hubCompletes(card, hub);
    await expect(page.getByRole("dialog", { name: "Swap" })).toBeVisible();
    await expect(card.result).toContainText("2,000 sats");
    await expect(card.result).toContainText(`${BTC_TO_CKB.ckb} CKB`);
    await card.openResultDetails();
    await expect(card.result).toContainText(hub.current.id);
    await expect(card.result).toContainText("Checked in this page");

    // New swap puts the run away and quotes the same amount again.
    const quotes = hub.count("POST /v1/quotes");
    await card.progress.getByRole("button", { name: "New swap" }).click();
    await expect(card.progress).toBeHidden();
    await card.expectPrimary("Swap", { enabled: true });
    expect(hub.count("POST /v1/quotes")).toBe(quotes + 1);
    expect(hub.count("POST /v1/swaps")).toBe(1);
    expect(hub.requests.filter((r) => r.includes("/v1/demo/"))).toEqual([]);
  });

  test("CKB to BTC: the visitor's invoice is step 1, the node pays the hub's hold invoice once", async ({ card, hub, context }) => {
    test.setTimeout(NODE_TEST_TIMEOUT_MS);
    await installFakeNode(context, { channels: [hubChannel({ local: units(20_000), remote: units(0) })] });
    const node = await openRunningNode(context);
    await card.open();
    await card.chooseFiber("browser-node");
    await card.flipTo("fiber_to_ln");
    const invoice = visitorInvoice();
    await card.pasteInvoice(invoice);
    await expect(card.amount).toHaveValue(CKB_TO_BTC.ckb, { timeout: STEP_TIMEOUT_MS });
    await card.swap();

    await card.expectStep(1, "done", "Your pasted invoice");
    await expect(card.step(1)).toContainText("Your invoice");
    await card.expectStep(2, "done", "Locked");
    expect(hub.swapBodies).toEqual([expect.objectContaining({ quoteId: hub.lastQuote.id, payoutInvoice: invoice })]);
    await card.expectStep(3, "active", "Sent; waiting for the hub");
    expect(await nodeCalls(node, "send_payment")).toEqual([expect.objectContaining({ invoice: hub.current.pay.invoice })]);

    await hubCompletes(card, hub);
    await expect(card.result).toContainText(`${CKB_TO_BTC.satsText} sats`);
    await expect(card.result).toContainText(`${CKB_TO_BTC.ckb} CKB`);
    expect(await nodeCalls(node, "send_payment")).toHaveLength(1);
    // The spent invoice is forgotten.
    await card.progress.getByRole("button", { name: "New swap" }).click();
    await expect(card.lnInvoice).toHaveValue("");
  });

  test("RUSD: BTC to RUSD with the browser node's RUSD channel; the node's invoice asks for the RUSD token", async ({ card, hub, context }) => {
    test.setTimeout(NODE_TEST_TIMEOUT_MS);
    await installFakeNode(context, { channels: [hubChannel({ local: units(0), remote: units(100), udt: RUSD_SCRIPT })] });
    const node = await openRunningNode(context);
    await card.open();
    await card.chooseFiber("browser-node");
    await card.pickToken("receive", "RUSD");
    await card.type(BTC_TO_RUSD.sats);
    await expect(card.receiveAmount).toHaveText(BTC_TO_RUSD.rusd, { timeout: STEP_TIMEOUT_MS });
    expect(hub.quoteBodies.at(-1)).toEqual({ direction: "ln_to_fiber", asset: "RUSD", side: "pay", amount: BTC_TO_RUSD.sats });
    await card.swap();

    await card.expectStep(1, "done", "Invoice ready");
    const [asked] = await nodeCalls(node, "new_invoice");
    expect(asked?.udt_type_script).toEqual({ code_hash: RUSD_SCRIPT.codeHash, hash_type: RUSD_SCRIPT.hashType, args: RUSD_SCRIPT.args });
    await card.expectStep(3, "active");
    await hubCompletes(card, hub);
    await expect(card.result).toContainText(`${BTC_TO_RUSD.rusd} RUSD`);
  });
});

/* ----------------------------------------------------------------------------------------- own node */

test.describe("the user's own Fiber node", () => {
  test("CKB to BTC: the hub's Fiber hold invoice to pay by hand, as a QR code with Copy; the hub's state moves the run", async ({ card, hub, context, page }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await readyOwnNodeToLightning(card);
    await card.swap();
    await card.expectStep(1, "done", "Your pasted invoice");
    await card.expectStep(2, "done", "Locked");
    await card.expectStep(3, "active", "Pay the invoice below from your node");

    const manual = card.manualInvoice;
    await expect(manual).toContainText("Pay this from your Fiber node");
    await expect(manual.getByRole("img", { name: "QR code of the hub's Fiber invoice to pay" })).toBeVisible();
    await expect(manual).toContainText(hub.current.pay.invoice);
    expect(await readTip(page, "About paying from your own node")).toContain("send_payment");
    await manual.getByRole("button", { name: "Copy invoice" }).click();
    await expect(manual.getByRole("button", { name: "Copied" })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(hub.current.pay.invoice);

    // The send_payment call that pays it with fnn: the hub's invoice, the fee capped at 0.5 % of what the visitor pays.
    const command = manual.getByTestId("swap-manual-command");
    await command.getByTestId("swap-manual-command-toggle").click();
    const maxFee = (BigInt(hub.lastQuote.pay.amount) * BigInt(5)) / BigInt(1000);
    const pay = await command.getByTestId("swap-manual-command-text").textContent();
    expect(pay).toContain("curl -s -X POST http://127.0.0.1:8227");
    expect(rpcOf(pay)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "send_payment",
      params: [{ invoice: hub.current.pay.invoice, max_fee_amount: `0x${maxFee.toString(16)}` }],
    });
    await command.getByRole("button", { name: "Copy command" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(pay);
    await expectNoHorizontalOverflow(page);

    hub.holdPayment();
    await card.expectStep(3, "done", "The hub holds your payment");
    await expect(card.manualInvoice).toHaveCount(0);
    hub.startPayout();
    hub.settle();
    await expect(card.result).toContainText("Swap complete", { timeout: STEP_TIMEOUT_MS });
    await expect(card.result).toContainText(`${CKB_TO_BTC.satsText} sats`);
  });

  test("BTC to CKB: the new_invoice call for the quote (sha256, exact amount, testnet), copied; gone once the swap runs", async ({ card, hub, context, page }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await card.open();
    await card.chooseFiber("own-node");
    await expect(card.page.getByTestId("swap-own-invoice-command")).toHaveCount(0);
    await card.type(BTC_TO_CKB.sats);
    await card.expectPrimary("Paste your Fiber invoice", { enabled: true });

    const command = card.page.getByTestId("swap-own-invoice-command");
    await command.getByTestId("swap-own-invoice-command-toggle").click();
    await expect(command).toContainText("sha256");
    const text = await command.getByTestId("swap-own-invoice-command-text").textContent();
    expect(rpcOf(text)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "new_invoice",
      params: [
        {
          amount: `0x${BigInt(hub.lastQuote.receive.amount).toString(16)}`,
          currency: "Fibt",
          description: "CKBolt swap payout",
          expiry: "0xe10",
          hash_algorithm: "sha256",
        },
      ],
    });
    await command.getByRole("button", { name: "Copy command" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text);
    await expectNoHorizontalOverflow(page);

    await card.ownInvoice.fill(ownNodeInvoice(hub));
    await card.swap();
    await expect(card.page.getByTestId("swap-own-invoice-command")).toHaveCount(0);
  });

  test("BTC to RUSD: the new_invoice call names the token's type script from the hub", async ({ card, hub }) => {
    await card.open();
    await card.chooseFiber("own-node");
    await card.pickToken("receive", "RUSD");
    await card.type(BTC_TO_RUSD.sats);
    await expect(card.receiveAmount).toHaveText(BTC_TO_RUSD.rusd, { timeout: STEP_TIMEOUT_MS });
    const command = card.page.getByTestId("swap-own-invoice-command");
    await command.getByTestId("swap-own-invoice-command-toggle").click();
    const params = rpcOf(await command.getByTestId("swap-own-invoice-command-text").textContent()).params[0];
    expect(params.amount).toBe(`0x${BigInt(hub.lastQuote.receive.amount).toString(16)}`);
    expect(params.udt_type_script).toEqual({ code_hash: RUSD_SCRIPT.codeHash, hash_type: RUSD_SCRIPT.hashType, args: RUSD_SCRIPT.args });
  });
});

/* ------------------------------------------------------------------------------------------------ history */

test.describe("the swaps the card starts, kept for the Fiber node's History", () => {
  test("kept as soon as the hub created the swap and following the hub's state, with nothing a wallet holds", async ({ card, hub, page }) => {
    await readyOwnNodeToLightning(card);
    await card.swap();
    await card.expectStep(3, "active", "Pay the invoice below from your node");
    const kept = () => page.evaluate(() => JSON.parse(localStorage.getItem("ckbolt:swap-history:testnet") ?? "[]") as { id: string; state: string }[]);
    await expect.poll(kept).toEqual([expect.objectContaining({ id: hub.current.id, state: "pending" })]);
    await hubCompletes(card, hub);
    await expect.poll(kept).toEqual([expect.objectContaining({ id: hub.current.id, state: "succeeded", funded: true })]);
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }));
    for (const secret of [hub.current.pay.invoice, hub.current.receive.invoice, hub.preimage]) expect(stored).not.toContain(secret);
  });

  test("History is not a tab of the app: an old link to it opens the page as usual", async ({ card: _card, page }) => {
    await page.goto("/app?tab=history&swap=22222222-2222-4222-8222-222222222222");
    await expect(page.getByRole("tab", { name: "Swap" })).toHaveAttribute("aria-selected", "true", { timeout: CARD_TIMEOUT_MS });
    await expect(page.getByRole("tab", { name: "History" })).toHaveCount(0);
  });
});

/* -------------------------------------------------------------------------------- when it does not complete */

test.describe("when a swap does not complete", () => {
  test("refund: the hub could not pay out, so the payment goes back: Refund pending, then Refunded with the hub's reason", async ({ card, hub, page }) => {
    await readyOwnNodeToFiber(card, hub);
    await card.swap();
    await card.expectStep(3, "active", "Pay the invoice below");
    hub.holdPayment();
    await card.expectStep(3, "done");
    hub.startPayout();
    await card.expectStep(4, "active");

    const reason = "The hub could not route a payment to your Fiber node.";
    hub.failPayout(reason, false);
    await expect(card.result).toContainText("Refund pending", { timeout: STEP_TIMEOUT_MS });
    await expect(card.result).toContainText("Your payment returns when the hub cancels the hold.");
    // Not over yet: the dialog still cannot be dismissed.
    await page.keyboard.press("Escape");
    await expect(card.progress).toBeVisible();

    hub.failPayout(reason, true);
    await expect(card.result).toContainText("Refunded: your payment went back to your wallet", { timeout: STEP_TIMEOUT_MS });
    await card.openResultDetails();
    await expect(card.result).toContainText("Hub's reason");
    await expect(card.result).toContainText(reason);

    // Over: it closes like any dialog, and the card is ready for a new swap.
    await card.closeDialog(card.progress);
    await expect(card.banner).toHaveCount(0);
    await expect(card.primary).toBeVisible();
  });

  test("cancel: nothing was paid before the quote ran out; Swap cancelled, and Try again gets a new quote", async ({ card, hub }) => {
    await readyOwnNodeToFiber(card, hub);
    await card.swap();
    await card.expectStep(3, "active", "Pay the invoice below");
    const reason = "The quote expired before your payment arrived.";
    hub.cancel(reason);
    await expect(card.result).toContainText("Swap cancelled", { timeout: STEP_TIMEOUT_MS });
    await expect(card.result).toContainText("Nothing was paid.");
    await card.openResultDetails();
    await expect(card.result).toContainText(reason);

    const quotes = hub.count("POST /v1/quotes");
    await card.progress.getByRole("button", { name: "Try again" }).click();
    await expect(card.progress).toBeHidden();
    await card.expectPrimary("Paste your Fiber invoice", { enabled: true });
    expect(hub.count("POST /v1/quotes")).toBe(quotes + 1);
  });

  test("a quote that expires before the swap is locked fails that step, pays nothing, and offers a new quote", async ({ card, hub }) => {
    hub.fail("POST /v1/swaps", { status: 410, body: apiError("quote_expired", "This quote expired before the swap was created."), times: 1 });
    await readyOwnNodeToLightning(card);
    await card.swap();
    await card.expectStep(1, "done");
    await card.expectStep(2, "failed", "The quote expired. Get a new one.");
    await expect(card.step(3)).toHaveAttribute("data-status", "pending");

    const quotes = hub.count("POST /v1/quotes");
    await card.progress.getByRole("button", { name: "Get a new quote" }).click();
    await expect(card.progress).toBeHidden();
    await card.expectPrimary(PASTE_LN, { enabled: true });
    expect(hub.count("POST /v1/quotes")).toBe(quotes);
    expect(hub.count("POST /v1/swaps")).toBe(1);
  });
});

/* ------------------------------------------------------------------------- report a problem, maintenance */

test.describe("report a problem and maintenance", () => {
  test("F9.1: the result links to a new issue in a new tab, with the swap id in its title and body", async ({ card, hub }) => {
    await readyOwnNodeToLightning(card);
    await card.swap();
    await expect(card.manualInvoice).toBeVisible({ timeout: STEP_TIMEOUT_MS });
    await hubCompletes(card, hub);
    const report = card.result.getByRole("link", { name: /Report a problem/ });
    await expect(report).toHaveAttribute("target", "_blank");
    const href = new URL((await report.getAttribute("href"))!);
    expect(`${href.origin}${href.pathname}`).toBe("https://github.com/Tech-Expansion/CKBolt/issues/new");
    expect(href.searchParams.get("title")).toBe(`Problem with swap ${hub.current.id}`);
    expect(href.searchParams.get("body")).toContain(`Swap id: ${hub.current.id}\nThis report and its swap id are public; testnet swaps hold no real value.`);
  });

  test("P7: while the hub's health says swaps are paused, the button says so, disabled, and no quote is asked for", async ({ card, hub }) => {
    hub.health = { ...hub.health, swaps: { paused: true } };
    await card.open();
    await card.expectPrimary("Swaps paused", { enabled: false });
    await card.type(BTC_TO_CKB.sats);
    await card.expectPrimary("Swaps paused", { enabled: false });
    await expect(card.error).toHaveText("Swaps are paused for maintenance. Try again later.");
    await card.page.waitForTimeout(QUOTE_SETTLE_MS);
    expect(hub.count("POST /v1/quotes")).toBe(0);
  });

  test("P7: a quote refused with maintenance pauses the card the same way, the hub's sentence behind a ?", async ({ card, hub, page }) => {
    const sentence = "Swaps are paused for maintenance. Running swaps finish.";
    hub.fail("POST /v1/quotes", { status: 503, body: apiError("maintenance", sentence) });
    await card.open();
    await card.type(BTC_TO_CKB.sats);
    await card.expectPrimary("Swaps paused", { enabled: false });
    await expect(card.error).toContainText("Swaps are paused for maintenance. Try again later.");
    expect(await readTip(page, "About this error")).toContain(sentence);
  });
});

/* ------------------------------------------------------------------------------------- layout, a11y */

test.describe("layout and accessibility", () => {
  test("axe finds nothing serious: the card at rest and quoted both ways, the Fiber dialog, How it works, both hold invoices, the result", async ({ card, hub, page }) => {
    test.setTimeout(AXE_TEST_TIMEOUT_MS);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const webln = new FakeWebln();
    await webln.install(page);
    await card.open();
    await expectNoSeriousAxe(page, '[data-testid="swap-card"]');

    const fiber = await card.openWalletDialog();
    await expectNoSeriousAxe(page, '[data-testid="wallet-dialog-fiber"]');
    await fiber.getByTestId("fiber-option-own-node").click();
    await card.closeDialog(fiber);

    await page.getByTestId("how-it-works").click();
    await expect(page.getByRole("dialog", { name: "How it works" })).toBeVisible();
    await expectNoSeriousAxe(page, '[role="dialog"]');
    await card.closeDialog(page.getByRole("dialog", { name: "How it works" }));

    // BTC to CKB: the Lightning hold invoice with its QR code and buttons.
    await card.type(BTC_TO_CKB.sats);
    await card.expectPrimary("Paste your Fiber invoice", { enabled: true });
    await card.ownInvoice.fill(ownNodeInvoice(hub));
    await card.swap();
    await expect(card.holdInvoice.getByTestId("swap-webln")).toBeVisible({ timeout: STEP_TIMEOUT_MS });
    await expectNoSeriousAxe(page, '[data-testid="swap-progress"]');
    hub.cancel("The quote expired.");
    await expect(card.result).toContainText("Swap cancelled", { timeout: STEP_TIMEOUT_MS });
    await card.progress.getByRole("button", { name: "Try again" }).click();

    // CKB to BTC: the visitor's invoice, a refusal, then the own node's Fiber hold invoice and the result.
    await card.flipTo("fiber_to_ln");
    await card.pasteInvoice(amountlessInvoice());
    await expect(card.error).toBeVisible();
    await expectNoSeriousAxe(page, '[data-testid="swap-card"]');
    await card.pasteInvoice(visitorInvoice());
    await card.expectPrimary("Swap", { enabled: true });
    await card.details.getByRole("button", { name: "Details" }).click();
    await expectNoSeriousAxe(page, '[data-testid="swap-card"]');
    await card.swap();
    await expect(card.manualInvoice).toBeVisible({ timeout: STEP_TIMEOUT_MS });
    await expectNoSeriousAxe(page, '[data-testid="swap-progress"]');
    await hubCompletes(card, hub);
    await card.openResultDetails();
    await expectNoSeriousAxe(page, '[data-testid="swap-progress"]');
  });

  test("nothing is wider than a 390 px screen: the card at rest and quoted, its fields and dialog, both hold invoices, the result", async ({ card, hub, page }) => {
    await page.setViewportSize(PHONE);
    const webln = new FakeWebln();
    await webln.install(page);
    await card.open();
    await expectNoHorizontalOverflow(page);
    await expectInsideViewport(card.card);

    const fiber = await card.openWalletDialog();
    await expectInsideViewport(fiber);
    await fiber.getByTestId("fiber-option-own-node").click();
    await card.closeDialog(fiber);

    // The own node's invoice field holds a long fibt invoice.
    await card.type(BTC_TO_CKB.sats);
    await card.expectPrimary("Paste your Fiber invoice", { enabled: true });
    await card.ownInvoice.fill(ownNodeInvoice(hub));
    await card.details.getByRole("button", { name: "Details" }).click();
    await expectNoHorizontalOverflow(page);
    await expectInsideViewport(card.card);

    await page.getByTestId("how-it-works").click();
    const guide = page.getByRole("dialog", { name: "How it works" });
    await expectInsideViewport(guide);
    await card.closeDialog(guide);

    // The Lightning hold invoice, its QR code and buttons.
    await card.swap();
    await expect(card.holdInvoice.getByTestId("swap-webln")).toBeVisible({ timeout: STEP_TIMEOUT_MS });
    await expectInsideViewport(card.progress);
    hub.cancel("The quote expired.");
    await expect(card.result).toContainText("Swap cancelled", { timeout: STEP_TIMEOUT_MS });
    await card.progress.getByRole("button", { name: "Try again" }).click();

    // The visitor's long Lightning invoice, the scanner, then the Fiber hold invoice and the result.
    await card.flipTo("fiber_to_ln");
    await card.pasteInvoice(visitorInvoice());
    await card.page.getByTestId("swap-ln-invoice-scan").click();
    await expectNoHorizontalOverflow(page);
    await expectInsideViewport(card.card);
    await card.page.getByTestId("swap-ln-invoice-scan").click();
    await card.swap();
    await expect(card.manualInvoice).toBeVisible({ timeout: STEP_TIMEOUT_MS });
    await expectInsideViewport(card.progress);
    await hubCompletes(card, hub);
    await card.openResultDetails();
    await expectInsideViewport(card.progress);
  });
});

/* ------------------------------------------------------------------------------------------ no live hub */

test.describe("without a live hub", () => {
  test("Swap says the hub is not available, in one line; no card, no simulation, no L1 wallets", async ({ page, context }) => {
    await isolate(context);
    await installNoHub(context);
    await page.goto("/app?mode=swap");
    const panel = page.getByTestId("mode-swap");
    await expect(panel.getByTestId("hub-unavailable")).toHaveText("The CKBolt testnet hub is not available right now. Try again later.", {
      timeout: CARD_TIMEOUT_MS,
    });
    await expect(page.getByTestId("swap-card")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Connect CKB wallet|Execute swap/ })).toHaveCount(0);
    for (const id of ["ckb-wallet", "btc-wallet"]) await expect(page.getByTestId(id)).toHaveCount(0);
  });
});
