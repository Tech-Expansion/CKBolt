import { test as base, expect, type Page } from "@playwright/test";
import { lightningInvoice } from "./fakes/hub";
import { expectNoHorizontalOverflow, expectNoSeriousAxe } from "./page-checks";
import {
  createRunningNode,
  CWBTC_INBOUND_AMOUNT,
  CWBTC_SCRIPT,
  deliverHubUdtChannel,
  hubChannel,
  installFakeNode,
  nodeCalls,
  nodeWhitelist,
  NODE_PASSWORD,
  openRunningNode,
  RUSD_SCRIPT,
  units,
} from "./support/fiber-node";
import { WALLET_TIMEOUT_MS } from "./support/fiber-wallet";
import { isolate, LiveHub } from "./support/live-hub";
import { STEP_TIMEOUT_MS, SwapCard } from "./support/swap-card";
import { DISPLAY_NAME_MAX_LENGTH } from "../../lib/token-display";

/*
 * More tokens than CKB and RUSD, with cWBTC (CCH Wrapped BTC, 8 decimals, quoted 1:1 with BTC) as the hub serves it
 * once its FIBER_ASSETS lists it (support/live-hub.ts `serveCwbtc`): nothing in the app names it, so the swap card, Pay
 * and Get paid offer it from GET /v1/assets alone; the browser node whitelists it from GET /v1/fiber/node's
 * `udtWhitelist` at start, takes the hub's cWBTC channel by itself (the fake fnn's whitelist,
 * support/fiber-node.ts `deliverHubUdtChannel`), and asks for a restart when it started without it; the faucet link;
 * axe and a 390 px screen. Nothing reaches a real network.
 */

const TEST_TIMEOUT_MS = 150_000;
/** The page asks the node tab for its status every 5 s. */
const NODE_STATUS_TIMEOUT_MS = 15_000;
const PHONE = { width: 390, height: 844 };
const CWBTC_TOKEN = { codeHash: CWBTC_SCRIPT.codeHash, hashType: CWBTC_SCRIPT.hashType, args: CWBTC_SCRIPT.args };
const RPC_CWBTC = { code_hash: CWBTC_SCRIPT.codeHash, hash_type: CWBTC_SCRIPT.hashType, args: CWBTC_SCRIPT.args };
/**
 * As the fake prices cWBTC (1:1 with BTC, 1 % fee; 1 base unit = 1 sat): 2,000 sats buy 1,980 base units, and an
 * invoice for 24,750 sats costs 25,000.
 */
const BTC_TO_CWBTC = { sats: "2000", cwbtc: "0.0000198" } as const;
const CWBTC_TO_BTC = { sats: 24_750, satsText: "24,750", cwbtc: "0.00025" } as const;
/** Get paid: 0.0001 cWBTC received costs a Lightning payer 10,102 sats; it is worth $8 at the fake's BTC price. */
const REQUEST = { cwbtc: "0.0001", units: "10000", conversion: "≈ $8.00 · 10,102 sats on Lightning" } as const;
const FAUCET = "https://faucet-cwbtc.ckb.dev";

const test = base.extend<{ hub: LiveHub }>({
  hub: async ({ context }, use) => {
    await isolate(context);
    const hub = new LiveHub().serveCwbtc();
    await hub.install(context);
    await use(hub);
  },
});

/** The node page's channel panel. */
const hubPanel = (page: Page) => page.getByTestId("fiber-node-hub");
/** "Channel with the hub": a row per asset, its checkbox named by the symbol, the one button, the run's summary. */
const hubRow = (page: Page, asset: string) => hubPanel(page).getByTestId(`fiber-node-hub-row-${asset}`);
const hubBox = (page: Page, symbol: string) => hubPanel(page).getByRole("checkbox", { name: symbol, exact: true });
const hubOpen = (page: Page) => hubPanel(page).getByTestId("fiber-node-hub-open");
const hubSummary = (page: Page) => hubPanel(page).getByTestId("fiber-node-hub-summary");

/** The hub holds the payment, pays out and settles. */
function hubCompletes(hub: LiveHub) {
  hub.holdPayment();
  hub.startPayout();
  hub.settle();
}

/* ------------------------------------------------------------------------------------ names and icons from the hub */

/** cWBTC's icon as docs/add-token.md (ckbolt-hub) configures it on testnet-vps: an orange disc with a white B, inline SVG. */
const CWBTC_HUB_ICON =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PGNpcmNsZSBjeD0iMTYiIGN5PSIxNiIgcj0iMTYiIGZpbGw9IiNmNzkzMWEiLz48cGF0aCBkPSJNMTEgOGg3YTQgNCAwIDAgMSAwIDhoLTd6bTAgOGg4YTQgNCAwIDAgMSAwIDhoLTh6IiBmaWxsPSJub25lIiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iMi41Ii8+PC9zdmc+";
/** An https icon on another host: isolate() refuses every request off this server, as a broken URL or COEP would. */
const BROKEN_HTTPS_ICON = "https://icons.example.test/ckb.svg";
/** Not an image the page takes (a data URL of another type): never used. */
const REFUSED_ICON = "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==";

/** The hub's display data, as its FIBER_ASSETS would set it: cWBTC named and drawn, CKB's icon broken, RUSD's refused. */
function hubDisplayData(hub: LiveHub) {
  const set = (id: string, patch: { displayName?: string | null; iconUrl?: string | null }) => Object.assign(hub.assets.find((a) => a.id === id)!, patch);
  set("CWBTC", { displayName: "Wrapped BTC (test)", iconUrl: CWBTC_HUB_ICON });
  set("CKB", { iconUrl: BROKEN_HTTPS_ICON });
  // A name with a bidi override is refused too: the app's own name shows.
  set("RUSD", { displayName: "\u202eDSUR", iconUrl: REFUSED_ICON });
}

test.describe("names and icons from the hub (GET /v1/assets displayName and iconUrl)", () => {
  test("the picker, the hub channel card and History show the hub's name and inline SVG; a broken icon falls back, a refused one is never used; axe, 390 px", async ({
    page,
    hub,
    context,
  }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    await page.setViewportSize(PHONE);
    hubDisplayData(hub);
    hub.openUdtChannels = true;
    await installFakeNode(context);

    // The swap card's picker: the hub's display name and icon for cWBTC; CKB's broken icon gives way to the app's own;
    // RUSD's refused icon is never put in the page, and its initials show with the app's name for it.
    const card = new SwapCard(page);
    await card.open();
    await page.getByTestId("swap-token-receive").click();
    const list = page.getByTestId("swap-token-list");
    const option = (symbol: string) => list.getByRole("button", { name: new RegExp(`^${symbol}\\b`) });
    await expect(option("cWBTC")).toContainText("Wrapped BTC (test)");
    await expect(option("cWBTC")).not.toContainText("CCH Wrapped BTC");
    await expect(option("CKB").locator("img")).toHaveAttribute("src", "/tokens/ckb.svg");
    await expect(option("cWBTC").locator("img")).toHaveAttribute("src", CWBTC_HUB_ICON);
    expect(await option("cWBTC").locator("img").evaluate((img: HTMLImageElement) => img.complete)).toBe(true);
    await expect(option("RUSD")).toContainText("Stable++ USD stablecoin");
    await expect(option("RUSD").locator("img")).toHaveCount(0);
    await expect(option("RUSD").locator("[data-token-icon=initials]")).toHaveText("RU");
    await expect(page.locator(`img[src="${REFUSED_ICON}"], img[src^="data:text"]`)).toHaveCount(0);
    // Icons are images only: no SVG markup from the hub is in the page.
    expect(await page.locator("svg circle[fill='#f7931a']").count()).toBe(0);
    await expectNoSeriousAxe(page);
    await page.keyboard.press("Escape");
    await card.pickToken("receive", "cWBTC");
    await expect(page.getByTestId("swap-token-receive").locator("img")).toHaveAttribute("src", CWBTC_HUB_ICON);
    await expectNoHorizontalOverflow(page);

    // The node page (cross-origin isolated: an inline SVG needs no request, so it shows there too): the card's rows.
    const node = await openRunningNode(context);
    await node.setViewportSize(PHONE);
    const nodeRow = (asset: string) => hubRow(node, asset);
    await expect(nodeRow("CWBTC").getByTestId("fiber-node-hub-name-CWBTC")).toHaveText("Wrapped BTC (test)");
    await expect(nodeRow("CWBTC").locator("img")).toHaveAttribute("src", CWBTC_HUB_ICON);
    await expect(nodeRow("CKB").locator("img")).toHaveAttribute("src", "/tokens/ckb.svg");
    await expect(nodeRow("CKB").getByTestId("fiber-node-hub-name-CKB")).toHaveText("Nervos CKB");
    await expect(nodeRow("RUSD").locator("[data-token-icon=initials]")).toHaveText("RU");
    // The checkbox keeps the symbol as its name.
    await expect(hubBox(node, "cWBTC")).toBeVisible();

    // History: the cWBTC channel asked for, its detail naming the token as the hub does.
    await hubBox(node, "cWBTC").check();
    await hubOpen(node).click();
    await expect(hubSummary(node)).toHaveText("Channel asked for. It reads Ready after a few confirmations.", { timeout: STEP_TIMEOUT_MS });
    const entry = node.getByTestId("history-entry").filter({ hasText: "channel with the CKBolt hub" });
    await expect(entry).toHaveCount(1, { timeout: NODE_STATUS_TIMEOUT_MS });
    await entry.getByRole("button").first().click();
    const token = entry.getByTestId("history-entry-token");
    await expect(token).toContainText("Wrapped BTC (test) (cWBTC)");
    await expect(token.locator("img")).toHaveAttribute("src", CWBTC_HUB_ICON);
    await expectNoSeriousAxe(node);
    await expectNoHorizontalOverflow(node);
  });

  test("the longest name the hub may set (64 wide characters) stays within a 390 px screen: the picker and the card's row", async ({
    page,
    hub,
    context,
  }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    await page.setViewportSize(PHONE);
    const longest = "W".repeat(DISPLAY_NAME_MAX_LENGTH);
    Object.assign(hub.assets.find((a) => a.id === "CWBTC")!, { displayName: longest });
    await installFakeNode(context);

    const card = new SwapCard(page);
    await card.open();
    await page.getByTestId("swap-token-receive").click();
    const option = page.getByTestId("swap-token-list").getByRole("button", { name: /^cWBTC\b/ });
    await expect(option).toContainText(longest);
    const list = await page.getByTestId("swap-token-list").boundingBox();
    expect(list!.x + list!.width).toBeLessThanOrEqual(PHONE.width);
    await page.keyboard.press("Escape");
    await expectNoHorizontalOverflow(page);

    const node = await openRunningNode(context);
    await node.setViewportSize(PHONE);
    await expect(hubRow(node, "CWBTC").getByTestId("fiber-node-hub-name-CWBTC")).toHaveText(longest);
    // The row's status stays on screen beside the cut name.
    const badge = await hubRow(node, "CWBTC").getByText("Not open", { exact: true }).boundingBox();
    expect(badge!.x + badge!.width).toBeLessThanOrEqual(PHONE.width);
    await expectNoHorizontalOverflow(node);
  });
});

/* ------------------------------------------------------------------------------------------- the swap card */

test.describe("cWBTC on the swap card, from the hub's assets alone", () => {
  test("BTC to cWBTC: the picker offers cWBTC; the node's invoice asks for cWBTC's token; the hub pays out", async ({ page, hub, context }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    await installFakeNode(context, { channels: [hubChannel({ local: units(0), remote: units(1), udt: CWBTC_SCRIPT })] });
    const node = await openRunningNode(context);
    const card = new SwapCard(page);
    await card.open();
    await card.chooseFiber("browser-node");
    // The picker lists what GET /v1/assets serves this way, in the hub's order, with the app's name for cWBTC.
    await page.getByTestId("swap-token-receive").click();
    const list = page.getByTestId("swap-token-list");
    await expect(list.getByRole("button")).toHaveCount(3);
    await expect(list.getByRole("button", { name: /^cWBTC/ })).toContainText("CCH Wrapped BTC (test)");
    await page.keyboard.press("Escape");
    await card.pickToken("receive", "cWBTC");
    await card.type(BTC_TO_CWBTC.sats);
    await expect(card.receiveAmount).toHaveText(BTC_TO_CWBTC.cwbtc, { timeout: STEP_TIMEOUT_MS });
    expect(hub.quoteBodies.at(-1)).toEqual({ direction: "ln_to_fiber", asset: "CWBTC", side: "pay", amount: BTC_TO_CWBTC.sats });
    await card.swap();
    await card.expectStep(1, "done", "Invoice ready");
    const [asked] = await nodeCalls(node, "new_invoice");
    expect(asked?.udt_type_script).toEqual(RPC_CWBTC);
    expect(BigInt(String(asked?.amount))).toBe(BigInt(1_980));
    await card.expectStep(3, "active", "Pay the invoice below");
    hubCompletes(hub);
    await expect(card.result).toContainText("Swap complete", { timeout: STEP_TIMEOUT_MS });
    await expect(card.result).toContainText(`${BTC_TO_CWBTC.cwbtc} cWBTC`);
  });

  test("cWBTC to BTC: the visitor's invoice fixes the amount in cWBTC; the node pays the hub's hold invoice once", async ({ page, hub, context }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    await installFakeNode(context, { channels: [hubChannel({ local: units(1), remote: units(0), udt: CWBTC_SCRIPT })] });
    const node = await openRunningNode(context);
    const card = new SwapCard(page);
    await card.open();
    await card.chooseFiber("browser-node");
    await card.flipTo("fiber_to_ln");
    await card.pickToken("pay", "cWBTC");
    const invoice = lightningInvoice({ sats: CWBTC_TO_BTC.sats });
    await card.pasteInvoice(invoice);
    await expect(card.amount).toHaveValue(CWBTC_TO_BTC.cwbtc, { timeout: STEP_TIMEOUT_MS });
    expect(hub.quoteBodies.at(-1)).toEqual({ direction: "fiber_to_ln", asset: "CWBTC", side: "receive", amount: String(CWBTC_TO_BTC.sats) });
    await card.swap();
    await card.expectStep(1, "done", "Your pasted invoice");
    await card.expectStep(3, "active", "Sent; waiting for the hub");
    expect(await nodeCalls(node, "send_payment")).toEqual([expect.objectContaining({ invoice: hub.current.pay.invoice })]);
    expect(hub.current.pay).toMatchObject({ asset: "CWBTC", amount: "25000" });
    hubCompletes(hub);
    await expect(card.result).toContainText("Swap complete", { timeout: STEP_TIMEOUT_MS });
    await expect(card.result).toContainText(`${CWBTC_TO_BTC.cwbtc} cWBTC`);
    await expect(card.result).toContainText(`${CWBTC_TO_BTC.satsText} sats`);
    expect(await nodeCalls(node, "send_payment")).toHaveLength(1);
  });

  test("How it works and the Fiber node's dialog name the hub's assets, cWBTC included", async ({ page, hub: _hub }) => {
    const card = new SwapCard(page);
    await card.open();
    await page.getByTestId("how-it-works").click();
    const guide = page.getByTestId("how-it-works-guide");
    await expect(guide).toContainText("CKB, RUSD, cWBTC");
    await page.keyboard.press("Escape");
    await expect(guide).toBeHidden();
    const dialog = await card.openWalletDialog();
    await expect(dialog).toContainText("CKB, RUSD, and cWBTC on CKB L2");
  });
});

/* ---------------------------------------------------------------------------------------- Pay, Get paid */

test.describe("Pay and Get paid in cWBTC", () => {
  test("Pay a Lightning invoice with cWBTC: picked with the token picker, quoted exact out, paid by the node", async ({ page, hub, context }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    await installFakeNode(context, { channels: [hubChannel({ local: units(1), remote: units(0), udt: CWBTC_SCRIPT })] });
    const node = await openRunningNode(context);
    await page.bringToFront();
    await page.goto("/app?mode=pay");
    const tab = page.getByTestId("mode-pay");
    await expect(tab.getByTestId("pay-card")).toBeVisible({ timeout: WALLET_TIMEOUT_MS });
    const invoice = lightningInvoice({ sats: CWBTC_TO_BTC.sats });
    await tab.getByTestId("pay-input").fill(invoice);
    await expect(tab.getByTestId("pay-kind")).toHaveText("Lightning invoice");
    await tab.getByTestId("pay-token").click();
    await page.getByTestId("swap-token-list").getByRole("button", { name: /^cWBTC/ }).click();
    await expect(tab.getByTestId("pay-amount-due")).toHaveText(`${CWBTC_TO_BTC.cwbtc} cWBTC`, { timeout: STEP_TIMEOUT_MS });
    expect(hub.quoteBodies.at(-1)).toEqual({ direction: "fiber_to_ln", asset: "CWBTC", side: "receive", amount: String(CWBTC_TO_BTC.sats) });
    const confirm = tab.getByTestId("pay-confirm");
    await expect(confirm).toHaveText(`Pay ${CWBTC_TO_BTC.cwbtc} cWBTC`, { timeout: NODE_STATUS_TIMEOUT_MS });
    await confirm.click();
    const result = tab.getByTestId("pay-result");
    await expect(result.getByTestId("swap-step-3")).toContainText("Sent; waiting for the hub", { timeout: STEP_TIMEOUT_MS });
    expect(await nodeCalls(node, "send_payment")).toEqual([expect.objectContaining({ invoice: hub.current.pay.invoice })]);
    hubCompletes(hub);
    await expect(result.getByTestId("swap-result")).toContainText("Swap complete", { timeout: STEP_TIMEOUT_MS });
    await expect(result).toContainText(`${CWBTC_TO_BTC.satsText} sats`);
  });

  test("Get paid in cWBTC: the asset picker offers what the hub serves ln_to_fiber; both invoices are for cWBTC", async ({ page, hub, context }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    await installFakeNode(context, { channels: [hubChannel({ local: units(0), remote: units(1), udt: CWBTC_SCRIPT })] });
    const node = await openRunningNode(context);
    await page.bringToFront();
    await page.goto("/app?mode=receive");
    const tab = page.getByTestId("mode-receive");
    await expect(tab.getByTestId("request-card")).toBeVisible({ timeout: WALLET_TIMEOUT_MS });
    await tab.getByTestId("request-asset").click();
    const list = page.getByTestId("swap-token-list");
    await expect(list.getByRole("button")).toHaveCount(3);
    await list.getByRole("button", { name: /^cWBTC/ }).click();
    await tab.getByTestId("request-amount").fill(REQUEST.cwbtc);
    await expect(tab.getByTestId("request-conversion")).toHaveText(REQUEST.conversion, { timeout: STEP_TIMEOUT_MS });
    expect(hub.quoteBodies.at(-1)).toEqual({ direction: "ln_to_fiber", asset: "CWBTC", side: "receive", amount: REQUEST.units, purpose: "request" });
    const create = tab.getByTestId("request-create");
    await expect(create).toBeEnabled({ timeout: NODE_STATUS_TIMEOUT_MS });
    await create.click();
    await expect(tab.getByTestId("request-fiber").getByTestId("request-fiber-qr")).toBeVisible({ timeout: STEP_TIMEOUT_MS });
    await expect(tab.getByTestId("request-summary")).toContainText(`${REQUEST.cwbtc} cWBTC`);
    const [fiberInvoice] = await nodeCalls(node, "new_invoice");
    expect(fiberInvoice?.udt_type_script).toEqual(RPC_CWBTC);
    expect(BigInt(String(fiberInvoice?.amount))).toBe(BigInt(REQUEST.units));
    // The Lightning invoice, made when its tab opens: the payer pays BTC, the node receives cWBTC.
    await tab.getByTestId("request-tab-lightning").click();
    const lightning = tab.getByTestId("request-lightning");
    await expect(lightning.getByTestId("request-lightning-qr")).toBeVisible({ timeout: STEP_TIMEOUT_MS });
    await expect(lightning).toContainText("They pay BTC on Lightning. You receive cWBTC.");
    const payout = (await nodeCalls(node, "new_invoice"))[1];
    expect(payout?.udt_type_script).toEqual(RPC_CWBTC);
    hubCompletes(hub);
    await expect(tab.getByTestId("request-paid")).toBeVisible({ timeout: STEP_TIMEOUT_MS });
    await expect(tab.getByTestId("request-paid")).toContainText("cWBTC");
  });
});

/* ------------------------------------------------------------------------------- the node's whitelist */

test.describe("the browser node takes the hub's cWBTC channel by its whitelist", () => {
  test("started with the hub's entries, it asks for a cWBTC channel and takes it by itself; no accept_channel", async ({ page, hub, context }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    hub.openUdtChannels = true;
    await installFakeNode(context);
    await page.goto("/app/fiber");
    await createRunningNode(page);
    // fiber-js's RUSD entry replaced by the hub's (anchored, 20 RUSD), cWBTC added; the hub's first.
    expect(await nodeWhitelist(page)).toEqual([
      { name: "RUSD", args: `^${RUSD_SCRIPT.args}$`, autoAccept: "2000000000" },
      { name: "cWBTC", args: `^${CWBTC_SCRIPT.args}$`, autoAccept: CWBTC_INBOUND_AMOUNT },
    ]);
    const panel = hubPanel(page);
    // The hub funds a token channel alone; the node needs only its CKB reserve (the same for any token) and the fee margin.
    await expect(panel.getByTestId("fiber-node-hub-line-CWBTC")).toHaveText("Hub funds 10 cWBTC · needs 181 CKB reserve");
    await expect(panel.getByTestId("fiber-node-hub-restart")).toHaveCount(0);
    await hubBox(page, "cWBTC").check();
    await expect(panel.getByTestId("fiber-node-hub-total")).toHaveText("Needs 181 CKB on chain · you have 600 CKB");
    await expect(hubOpen(page)).toBeEnabled({ timeout: NODE_STATUS_TIMEOUT_MS });
    await hubOpen(page).click();
    await expect(hubSummary(page)).toHaveText("Channel asked for. It reads Ready after a few confirmations.", { timeout: STEP_TIMEOUT_MS });
    expect(hub.fiberChannelBodies.map((b) => b.asset)).toEqual(["CWBTC"]);
    await expect.poll(() => hub.udtOpens).toEqual([{ args: CWBTC_SCRIPT.args, amount: CWBTC_INBOUND_AMOUNT, outcome: "accepted" }]);
    expect(await nodeCalls(page, "accept_channel")).toEqual([]);
    // The channel shows as a cWBTC channel with the hub; its row reads Open and can no longer be ticked.
    await page.getByRole("button", { name: "Refresh channels" }).click();
    await expect(page.getByTestId("fiber-node-channels")).toContainText("cWBTC", { timeout: STEP_TIMEOUT_MS });
    await expect(hubRow(page, "CWBTC")).toHaveAttribute("data-status", "open");
    await expect(panel.getByTestId("fiber-node-hub-line-CWBTC")).toHaveText("You can send 0 cWBTC · receive 10 cWBTC");
    await expect(hubBox(page, "cWBTC")).toBeDisabled();
    await expect(hubBox(page, "cWBTC")).toHaveAttribute("title", "Your node already has a cWBTC channel with the hub.");
  });

  test("started before the hub served cWBTC: the fake fnn refuses its channel; one line asks for a restart, which fixes it; axe, 390 px", async ({
    page,
    hub,
    context,
  }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    await page.setViewportSize(PHONE);
    hub.openUdtChannels = true;
    // The hub serves CKB and RUSD only while the node starts.
    hub.assets = hub.assets.filter((a) => a.id !== "CWBTC");
    hub.fiberNode.assets = hub.fiberNode.assets.filter((a) => a.id !== "CWBTC");
    delete hub.fiberNode.inbound.amounts.CWBTC;
    await installFakeNode(context);
    await page.goto("/app/fiber");
    await createRunningNode(page);
    expect((await nodeWhitelist(page)).map((e) => e.name)).toEqual(["RUSD"]);
    await expect(page.getByTestId("fiber-node-faucet-CWBTC")).toHaveCount(0);

    // Then the hub adds cWBTC; the page reads the hub again after the next request (a RUSD channel, taken as before).
    hub.serveCwbtc();
    await expect(hubRow(page, "CWBTC")).toHaveCount(0);
    await hubBox(page, "RUSD").check();
    await expect(hubOpen(page)).toBeEnabled({ timeout: NODE_STATUS_TIMEOUT_MS });
    await hubOpen(page).click();
    await expect.poll(() => hub.udtOpens.map((o) => o.outcome)).toEqual(["accepted"]);
    const restart = hubPanel(page).getByTestId("fiber-node-hub-restart");
    await expect(restart).toContainText("Restart your node to accept cWBTC channels: lock it, then unlock.", { timeout: STEP_TIMEOUT_MS });
    // cWBTC's row, new from the hub's answer alone, says the node needs a restart and cannot be ticked.
    await expect(hubRow(page, "CWBTC")).toHaveAttribute("data-status", "restart");
    await expect(hubRow(page, "CWBTC")).toContainText("Restart needed");
    await expect(hubBox(page, "cWBTC")).toBeDisabled();
    await expect(hubBox(page, "cWBTC")).toHaveAttribute("title", "Restart your node to accept cWBTC channels: lock it, then unlock.");
    // What the hub's channel would meet now: fnn has no whitelist entry for cWBTC.
    expect(await deliverHubUdtChannel(page, { udt: CWBTC_TOKEN, amount: CWBTC_INBOUND_AMOUNT })).toMatchObject({ outcome: "not_whitelisted" });
    await expectNoSeriousAxe(page);
    await expectNoHorizontalOverflow(page);

    // Lock node, unlock: the node starts again with the hub's whitelist.
    await restart.getByRole("button", { name: "Lock node" }).click();
    const unlock = page.getByTestId("fiber-node-unlock");
    await expect(unlock).toBeVisible({ timeout: STEP_TIMEOUT_MS });
    await unlock.getByLabel("Password", { exact: true }).fill(NODE_PASSWORD);
    await unlock.getByRole("button", { name: "Unlock and start node" }).click();
    await expect(hubPanel(page)).toContainText("Connected", { timeout: WALLET_TIMEOUT_MS });
    expect((await nodeWhitelist(page)).map((e) => e.name)).toEqual(["RUSD", "cWBTC"]);
    await expect(restart).toHaveCount(0);
    await expect(hubRow(page, "CWBTC")).toHaveAttribute("data-status", "available");
    await hubBox(page, "cWBTC").check();
    await expect(hubOpen(page)).toBeEnabled({ timeout: NODE_STATUS_TIMEOUT_MS });
    await hubOpen(page).click();
    await expect.poll(() => hub.udtOpens.map((o) => o.outcome)).toEqual(["accepted", "accepted"]);
  });
});

/* ----------------------------------------------------------------------------------- the faucet, layout */

test.describe("the cWBTC faucet, and the layout", () => {
  test("the node's address shows Get test cWBTC, in a new tab, while the hub serves cWBTC", async ({ page, hub: _hub, context }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    await installFakeNode(context);
    await page.goto("/app/fiber");
    await createRunningNode(page);
    const faucet = page.getByTestId("fiber-node-faucet-CWBTC");
    await expect(faucet).toHaveText("Get test cWBTC");
    await expect(faucet).toHaveAttribute("href", FAUCET);
    await expect(faucet).toHaveAttribute("target", "_blank");
    await expect(faucet).toHaveAttribute("rel", "noopener noreferrer");
    await expect(page.getByTestId("fiber-node-address")).toContainText("Get test cWBTC at faucet-cwbtc.ckb.dev, to this address.");
  });

  test("axe finds nothing serious, and nothing is wider than a 390 px screen: the node with a cWBTC channel and the faucet, the card, Get paid", async ({
    page,
    hub: _hub,
    context,
  }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    await page.setViewportSize(PHONE);
    await installFakeNode(context, { channels: [hubChannel({ local: units(0), remote: units(1), udt: CWBTC_SCRIPT })] });
    const node = await context.newPage();
    await node.setViewportSize(PHONE);
    await node.goto("/app/fiber");
    await createRunningNode(node);
    await expect(node.getByTestId("fiber-node-faucet-CWBTC")).toBeVisible();
    await expect(hubRow(node, "CWBTC")).toHaveAttribute("data-status", "open", { timeout: NODE_STATUS_TIMEOUT_MS });
    await expectNoSeriousAxe(node);
    await expectNoHorizontalOverflow(node);

    await page.bringToFront();
    const card = new SwapCard(page);
    await card.open();
    await card.chooseFiber("browser-node");
    await card.pickToken("receive", "cWBTC");
    await card.type(BTC_TO_CWBTC.sats);
    await expect(card.receiveAmount).toHaveText(BTC_TO_CWBTC.cwbtc, { timeout: STEP_TIMEOUT_MS });
    await expectNoSeriousAxe(page);
    await expectNoHorizontalOverflow(page);

    await page.goto("/app?mode=receive");
    const tab = page.getByTestId("mode-receive");
    await expect(tab.getByTestId("request-card")).toBeVisible({ timeout: WALLET_TIMEOUT_MS });
    await tab.getByTestId("request-asset").click();
    await page.getByTestId("swap-token-list").getByRole("button", { name: /^cWBTC/ }).click();
    await tab.getByTestId("request-amount").fill(REQUEST.cwbtc);
    await expect(tab.getByTestId("request-conversion")).toHaveText(REQUEST.conversion, { timeout: STEP_TIMEOUT_MS });
    await expectNoSeriousAxe(page);
    await expectNoHorizontalOverflow(page);
  });
});
