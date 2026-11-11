import { test as base, expect, type FrameLocator, type Locator, type Page } from "@playwright/test";
import { apiError } from "./fakes/hub";
import { expectNoHorizontalOverflow, expectNoSeriousAxe } from "./page-checks";
import {
  confirmNodeChannels,
  createRunningNode,
  CWBTC_SCRIPT,
  FakeCkbRpc,
  HUB_FIBER_NODE,
  hubChannel,
  installFakeNode,
  nodeCalls,
  nodeIdentity,
  setNodeOptions,
  units,
} from "./support/fiber-node";
import { browserHasDip, createWalletNode, DIP_PROBE_TIMEOUT_MS, openPage, openWallet, WALLET_TIMEOUT_MS } from "./support/fiber-wallet";
import { isolate, LiveHub } from "./support/live-hub";
import { STEP_TIMEOUT_MS } from "./support/swap-card";

/*
 * "Channel with the hub" as one card (docs/fiber-wallet-popup.md, "Channel with the hub: one card"), the same on the node
 * page (/app/fiber, panel 03) and in the popup's Channels: a row per asset the hub funds, from its GET /v1/fiber/node
 * alone (CKB, RUSD and cWBTC here, as the hub serves cWBTC once its FIBER_ASSETS lists it), ticked and opened in one
 * press. The run asks the hub for one channel after another, the node accepts the CKB one itself (accept_channel) and
 * fnn's whitelist takes the token ones (support/live-hub.ts `openUdtChannels`), and a failed row does not stop the next.
 * Nothing reaches a real network.
 */

const TEST_TIMEOUT_MS = 150_000;
/** The node page reads its channels every 5 s. */
const NODE_STATUS_TIMEOUT_MS = 15_000;
const PHONE = { width: 390, height: 844 };
/** The popover's room for the node (its size less the title bar). */
const WALLET_FRAME_PX = { width: 380, height: 550 };
const hexQ = (n: bigint) => `0x${n.toString(16)}`;

const test = base.extend<{ hub: LiveHub; dip: boolean }>({
  hub: async ({ context }, use) => {
    await isolate(context);
    const hub = new LiveHub().serveCwbtc();
    await hub.install(context);
    await use(hub);
  },
  /** The browser isolates the popover's iframe with Document-Isolation-Policy (real Chrome); else the node's window. */
  dip: [
    async ({ browser, baseURL }, use) => {
      await use(await browserHasDip(browser, baseURL!));
    },
    { timeout: DIP_PROBE_TIMEOUT_MS },
  ],
});

type Scope = Page | FrameLocator;
const card = (scope: Scope) => scope.getByTestId("fiber-node-hub-request");
const row = (c: Locator, asset: string) => c.getByTestId(`fiber-node-hub-row-${asset}`);
const box = (c: Locator, symbol: string) => c.getByRole("checkbox", { name: symbol, exact: true });
const openButton = (c: Locator) => c.getByTestId("fiber-node-hub-open");

/** The CKB testnet RPC with the node holding `ckb` on chain (registered after isolate's, so it answers first). */
async function nodeHolds(context: Parameters<FakeCkbRpc["install"]>[0], ckb: number) {
  const rpc = new FakeCkbRpc();
  rpc.balance = units(ckb);
  await rpc.install(context);
  return rpc;
}

/* ---------------------------------------------------------------------------------------- the node page */

test.describe("channel with the hub: one card, several channels in one press", () => {
  test("ticks CKB, RUSD and cWBTC and opens them in one press: three requests in order, accept_channel for CKB only, every row then Open", async ({
    page,
    hub,
    context,
  }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    hub.openUdtChannels = true;
    // 1,200 CKB put in plus the fee margin, and 181 CKB for each token channel: exactly what the node holds.
    await nodeHolds(context, 1_563);
    await installFakeNode(context, { acceptedState: "ChannelReady" });
    await page.goto("/app/fiber");
    await createRunningNode(page);
    const c = card(page);

    // A row per asset the hub funds, CKB first, then the hub's order; the app names none of them.
    const rows = c.locator("[data-testid^=fiber-node-hub-row-]");
    await expect(rows).toHaveCount(3);
    expect(await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")))).toEqual([
      "fiber-node-hub-row-CKB",
      "fiber-node-hub-row-RUSD",
      "fiber-node-hub-row-CWBTC",
    ]);
    for (const asset of ["CKB", "RUSD", "CWBTC"]) {
      await expect(row(c, asset)).toHaveAttribute("data-status", "available");
      await expect(row(c, asset)).toContainText("Not open");
    }
    await expect(c.getByTestId("fiber-node-hub-line-CKB")).toHaveText("Hub funds 1,000 CKB");
    await expect(c.getByTestId("fiber-node-hub-line-RUSD")).toHaveText("Hub funds 20 RUSD · needs 181 CKB reserve");
    await expect(c.getByTestId("fiber-node-hub-line-CWBTC")).toHaveText("Hub funds 10 cWBTC · needs 181 CKB reserve");
    await expect(c.getByLabel("Your node puts in")).toHaveValue("1200");
    await expect(c).not.toContainText("Hold at least");

    // Nothing ticked: the one button waits and says why.
    const open = openButton(c);
    await expect(open).toHaveText("Open a channel");
    await expect(open).toBeDisabled();
    await expect(open).toHaveAttribute("title", "Tick at least one token first.");
    await expect(c.getByTestId("fiber-node-hub-total")).toHaveCount(0);

    for (const symbol of ["CKB", "RUSD", "cWBTC"]) await box(c, symbol).check();
    await expect(open).toHaveText("Open 3 channels");
    await expect(c.getByTestId("fiber-node-hub-total")).toHaveText("Needs 1,563 CKB on chain · you have 1,563 CKB");
    await expect(c.getByTestId("fiber-node-hub-short")).toHaveCount(0);
    await expect(open).toBeEnabled();
    await open.click();

    await expect(c.getByTestId("fiber-node-hub-summary")).toHaveText("3 channels asked for. Each reads Ready after a few confirmations.", {
      timeout: STEP_TIMEOUT_MS * 3,
    });
    // One request per asset, in the rows' order; only the node's public id goes out.
    const { nodeId } = await nodeIdentity(page);
    expect(hub.fiberChannelBodies).toEqual([
      { nodeId, asset: "CKB" },
      { nodeId, asset: "RUSD" },
      { nodeId, asset: "CWBTC" },
    ]);
    // The node accepted the CKB channel itself (one "not found" first), with the 1,200 CKB typed; the token channels
    // were taken by fnn's whitelist with no accept_channel.
    const accepts = await nodeCalls(page, "accept_channel");
    expect(accepts).toHaveLength(2);
    expect(new Set(accepts.map((a) => a?.temporary_channel_id)).size).toBe(1);
    expect(accepts.every((a) => a?.funding_amount === hexQ(units(1_200)))).toBe(true);
    expect(hub.udtOpens.map((o) => o.outcome)).toEqual(["accepted", "accepted"]);

    // Each row reads Open once the node lists its channel, with what it moves now, and cannot be ticked again.
    for (const asset of ["CKB", "RUSD", "CWBTC"]) await expect(row(c, asset)).toHaveAttribute("data-status", "open", { timeout: NODE_STATUS_TIMEOUT_MS });
    await expect(c.getByTestId("fiber-node-hub-line-CKB")).toHaveText("You can send 1,200 CKB · receive 0 CKB");
    await expect(c.getByTestId("fiber-node-hub-line-RUSD")).toHaveText("You can send 0 RUSD · receive 20 RUSD");
    await expect(box(c, "RUSD")).toBeDisabled();
    await expect(box(c, "RUSD")).toHaveAttribute("title", "Your node already has a RUSD channel with the hub.");
    await expect(c.getByTestId("fiber-node-contribution")).toHaveCount(0);
    // History: the three channels asked for.
    await expect(page.getByTestId("history-entry").filter({ hasText: "channel with the CKBolt hub" })).toHaveCount(3, { timeout: NODE_STATUS_TIMEOUT_MS });
  });

  test("a row that fails does not stop the others: the hub's 409 for RUSD, then the node refusing the CKB channel", async ({ page, hub, context }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    hub.openUdtChannels = true;
    await nodeHolds(context, 1_400);
    await installFakeNode(context);
    await page.goto("/app/fiber");
    await createRunningNode(page);
    const c = card(page);
    const summary = c.getByTestId("fiber-node-hub-summary");

    const conflict = "Your node already has a RUSD channel from the hub, open or opening.";
    hub.fiberAnswers.set("RUSD", { status: 409, body: apiError("conflict", conflict) });
    await box(c, "RUSD").check();
    await box(c, "cWBTC").check();
    await expect(c.getByTestId("fiber-node-hub-total")).toHaveText("Needs 362 CKB on chain · you have 1,400 CKB");
    await openButton(c).click();
    await expect(summary).toHaveText("1 of 2 channels asked for. See the failed row.", { timeout: STEP_TIMEOUT_MS * 2 });
    await expect(row(c, "RUSD")).toHaveAttribute("data-status", "failed");
    await expect(row(c, "RUSD")).toContainText("Failed");
    await expect(c.getByTestId("fiber-node-hub-reason-RUSD")).toHaveText(conflict);
    await expect(row(c, "CWBTC")).toHaveAttribute("data-status", "open", { timeout: NODE_STATUS_TIMEOUT_MS });
    expect(hub.fiberChannelBodies.map((b) => b.asset)).toEqual(["RUSD", "CWBTC"]);
    // A failed row may be ticked again; ticking it puts it back to rest.
    await expect(box(c, "RUSD")).toBeEnabled();

    // fnn refuses the CKB channel: one line on its row, and RUSD, next, still goes.
    await setNodeOptions(page, { failAccept: "Failed to build funding transaction: insufficient capacity" });
    await box(c, "CKB").check();
    await box(c, "RUSD").check();
    await expect(row(c, "RUSD")).toHaveAttribute("data-status", "available");
    await expect(openButton(c)).toHaveText("Open 2 channels");
    await expect(c.getByTestId("fiber-node-hub-total")).toHaveText("Needs 1,382 CKB on chain · you have 1,400 CKB");
    await openButton(c).click();
    await expect(summary).toHaveText("1 of 2 channels asked for. See the failed row.", { timeout: STEP_TIMEOUT_MS * 2 });
    await expect(row(c, "CKB")).toHaveAttribute("data-status", "failed");
    await expect(c.getByTestId("fiber-node-hub-reason-CKB")).toHaveText(
      "Your node could not accept the hub's channel: Failed to build funding transaction: insufficient capacity",
    );
    await expect(row(c, "RUSD")).toHaveAttribute("data-status", "open", { timeout: NODE_STATUS_TIMEOUT_MS });
    expect(await nodeCalls(page, "accept_channel")).toHaveLength(1);
    expect(hub.fiberChannelBodies.map((b) => b.asset)).toEqual(["RUSD", "CWBTC", "CKB", "RUSD"]);
  });

  test("not enough CKB on chain: the total says what it needs, the button waits; Max leaves room for the ticked tokens", async ({ page, hub, context }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    const rpc = await nodeHolds(context, 600);
    await installFakeNode(context);
    await page.goto("/app/fiber");
    await createRunningNode(page);
    const c = card(page);
    const open = openButton(c);
    const total = c.getByTestId("fiber-node-hub-total");
    const short = c.getByTestId("fiber-node-hub-short");

    await box(c, "CKB").check();
    await expect(total).toHaveText("Needs 1,201 CKB on chain · you have 600 CKB");
    await expect(short).toHaveText("Not enough CKB on chain. Add 601 CKB first.");
    await expect(open).toBeDisabled();
    await expect(open).toHaveAttribute("title", "Not enough CKB on chain. Add 601 CKB first.");
    // A wrong amount in the CKB field: the button says that first.
    await c.getByLabel("Your node puts in").fill("150");
    await expect(c.getByTestId("fiber-node-contribution")).toContainText("Whole CKB, at least 200.");
    await expect(open).toHaveAttribute("title", "Whole CKB, at least 200.");

    // Max: all the node holds but the fee margin, less the RUSD reserve ticked too.
    await box(c, "RUSD").check();
    await c.getByRole("button", { name: "Max" }).click();
    await expect(c.getByLabel("Your node puts in")).toHaveValue("418");
    await expect(total).toHaveText("Needs 600 CKB on chain · you have 600 CKB");
    await expect(short).toHaveCount(0);
    await expect(open).toHaveText("Open 2 channels");
    await expect(open).toBeEnabled();

    // More CKB than the node holds: the line says how much to add.
    await c.getByLabel("Your node puts in").fill("20,000");
    await expect(total).toHaveText("Needs 20,182 CKB on chain · you have 600 CKB");
    await expect(short).toHaveText("Not enough CKB on chain. Add 19,582 CKB first.");
    await expect(open).toBeDisabled();
    rpc.balance = units(20_182);
    await page.getByRole("button", { name: "Refresh balance" }).click();
    await expect(total).toHaveText("Needs 20,182 CKB on chain · you have 20,182 CKB");
    await expect(open).toBeEnabled();
    expect(hub.fiberChannelBodies).toEqual([]);
  });

  test("a token with a channel is Open, never 'cannot fund'; one the hub cannot fund says so; axe and a 390 px screen", async ({ page, hub, context }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    await page.setViewportSize(PHONE);
    hub.fiberNode.inbound.fundable = { CKB: true, RUSD: false, CWBTC: false };
    await installFakeNode(context, { channels: [hubChannel({ local: units(0), remote: BigInt(10_000_000), udt: CWBTC_SCRIPT })] });
    await page.goto("/app/fiber");
    await createRunningNode(page);
    const c = card(page);

    await expect(row(c, "CWBTC")).toHaveAttribute("data-status", "open", { timeout: NODE_STATUS_TIMEOUT_MS });
    await expect(row(c, "CWBTC")).toContainText("Open");
    await expect(row(c, "CWBTC")).not.toContainText("can't fund");
    await expect(c.getByTestId("fiber-node-hub-line-CWBTC")).toHaveText("You can send 0 cWBTC · receive 0.1 cWBTC");
    await expect(box(c, "cWBTC")).toBeDisabled();
    await expect(box(c, "cWBTC")).toHaveAttribute("title", "Your node already has a cWBTC channel with the hub.");
    await expect(row(c, "RUSD")).toHaveAttribute("data-status", "unfundable");
    await expect(row(c, "RUSD")).toContainText("Hub can't fund now");
    await expect(box(c, "RUSD")).toBeDisabled();
    await expect(box(c, "RUSD")).toHaveAttribute("title", "The hub cannot fund a new RUSD channel right now. Try again later.");
    await expect(box(c, "CKB")).toBeEnabled();

    // The "?" says once why each token is its own channel, who funds it, and how to put in more CKB.
    await c.getByRole("button", { name: "About the channel with the hub" }).click();
    const tip = page.getByRole("dialog", { name: "About the channel with the hub" });
    await expect(tip).toContainText("Each token is its own channel and its own transaction on chain");
    await expect(tip).toContainText("The hub funds token channels alone");
    await expect(tip).toContainText("Fiber cannot add funds to an open channel yet: to put in more CKB, close the CKB channel, then open a new one.");
    await page.keyboard.press("Escape");

    await box(c, "CKB").check();
    await expectNoSeriousAxe(page);
    await expectNoHorizontalOverflow(page);
  });
});

/* ------------------------------------------------------------------------------------- your own tokens */

/** cWBTC's type script as fnn's RPC takes it (snake case). */
const RPC_CWBTC = { code_hash: CWBTC_SCRIPT.codeHash, hash_type: CWBTC_SCRIPT.hashType, args: CWBTC_SCRIPT.args };
/** The node's cWBTC on chain, in base units (8 decimals): 0.05 cWBTC in two cells, as two faucet claims and change. */
const NODE_CWBTC_CELLS = [BigInt(3_000_000), BigInt(2_000_000)];

test.describe("channel with the hub: a token the node funds with its own tokens (the hub's peerChannels)", () => {
  test("puts in its own cWBTC: the node opens that channel itself (private, the token's script, no delay of its own); the hub is asked for CKB only", async ({
    page,
    hub,
    context,
  }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    hub.allowOwnChannels("CWBTC");
    const rpc = await nodeHolds(context, 1_400);
    rpc.tokenCells[CWBTC_SCRIPT.args.toLowerCase()] = NODE_CWBTC_CELLS;
    await installFakeNode(context, { acceptedState: "ChannelReady" });
    await page.goto("/app/fiber");
    await createRunningNode(page);
    const c = card(page);

    // The cWBTC row offers who funds it, the hub by default; RUSD, without peerChannels, offers nothing new.
    const fund = c.getByTestId("fiber-node-hub-fund-CWBTC");
    await expect(fund.getByRole("radio", { name: "Hub funds it" })).toHaveAttribute("aria-checked", "true");
    await expect(c.getByTestId("fiber-node-hub-line-CWBTC")).toHaveText("Hub funds 10 cWBTC · needs 181 CKB reserve");
    await expect(c.getByTestId("fiber-node-hub-own-CWBTC")).toHaveCount(0);
    await expect(c.getByTestId("fiber-node-hub-fund-RUSD")).toHaveCount(0);
    await expect(c.getByTestId("fiber-node-hub-fund-CKB")).toHaveCount(0);

    // The trade-off, behind the row's "?".
    await fund.getByRole("button", { name: "About putting in your own cWBTC" }).click();
    const tip = page.getByRole("dialog", { name: "About putting in your own cWBTC" });
    await expect(tip).toContainText("It can then pay the hub up to what it put in");
    await expect(tip).toContainText("The hub adds no cWBTC, so your node receives over it only what it has paid.");
    // The longer hold is the token's, not only this channel's: whichever channel pays a swap from cWBTC to BTC.
    await expect(tip).toContainText("the hub plans every swap from cWBTC to BTC for the longest safety delay, over the hub's channel or yours.");
    await expect(tip).toContainText("your payment could stay locked up to about 10 days before it comes back.");
    await page.keyboard.press("Escape");
    // The card's own "?" says which tokens a node may fund itself.
    await c.getByRole("button", { name: "About the channel with the hub" }).click();
    await expect(page.getByRole("dialog", { name: "About the channel with the hub" })).toContainText(
      "For cWBTC, your node may instead open the channel with its own tokens, and the hub adds none",
    );
    await page.keyboard.press("Escape");

    // Choosing its own cWBTC ticks the row; the field starts at the hub's minimum, under it what the node holds.
    await fund.getByRole("radio", { name: "Your own cWBTC" }).click();
    await expect(box(c, "cWBTC")).toBeChecked();
    await expect(c.getByTestId("fiber-node-hub-line-CWBTC")).toHaveText("Your node funds it · needs 181 CKB reserve");
    const own = c.getByTestId("fiber-node-hub-own-CWBTC");
    const amount = own.getByRole("textbox", { name: "Your node puts in cWBTC" });
    await expect(amount).toHaveValue("0.01");
    await expect(c.getByTestId("fiber-node-hub-own-held-CWBTC")).toHaveText("You hold 0.05 cWBTC on chain · at least 0.01 cWBTC", {
      timeout: NODE_STATUS_TIMEOUT_MS,
    });
    // The reserve is a token channel's, in the total as before.
    await expect(c.getByTestId("fiber-node-hub-total")).toHaveText("Needs 181 CKB on chain · you have 1,400 CKB");
    const open = openButton(c);
    await expect(open).toHaveText("Open a channel");
    await expect(open).toBeEnabled();

    // Below the hub's minimum, or more than the node holds: the field and the button say so.
    await amount.fill("0.005");
    await expect(c.getByTestId("fiber-node-hub-own-error-CWBTC")).toHaveText("Put in at least 0.01 cWBTC.");
    await expect(amount).toHaveAttribute("aria-invalid", "true");
    await expect(open).toBeDisabled();
    await expect(open).toHaveAttribute("title", "Put in at least 0.01 cWBTC.");
    await amount.fill("0.06");
    await expect(c.getByTestId("fiber-node-hub-own-error-CWBTC")).toHaveText("Your node holds only 0.05 cWBTC on chain.");
    await expect(open).toBeDisabled();
    // Max: everything it holds.
    await own.getByRole("button", { name: "Max" }).click();
    await expect(amount).toHaveValue("0.05");
    await expect(c.getByTestId("fiber-node-hub-own-error-CWBTC")).toHaveCount(0);

    // With a CKB channel from the hub in the same press: one after the other, CKB first.
    await box(c, "CKB").check();
    await expect(c.getByTestId("fiber-node-hub-total")).toHaveText("Needs 1,382 CKB on chain · you have 1,400 CKB");
    await expect(open).toHaveText("Open 2 channels");
    await open.click();
    await expect(c.getByTestId("fiber-node-hub-summary")).toHaveText("2 channels asked for. Each reads Ready after a few confirmations.", {
      timeout: STEP_TIMEOUT_MS * 2,
    });

    // The hub was asked for the CKB channel only; the node opened the cWBTC one itself, as the hub's contract says:
    // its node id, the token's script, the amount in hex, private, and no commitment_delay_epoch or tlc_expiry_delta.
    const { nodeId } = await nodeIdentity(page);
    expect(hub.fiberChannelBodies).toEqual([{ nodeId, asset: "CKB" }]);
    expect(await nodeCalls(page, "open_channel")).toEqual([
      { pubkey: HUB_FIBER_NODE.nodeId, funding_amount: hexQ(BigInt(5_000_000)), public: false, funding_udt_type_script: RPC_CWBTC },
    ]);
    // Only the hub was ever dialled (the open itself dials only a hub that is no longer a peer: tests/unit/hub-channel-rows.spec.ts).
    expect((await nodeCalls(page, "connect_peer")).every((c) => String(c?.address).includes("hub.example.test") || String(c?.address).includes("127.0.0.1"))).toBe(true);

    // Its channel shows as Opening, then Open with what it can pay: all it put in, nothing to receive yet.
    await expect(row(c, "CWBTC")).toHaveAttribute("data-status", "opening", { timeout: NODE_STATUS_TIMEOUT_MS });
    await confirmNodeChannels(page);
    await expect(row(c, "CWBTC")).toHaveAttribute("data-status", "open", { timeout: NODE_STATUS_TIMEOUT_MS });
    await expect(c.getByTestId("fiber-node-hub-line-CWBTC")).toHaveText("You can send 0.05 cWBTC · receive 0 cWBTC");
    await expect(c.getByTestId("fiber-node-hub-fund-CWBTC")).toHaveCount(0);
    // The paying note's "?" says a cWBTC channel of the node's own is taken.
    await page.getByRole("button", { name: "About paying from your node" }).click();
    await expect(page.getByRole("dialog", { name: "About paying from your node" })).toContainText(
      "except in cWBTC: there your node may open its own channel to the hub",
    );
    await page.keyboard.press("Escape");
    // History: the channel the node opened to the hub, in cWBTC.
    await expect(page.getByTestId("history-entry").filter({ hasText: "channel with the CKBolt hub · 0.05 cWBTC" })).toHaveCount(1, {
      timeout: NODE_STATUS_TIMEOUT_MS,
    });
  });

  test("without peerChannels, as on production today, nothing new shows: no choice, no field, the old notes", async ({ page, hub, context }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    expect(hub.fiberNode.assets.map((a) => a.peerChannels)).toEqual([null, null, null]);
    const rpc = await nodeHolds(context, 1_400);
    rpc.tokenCells[CWBTC_SCRIPT.args.toLowerCase()] = NODE_CWBTC_CELLS;
    await installFakeNode(context);
    await page.goto("/app/fiber");
    await createRunningNode(page);
    const c = card(page);
    await expect(row(c, "CWBTC")).toHaveAttribute("data-status", "available");
    await box(c, "cWBTC").check();
    await expect(c.getByTestId("fiber-node-hub-line-CWBTC")).toHaveText("Hub funds 10 cWBTC · needs 181 CKB reserve");
    await expect(c.locator("[data-testid^=fiber-node-hub-fund-]")).toHaveCount(0);
    await expect(c.locator("[data-testid^=fiber-node-hub-own-]")).toHaveCount(0);
    await expect(c.getByRole("radio", { name: "Your own cWBTC" })).toHaveCount(0);
    await expect(c.getByRole("button", { name: "About putting in your own cWBTC" })).toHaveCount(0);
    await c.getByRole("button", { name: "About the channel with the hub" }).click();
    await expect(page.getByRole("dialog", { name: "About the channel with the hub" })).not.toContainText("its own tokens");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "About paying from your node" }).click();
    await expect(page.getByRole("dialog", { name: "About paying from your node" })).toContainText("so swaps never use a channel your node opened");
    await page.keyboard.press("Escape");
    // The node's cWBTC on chain is never read: no row needs it.
    expect(rpc.methods).toContain("get_cells_capacity");
    expect(rpc.methods).not.toContain("get_cells");
  });

  test("the hub cannot fund cWBTC now: its own tokens with no choice; a failed read is read again; axe and a 390 px screen", async ({
    page,
    hub,
    context,
  }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    await page.setViewportSize(PHONE);
    hub.allowOwnChannels("CWBTC");
    hub.fiberNode.inbound.fundable = { CKB: true, RUSD: true, CWBTC: false };
    const rpc = await nodeHolds(context, 600);
    rpc.failTokenReads = true;
    await installFakeNode(context);
    await page.goto("/app/fiber");
    await createRunningNode(page);
    const c = card(page);

    // Not "cannot fund": the node may still open its own; the line says who funds it, its "?" after the line.
    await expect(row(c, "CWBTC")).toHaveAttribute("data-status", "available");
    await expect(c.getByTestId("fiber-node-hub-line-CWBTC")).toHaveText("Your node funds it · needs 181 CKB reserve");
    await expect(c.getByTestId("fiber-node-hub-fund-CWBTC")).toHaveCount(0);
    await expect(row(c, "CWBTC").getByRole("button", { name: "About putting in your own cWBTC" })).toBeVisible();
    const held = c.getByTestId("fiber-node-hub-own-held-CWBTC");
    await expect(held).toContainText("Could not read your cWBTC on chain.", { timeout: NODE_STATUS_TIMEOUT_MS });
    await box(c, "cWBTC").check();
    await expect(openButton(c)).toBeDisabled();
    await expect(openButton(c)).toHaveAttribute("title", "Wait until the node has read its cWBTC.");

    // Read again once the RPC answers: 0.02 cWBTC.
    rpc.failTokenReads = false;
    rpc.tokenCells[CWBTC_SCRIPT.args.toLowerCase()] = [BigInt(2_000_000)];
    await held.getByRole("button", { name: "Read again" }).click();
    await expect(held).toHaveText("You hold 0.02 cWBTC on chain · at least 0.01 cWBTC");
    await expect(openButton(c)).toBeEnabled();
    await expectNoSeriousAxe(page);
    await expectNoHorizontalOverflow(page);
  });

  test("the hub reached its cap since the page read it: the row says so and the node opens nothing; the hub is read again", async ({
    page,
    hub,
    context,
  }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    hub.allowOwnChannels("CWBTC");
    const rpc = await nodeHolds(context, 1_400);
    rpc.tokenCells[CWBTC_SCRIPT.args.toLowerCase()] = NODE_CWBTC_CELLS;
    await installFakeNode(context);
    await page.goto("/app/fiber");
    await createRunningNode(page);
    const c = card(page);
    await c.getByTestId("fiber-node-hub-fund-CWBTC").getByRole("radio", { name: "Your own cWBTC" }).click();
    await expect(c.getByTestId("fiber-node-hub-own-held-CWBTC")).toHaveText("You hold 0.05 cWBTC on chain · at least 0.01 cWBTC", {
      timeout: NODE_STATUS_TIMEOUT_MS,
    });
    await expect(openButton(c)).toBeEnabled();

    // Meanwhile nodes opened as many such channels as the hub allows: GET /v1/fiber/node offers none any more. fnn-hub
    // would still accept one, so the page reads the offer again before it opens anything.
    for (const asset of hub.fiberNode.assets) asset.peerChannels = null;
    await openButton(c).click();
    await expect(c.getByTestId("fiber-node-hub-summary")).toHaveText("No channel opened. Its row says why.", { timeout: STEP_TIMEOUT_MS * 2 });
    await expect(row(c, "CWBTC")).toHaveAttribute("data-status", "failed");
    await expect(c.getByTestId("fiber-node-hub-reason-CWBTC")).toHaveText("The hub no longer takes a channel of your own tokens. Try again later.");
    expect(await nodeCalls(page, "open_channel")).toEqual([]);
    expect(hub.fiberChannelBodies).toEqual([]);
    // Read again after the run: the row offers the hub's channel only, with no choice.
    await expect(c.getByTestId("fiber-node-hub-fund-CWBTC")).toHaveCount(0);
    await expect(c.getByTestId("fiber-node-hub-line-CWBTC")).toHaveText("Hub funds 10 cWBTC · needs 181 CKB reserve");
  });

  test.describe("in a locale whose decimal mark is a comma", () => {
    test.use({ locale: "de-DE" });

    test("the field's minimum and Max read back as written: 1,125 cWBTC is 1.125, not 1,125", async ({ page, hub, context }) => {
      test.setTimeout(TEST_TIMEOUT_MS);
      // At least 1.125 cWBTC: "1.125" is the shape a comma locale reads as thousands.
      hub.allowOwnChannels("CWBTC", { minAmount: "112500000", assumedCommitmentDelayEpochs: 84 });
      hub.fiberNode.inbound.fundable = { CKB: true, RUSD: true, CWBTC: false };
      const rpc = await nodeHolds(context, 600);
      rpc.tokenCells[CWBTC_SCRIPT.args.toLowerCase()] = [BigInt(512_500_000)];
      await installFakeNode(context, { acceptedState: "ChannelReady" });
      await page.goto("/app/fiber");
      await createRunningNode(page);
      const c = card(page);
      const own = c.getByTestId("fiber-node-hub-own-CWBTC");
      const amount = own.getByRole("textbox", { name: "Your node puts in cWBTC" });

      // The minimum, written with the locale's mark, is the minimum: no error, the button goes.
      await expect(amount).toHaveValue("1,125");
      await expect(c.getByTestId("fiber-node-hub-own-held-CWBTC")).toHaveText("You hold 5.125 cWBTC on chain · at least 1.125 cWBTC", {
        timeout: NODE_STATUS_TIMEOUT_MS,
      });
      await box(c, "cWBTC").check();
      await expect(c.getByTestId("fiber-node-hub-own-error-CWBTC")).toHaveCount(0);
      await expect(openButton(c)).toBeEnabled();
      // Max: all it holds, 5.125 cWBTC, read back as such (not 5,125 cWBTC, more than it holds).
      await own.getByRole("button", { name: "Max" }).click();
      await expect(amount).toHaveValue("5,125");
      await expect(c.getByTestId("fiber-node-hub-own-error-CWBTC")).toHaveCount(0);
      await openButton(c).click();
      await expect(c.getByTestId("fiber-node-hub-summary")).toHaveText("Channel asked for. It reads Ready after a few confirmations.", {
        timeout: STEP_TIMEOUT_MS * 2,
      });
      expect(await nodeCalls(page, "open_channel")).toEqual([
        { pubkey: HUB_FIBER_NODE.nodeId, funding_amount: hexQ(BigInt(512_500_000)), public: false, funding_udt_type_script: RPC_CWBTC },
      ]);
      expect(hub.fiberChannelBodies).toEqual([]);
    });
  });
});

/* ------------------------------------------------------------------------------------------- the popup */

test.describe("channel with the hub in the popup's Channels", () => {
  test("the same card: two rows in one press; Stop while it waits for the CKB funding asks for nothing more; axe at the popover's size", async ({
    page,
    hub,
    context,
    dip,
    isMobile,
  }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    hub.openUdtChannels = true;
    await nodeHolds(context, 1_600);
    await installFakeNode(context);
    if (!isMobile) await page.setViewportSize(WALLET_FRAME_PX);
    const wallet = await openWallet(page, dip);
    await createWalletNode(wallet.ui);
    await openPage(wallet.ui, "channels");
    const c = card(wallet.ui);
    await expect(row(c, "CKB")).toHaveAttribute("data-status", "available");

    await box(c, "CKB").check();
    await box(c, "cWBTC").check();
    await expect(c.getByTestId("fiber-node-hub-total")).toHaveText("Needs 1,382 CKB on chain · you have 1,600 CKB");
    await openButton(c).click();
    // The CKB channel was asked for and accepted; its funding is not confirmed, so the run waits before cWBTC.
    await expect(c.getByTestId("fiber-node-hub-progress")).toHaveText("Waiting until the CKB channel is funded…", { timeout: WALLET_TIMEOUT_MS });
    await expect(row(c, "CWBTC")).toHaveAttribute("data-status", "queued");
    await expect(openButton(c)).toHaveText("Opening…");
    await expect(openButton(c)).toBeDisabled();
    await c.getByTestId("fiber-node-hub-stop").click();
    await expect(c.getByTestId("fiber-node-hub-summary")).toHaveText("Stopped. 1 of 2 channels asked for.", { timeout: STEP_TIMEOUT_MS });
    expect(hub.fiberChannelBodies.map((b) => b.asset)).toEqual(["CKB"]);
    await expect(row(c, "CWBTC")).toHaveAttribute("data-status", "available");
    await expect(row(c, "CKB")).toHaveAttribute("data-status", "opening", { timeout: STEP_TIMEOUT_MS });
    await expect(c.getByTestId("fiber-node-hub-line-CKB")).toHaveText("Ready after a few confirmations.");
    await expectNoSeriousAxe(page, dip ? "[data-testid=fiber-wallet-popover]" : undefined);
    await expectNoHorizontalOverflow(page);

    // The CKB channel's funding confirms; cWBTC alone now, in one press.
    await confirmNodeChannels(wallet.scope);
    await expect(row(c, "CKB")).toHaveAttribute("data-status", "open", { timeout: STEP_TIMEOUT_MS });
    await box(c, "cWBTC").check();
    await expect(openButton(c)).toHaveText("Open a channel");
    await openButton(c).click();
    await expect(c.getByTestId("fiber-node-hub-summary")).toHaveText("Channel asked for. It reads Ready after a few confirmations.", { timeout: STEP_TIMEOUT_MS });
    expect(hub.fiberChannelBodies.map((b) => b.asset)).toEqual(["CKB", "CWBTC"]);
    await expect(row(c, "CWBTC")).toHaveAttribute("data-status", "open", { timeout: STEP_TIMEOUT_MS });
    expect(await nodeCalls(wallet.scope, "accept_channel")).toEqual(Array(2).fill(expect.objectContaining({ funding_amount: hexQ(units(1_200)) })));
  });

  test("the node's own cWBTC from the popup's Channels: the choice and the field fit 380 px; the node opens it, the hub is not asked", async ({
    page,
    hub,
    context,
    dip,
    isMobile,
  }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    hub.allowOwnChannels("CWBTC");
    const rpc = await nodeHolds(context, 600);
    rpc.tokenCells[CWBTC_SCRIPT.args.toLowerCase()] = NODE_CWBTC_CELLS;
    await installFakeNode(context);
    if (!isMobile) await page.setViewportSize(WALLET_FRAME_PX);
    const wallet = await openWallet(page, dip);
    await createWalletNode(wallet.ui);
    await openPage(wallet.ui, "channels");
    const c = card(wallet.ui);
    await c.getByTestId("fiber-node-hub-fund-CWBTC").getByRole("radio", { name: "Your own cWBTC" }).click();
    await expect(c.getByTestId("fiber-node-hub-own-held-CWBTC")).toHaveText("You hold 0.05 cWBTC on chain · at least 0.01 cWBTC", {
      timeout: WALLET_TIMEOUT_MS,
    });
    await expect(openButton(c)).toHaveText("Open a channel");
    await expectNoSeriousAxe(page, dip ? "[data-testid=fiber-wallet-popover]" : undefined);
    await expectNoHorizontalOverflow(page);
    await openButton(c).click();
    await expect(c.getByTestId("fiber-node-hub-summary")).toHaveText("Channel asked for. It reads Ready after a few confirmations.", { timeout: STEP_TIMEOUT_MS });
    expect(hub.fiberChannelBodies).toEqual([]);
    expect(await nodeCalls(wallet.scope, "open_channel")).toEqual([
      { pubkey: HUB_FIBER_NODE.nodeId, funding_amount: hexQ(BigInt(1_000_000)), public: false, funding_udt_type_script: RPC_CWBTC },
    ]);
    await expect(row(c, "CWBTC")).toHaveAttribute("data-status", "opening", { timeout: STEP_TIMEOUT_MS });
  });
});
