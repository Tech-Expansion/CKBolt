import { expect, test, type Locator, type Page } from "@playwright/test";
import { installNoHub } from "./fakes/hub";
import { expectNoHorizontalOverflow, expectNoSeriousAxe } from "./page-checks";
import { HUB_FIBER_NODE, RUSD_WHITELIST } from "./support/fiber-node";
import { apiError } from "./fakes/hub";
import { HUB_LIGHTNING_NODE, isolate, LiveHub } from "./support/live-hub";
import { CARD_TIMEOUT_MS } from "./support/swap-card";

/*
 * The testnet guide (/app/guide, phase-3c plan F1.1 and F10.1): what a tester needs and every step to a swap both
 * ways, scannable, with the links it promises, and reachable from the live card's How it works and the site's footer;
 * and its CKBolt hub card, where a Lightning wallet's node id gets a channel from the hub (F3.1).
 */

const PHONE = { width: 390, height: 844 };
/** The steps, in order (components/app/guide/copy.ts). */
const STEP_TITLES = [
  "Run a Lightning wallet on Mutinynet",
  "Get test sats",
  "Get a Lightning channel from the hub",
  "Create your browser Fiber node",
  "Fund it with testnet CKB",
  "Open a channel with the hub",
  "Swap both ways",
  "Take your CKB back",
];
/** Short lines: one action each (docs/live-swap-ui.md keeps sentences short; the guide follows it loosely). */
const MAX_LINE_WORDS = 20;

test.describe("the testnet guide", () => {
  test.beforeEach(async ({ context }) => {
    await isolate(context);
  });

  test("lists what to prepare, the limits, and every step in order, one action per short line", async ({ page }) => {
    await page.goto("/app/guide");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Try a live swap.");
    const needs = page.getByTestId("testnet-guide-needs");
    await expect(needs).toContainText("Desktop Chrome or Edge");
    await expect(needs).toContainText("JoyID on CKB testnet");
    await expect(needs).toContainText("A Lightning wallet on Mutinynet");
    const limits = page.getByTestId("testnet-guide-limits");
    await expect(limits).toContainText("1,000 to 20,000 sats per swap.");
    await expect(limits).toContainText("Test networks only");
    await expect(limits).toContainText("Mainnet invoices are refused.");
    // No wallet connection to set up: the Lightning side is a QR code or a pasted invoice.
    await expect(page.getByTestId("testnet-guide")).not.toContainText(/Nostr Wallet Connect|NWC|budget/);

    const steps = page.getByTestId("testnet-guide-steps").locator(":scope > li");
    await expect(steps).toHaveCount(STEP_TITLES.length);
    for (const [i, title] of STEP_TITLES.entries()) await expect(steps.nth(i).getByRole("heading", { level: 3 })).toHaveText(title);

    // F10.1: close the channel before clearing browser data; the CKB goes to the visitor's wallet on close, or by Withdraw.
    await expect(steps.nth(7)).toContainText("Before you clear browser data, close the hub's channel in the node's Channels.");
    await expect(steps.nth(7)).toContainText("On Close, choose My wallet to send the node's share straight to your address.");
    await expect(steps.nth(7)).toContainText("then Withdraw with the node's password.");
    // The channel from the hub is asked for on the hub card, with the wallet's node id.
    await expect(steps.nth(2)).toContainText("On the hub card, paste it and press Get a channel.");
    await expect(steps.nth(2).getByRole("link", { name: /The hub card/ })).toHaveAttribute("href", "/app/guide#hub");
    // The node lives in the header's Fiber node popup.
    await expect(steps.nth(3)).toContainText("At the top right, open Fiber node.");
    await expect(steps.nth(3)).toContainText("Back up the key: Settings, Download encrypted backup.");
    await expect(steps.nth(4)).toContainText("In the node's Add funds, Fund from a wallet");
    // Tokens: cWBTC from its faucet to the node's address; the hub's channels are ticked and opened in one press.
    await expect(steps.nth(4)).toContainText("Test cWBTC on chain, if you want some: claim it to the node's address.");
    await expect(steps.nth(5)).toContainText("In the node's Channels, tick CKB and any tokens such as cWBTC, then Open.");
    await expect(steps.nth(5)).toContainText("Each token is its own channel and needs about 181 CKB more on chain.");
    // Swaps by QR code and pasted invoice.
    await expect(steps.nth(6)).toContainText("BTC to CKB: type the sats, press Swap, pay the invoice from Alby Hub.");
    await expect(steps.nth(6)).toContainText("CKB to BTC: flip with ⇅, paste an invoice from Alby Hub, press Swap.");
    await expect(steps.nth(7)).toContainText("Withdraw sends all the node's on-chain CKB to your address, minus a small fee.");
    await expect(steps.nth(7)).toContainText("Clearing browser data deletes the node's keys");

    for (const line of await page.getByTestId("testnet-guide-steps").locator("ul > li").allTextContents()) {
      if (line.startsWith("docker run")) continue;
      expect(line.trim().split(/\s+/).length, line).toBeLessThanOrEqual(MAX_LINE_WORDS);
    }
  });

  test("the commands to copy sit in focusable blocks; links lead to the faucets and the app, not the node page", async ({ page }) => {
    await page.goto("/app/guide");
    const docker = page.getByRole("region", { name: "Docker command for Alby Hub on Mutinynet" });
    await expect(docker).toContainText("docker run -d --name albyhub-mutinynet");
    await expect(docker).toContainText("NETWORK=signet");
    await expect(docker).toHaveAttribute("tabindex", "0");
    await expect(page.getByRole("region", { name: "Megalith's address" })).toContainText("@64.23.192.68:9736");
    await expect(page.getByRole("button", { name: "Copy command" })).toBeVisible();

    const link = (name: string) => page.getByTestId("testnet-guide-steps").getByRole("link", { name: new RegExp(`^${name}`) });
    await expect(link("Mutinynet faucet")).toHaveAttribute("href", "https://faucet.mutinynet.com");
    await expect(link("Mutinynet faucet")).toHaveAttribute("target", "_blank");
    await expect(link("Nervos faucet")).toHaveAttribute("href", "https://faucet.nervos.org/");
    // NEXT_PUBLIC_CWBTC_FAUCET_URL is not set for the test build: the CKB testnet cWBTC faucet.
    await expect(link("Get test cWBTC")).toHaveAttribute("href", "https://faucet-cwbtc.ckb.dev");
    await expect(link("Get test cWBTC")).toHaveAttribute("target", "_blank");
    // The node lives in the header's Fiber node popup: no step sends the visitor to the node page.
    await expect(link("Open the node page")).toHaveCount(0);
    await expect(link("Open the app").first()).toHaveAttribute("href", "/app");
  });

  test("Report a problem opens a new issue on the web repo", async ({ page }) => {
    await page.goto("/app/guide");
    const report = page.getByTestId("testnet-guide-report");
    await expect(report).toHaveText(/Report a problem/);
    await expect(report).toHaveAttribute("target", "_blank");
    const href = new URL((await report.getAttribute("href"))!);
    expect(`${href.origin}${href.pathname}`).toBe("https://github.com/Tech-Expansion/CKBolt/issues/new");
    expect(href.searchParams.get("title")).toBe("Problem with the testnet demo");
  });

  test("axe finds nothing serious, and nothing is wider than a 390 px screen", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/app/guide");
    await expect(page.getByTestId("testnet-guide")).toBeVisible();
    await expectNoSeriousAxe(page, "main");
    await page.setViewportSize(PHONE);
    await expectNoHorizontalOverflow(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });

  test("reached from the live card's How it works", async ({ page, context }) => {
    await new LiveHub().install(context);
    await page.goto("/app");
    await page.getByTestId("how-it-works").click({ timeout: CARD_TIMEOUT_MS });
    const dialog = page.getByRole("dialog", { name: "How it works" });
    await dialog.getByTestId("how-it-works-guide-link").click();
    await expect(page).toHaveURL(/\/app\/guide$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Try a live swap.");
  });

  test("How it works also links to the hub's connection details, which open at the guide's hub card", async ({ page, context }) => {
    await new LiveHub().install(context);
    await page.goto("/app");
    await page.getByTestId("how-it-works").click({ timeout: CARD_TIMEOUT_MS });
    const link = page.getByRole("dialog", { name: "How it works" }).getByTestId("how-it-works-hub-link");
    await expect(link).toHaveText("Hub connection details");
    await expect(link).toHaveAttribute("href", "/app/guide#hub");
    await link.click();
    await expect(page).toHaveURL(/\/app\/guide#hub$/);
    await expect(hubTag(page)).toHaveText("Live");
    await expect(hubCard(page)).toBeInViewport();
  });
});

/* ------------------------------------------------------------------------------------ the CKBolt hub card */

const hubCard = (page: Page) => page.getByTestId("hub-card");
const hubTag = (page: Page) => page.getByTestId("hub-card-status");
/** bottle's tentacle peer id: the fake hub's Fiber node is bottle's. */
const HUB_PEER_ID = "QmXen3eUHhywmutEzydCsW4hXBoeVmdET2FJvMX69XJ1Eo";

/** Opens the "?" popover named `label` inside `scope` and returns it (Radix renders it as a dialog with that name). */
async function openTip(scope: Locator, label: string): Promise<Locator> {
  await scope.getByRole("button", { name: label, exact: true }).click();
  const tip = scope.page().getByRole("dialog", { name: label });
  await expect(tip).toBeVisible();
  return tip;
}

test.describe("the guide's CKBolt hub card", () => {
  test.beforeEach(async ({ context }) => {
    await isolate(context);
  });

  test("shows the live hub as its API reports it: Lightning URIs to add as a peer, the Fiber node and its addresses, channels, limits", async ({ page, context, browserName }) => {
    const hub = new LiveHub();
    await hub.install(context);
    await page.goto("/app/guide");
    const card = hubCard(page);
    await expect(card.getByRole("heading", { level: 2 })).toHaveText(/CKBolt hub/);
    await expect(hubTag(page)).toHaveText("Live");
    // Nothing to explain while the hub is live and taking swaps.
    await expect(card.getByTestId("hub-card-line")).toHaveCount(0);

    // Lightning: the hub's URIs, each with Copy, and where Alby Hub adds a peer; the channel the hub opens to wallets.
    const lightning = card.getByTestId("hub-card-lightning");
    await expect(lightning.getByRole("heading", { level: 3 })).toHaveText("Lightning · Bitcoin signet (Mutinynet)");
    await expect(lightning.getByTestId("hub-card-lightning-uri")).toHaveText(HUB_LIGHTNING_NODE.uris);
    await expect(lightning).toContainText("Add it as a peer in your Lightning wallet (Alby Hub: Node → Advanced → Connect Peer).");
    await expect(lightning.getByTestId("hub-card-lightning-channels")).toHaveText("30,000 sats, 20,000 on your side");
    if (browserName === "chromium") {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await lightning.getByRole("button", { name: "Copy address" }).click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(HUB_LIGHTNING_NODE.uris[0]);
    }

    // Fiber: the node id, its TCP address with the peer id for Fiber Studio or fnn, the WebSocket ones behind the "?".
    const fiber = card.getByTestId("hub-card-fiber");
    await expect(fiber.getByRole("heading", { level: 3 })).toHaveText("Fiber · CKB testnet");
    await expect(fiber.getByTestId("hub-card-fiber-node-id")).toHaveText(HUB_FIBER_NODE.nodeId);
    await expect(fiber.getByRole("button", { name: "Copy node id" })).toBeVisible();
    await expect(fiber.getByTestId("hub-card-fiber-p2p")).toHaveText(`/ip4/127.0.0.1/tcp/8228/p2p/${HUB_PEER_ID}`);
    const ws = await openTip(fiber, "About the hub's WebSocket addresses");
    await expect(ws).toContainText("The browser node on this site dials these WebSocket addresses itself:");
    await expect(ws.getByTestId("hub-card-fiber-ws").locator("span")).toHaveText(HUB_FIBER_NODE.addresses.ws.map((a) => `${a}/p2p/${HUB_PEER_ID}`));
    await page.keyboard.press("Escape");
    await expect(fiber.getByTestId("hub-card-fiber-inbound")).toHaveText("Inbound 1,000 CKB · 20 RUSD");

    // The limits per swap, as the swap card's Details write them.
    const limits = card.getByTestId("hub-card-limits");
    await expect(limits.locator("dt")).toHaveText(["CKB", "RUSD"]);
    await expect(limits.locator("dd")).toHaveText(["1,000 to 100,000 sats", "1,000 to 100,000 sats"]);
    // Read through the app's proxy.
    for (const key of ["GET /v1/health", "GET /v1/assets", "GET /v1/lightning/node", "GET /v1/fiber/node"]) expect(hub.count(key), key).toBeGreaterThan(0);
  });

  test("an external node: the connect_peer command, a channel asked for per token, a token's whitelist entry, the hub's refusals", async ({ page, context, browserName }) => {
    const hub = new LiveHub();
    await hub.install(context);
    await page.goto("/app/guide");
    const fiber = hubCard(page).getByTestId("hub-card-fiber");

    // connect_peer for the hub's TCP address, as a curl line for fnn's RPC.
    const connect = fiber.getByTestId("hub-card-fiber-connect");
    await connect.getByTestId("hub-card-fiber-connect-toggle").click();
    const curl = await connect.getByTestId("hub-card-fiber-connect-text").textContent();
    expect(curl).toContain("curl -s -X POST http://127.0.0.1:8227");
    expect(JSON.parse(/-d '([\s\S]*)'$/.exec(curl ?? "")?.[1] ?? "null")).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "connect_peer",
      params: [{ address: `/ip4/127.0.0.1/tcp/8228/p2p/${HUB_PEER_ID}` }],
    });
    if (browserName === "chromium") {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await connect.getByRole("button", { name: "Copy command" }).click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(curl);
    }

    const channel = fiber.getByTestId("hub-card-fiber-channel");
    await expect(channel.getByRole("heading", { level: 4 })).toHaveText("Get a Fiber channel from the hub");
    // Not a node id: nothing is asked.
    await channel.getByTestId("hub-card-fiber-channel-node-id").fill("not a node id");
    await channel.getByTestId("hub-card-fiber-channel-request").click();
    await expect(channel.getByTestId("hub-card-fiber-channel-error")).toContainText("Paste your Fiber node id");
    expect(hub.fiberChannelBodies).toEqual([]);

    // CKB, the first token: no whitelist entry needed; the hub takes the request and the line reads Opening.
    const nodeId = `03${"ab".repeat(32)}`;
    await channel.getByTestId("hub-card-fiber-channel-node-id").fill(nodeId);
    await expect(channel.getByRole("radio", { name: "CKB · the hub puts in 1,000 CKB" })).toHaveAttribute("aria-checked", "true");
    await expect(channel.getByTestId("hub-card-fiber-whitelist")).toHaveCount(0);
    await channel.getByTestId("hub-card-fiber-channel-request").click();
    await expect(channel.getByTestId("hub-card-fiber-channel-status")).toHaveText("Opening: ready after a few confirmations.");
    expect(hub.fiberChannelBodies).toEqual([{ nodeId, asset: "CKB" }]);

    // RUSD: the whitelist entry the node needs, then a 409 because the node is not connected to the hub.
    await channel.getByRole("radio", { name: /^RUSD/ }).click();
    const whitelist = channel.getByTestId("hub-card-fiber-whitelist");
    await whitelist.getByTestId("hub-card-fiber-whitelist-toggle").click();
    const yaml = await whitelist.getByTestId("hub-card-fiber-whitelist-text").textContent();
    expect(yaml).toContain("ckb:\n  udt_whitelist:\n    - name: \"RUSD\"");
    expect(yaml).toContain(`args: "^${RUSD_WHITELIST.script.args}$"`);
    expect(yaml).toContain("auto_accept_amount: 2000000000");
    hub.fiberAnswers.set("RUSD", { status: 409, body: apiError("conflict", "Your Fiber node is not connected to the hub's Fiber node.") });
    await channel.getByTestId("hub-card-fiber-channel-request").click();
    await expect(channel.getByTestId("hub-card-fiber-channel-error")).toContainText("Connect your node to the hub first (the command above), then try again.");
    await expectNoHorizontalOverflow(page);
  });

  test("an external node's channel the hub already has reads Ready with what the node can receive", async ({ page, context }) => {
    const hub = new LiveHub();
    const nodeId = `02${"cd".repeat(32)}`;
    hub.fiberInboundChannels.set(nodeId, [{ channelId: `0x${"01".repeat(32)}`, asset: "CKB", state: "ready", hubBalance: "80000000000", nodeBalance: "0" }]);
    await hub.install(context);
    await page.goto("/app/guide");
    const channel = hubCard(page).getByTestId("hub-card-fiber-channel");
    await channel.getByTestId("hub-card-fiber-channel-node-id").fill(nodeId);
    await expect(channel.getByTestId("hub-card-fiber-channel-status")).toHaveText("Ready: you can receive 800 CKB.");
    await expect(channel.getByTestId("hub-card-fiber-channel-request")).toHaveCount(0);
  });

  test("another hub shows its own figures: nothing on the card is fixed in the page", async ({ page, context }) => {
    const hub = new LiveHub();
    hub.assets = hub.assets.slice(0, 1).map((a) => ({ ...a, minSats: "2500", maxSats: "50000" }));
    hub.lightningNode = { ...HUB_LIGHTNING_NODE, uris: ["03aa@10.0.0.1:9735", "03aa@[2001:db8::1]:9735"], inbound: { enabled: false, capacitySats: "0", pushSats: "0" } };
    hub.fiberNode = { ...HUB_FIBER_NODE, addresses: { p2p: ["/dns4/fiber.example.test/tcp/8228/p2p/QmCustom"], ws: [] }, inbound: { enabled: false, amounts: {} } };
    await hub.install(context);
    await page.goto("/app/guide");
    const card = hubCard(page);
    await expect(card.getByTestId("hub-card-lightning-uri")).toHaveText(["03aa@10.0.0.1:9735", "03aa@[2001:db8::1]:9735"]);
    await expect(card.getByTestId("hub-card-lightning-channels")).toHaveText("Not offered");
    // A hub that opens no Lightning channels offers no request for one.
    await expect(card.getByTestId("wallet-lightning-channel")).toHaveCount(0);
    // An address that names its peer keeps it.
    await expect(card.getByTestId("hub-card-fiber-p2p")).toHaveText("/dns4/fiber.example.test/tcp/8228/p2p/QmCustom");
    await expect(card.getByTestId("hub-card-fiber-inbound")).toHaveText("Not offered");
    await expect(await openTip(card.getByTestId("hub-card-fiber"), "About the hub's WebSocket addresses")).toHaveText("The hub lists no WebSocket address.");
    await page.keyboard.press("Escape");
    await expect(card.getByTestId("hub-card-limits").locator("dd")).toHaveText(["2,500 to 50,000 sats"]);
  });

  test("a hub that cannot be reached says so, and lists nothing", async ({ page, context }) => {
    await installNoHub(context);
    await page.goto("/app/guide");
    await expect(hubTag(page)).toHaveText("Unavailable");
    await expect(hubCard(page).getByTestId("hub-card-line")).toHaveText("The hub cannot be reached right now. Try again later.");
    await expect(hubCard(page).getByTestId("hub-card-lightning")).toHaveCount(0);
    await expect(hubCard(page).getByTestId("hub-card-limits")).toHaveCount(0);
    // The rest of the guide stays.
    await expect(page.getByTestId("testnet-guide-steps")).toBeVisible();
  });

  test("a degraded or paused hub says so, the reason behind a question mark; a part the hub cannot give leaves the others", async ({ page, context }) => {
    const hub = new LiveHub();
    hub.health = { ...hub.health, status: "degraded", reason: "The Lightning node is not synced." };
    hub.healthStatus = 503;
    hub.lightningNode = null;
    await hub.install(context);
    await page.goto("/app/guide");
    const card = hubCard(page);
    await expect(hubTag(page)).toHaveText("Degraded");
    await expect(card.getByTestId("hub-card-line")).toContainText("Reachable, but not taking swaps right now.");
    await expect(await openTip(card, "Why the hub is not taking swaps")).toHaveText("The Lightning node is not synced.");
    await page.keyboard.press("Escape");
    // GET /v1/lightning/node answered 404: that part says so, its message behind a "?"; the Fiber part still shows.
    const lightning = card.getByTestId("hub-card-lightning");
    await expect(lightning.getByTestId("hub-card-unavailable")).toContainText("Not available from this hub right now.");
    await expect(await openTip(lightning, "About this error")).toHaveText("This is not a CKBolt hub API path.");
    await page.keyboard.press("Escape");
    await expect(card.getByTestId("hub-card-fiber-node-id")).toHaveText(HUB_FIBER_NODE.nodeId);
    // No assets from a degraded hub: no limits yet.
    await expect(card.getByTestId("hub-card-limits")).toContainText("Shown once the hub serves swaps.");
  });

  test("a hub in maintenance reads Swaps paused", async ({ page, context }) => {
    const hub = new LiveHub();
    hub.health = { ...hub.health, swaps: { paused: true } };
    await hub.install(context);
    await page.goto("/app/guide");
    await expect(hubTag(page)).toHaveText("Swaps paused");
    await expect(hubCard(page).getByTestId("hub-card-line")).toHaveText("Swaps are paused for maintenance.");
    await expect(hubCard(page).getByTestId("hub-card-fiber-node-id")).toBeVisible();
  });

  test("the #hub link opens at the card; axe finds nothing serious and it fits a 390 px screen", async ({ page, context }) => {
    await new LiveHub().install(context);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/app/guide#hub");
    await expect(hubTag(page)).toHaveText("Live");
    await expect(hubCard(page).getByTestId("hub-card-fiber-node-id")).toBeVisible();
    await expect(hubCard(page)).toBeInViewport();
    // The channel request with a refusal on screen.
    const channel = hubCard(page).getByTestId("wallet-lightning-channel");
    await channel.getByTestId("wallet-lightning-channel-request").click();
    await expect(channel.getByTestId("wallet-lightning-channel-error")).toBeVisible();
    await expectNoSeriousAxe(page, "main");
    await page.setViewportSize(PHONE);
    await expectNoHorizontalOverflow(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
});

/* ------------------------------------------------------------- a Lightning channel from the hub (F3.1) */

/** A Lightning wallet's node id, as Alby Hub shows it (Node page): 33 bytes of hex. */
const WALLET_NODE_ID = "03" + "5e".repeat(32);
/** The hub's channels are read again every 10 s while one opens (HUB_CLIENT_TIMING.lightningChannelPollMs). */
const CHANNEL_POLL_TIMEOUT_MS = 15_000;

test.describe("a Lightning channel from the hub, on the hub card", () => {
  test.beforeEach(async ({ context }) => {
    await isolate(context);
  });

  /** Opens the guide at its hub card and returns the card's channel section. */
  async function channelSection(page: Page) {
    await page.goto("/app/guide#hub");
    const section = hubCard(page).getByTestId("hub-card-lightning").getByTestId("wallet-lightning-channel");
    await expect(section).toBeVisible({ timeout: CARD_TIMEOUT_MS });
    return section;
  }

  test("paste the wallet's node id, Get a channel, then Opening until Ready; only the node id goes to the hub", async ({ page, context }) => {
    const hub = new LiveHub();
    await hub.install(context);
    const section = await channelSection(page);
    await expect(section.getByRole("heading", { level: 4 })).toHaveText("Get a Lightning channel from the hub");
    const tip = await openTip(section, "Why a channel from the hub");
    await expect(tip).toContainText("Alby Hub (LDK) on Mutinynet can pay the hub only over a direct channel");
    await expect(tip).toContainText("paste your wallet's node id here");
    await page.keyboard.press("Escape");

    // Something that is not a node id is refused in the page: nothing goes to the hub.
    const field = section.getByLabel("Your Lightning node id");
    await field.fill(`0x${WALLET_NODE_ID}`);
    await section.getByTestId("wallet-lightning-channel-request").click();
    await expect(section.getByTestId("wallet-lightning-channel-error")).toHaveText("Paste your node id: 66 hex characters, starting 02 or 03.");
    await expect(field).toHaveAttribute("aria-invalid", "true");
    expect(hub.lightningBodies).toEqual([]);

    await field.fill(` ${WALLET_NODE_ID.toUpperCase()} `);
    await field.press("Enter");
    const status = section.getByTestId("wallet-lightning-channel-status");
    await expect(status).toHaveText("Opening: ready after a few confirmations.");
    await expect(section.getByTestId("wallet-lightning-channel-error")).toHaveCount(0);
    expect(hub.lightningBodies).toEqual([{ pubkey: WALLET_NODE_ID }]);
    await expect(section.getByTestId("wallet-lightning-channel-request")).toHaveCount(0);

    // The page reads the channel again while it opens.
    hub.setLightningChannel(WALLET_NODE_ID, "ready", "19700");
    await expect(status).toHaveText("Ready: you can pay 19,700 sats.", { timeout: CHANNEL_POLL_TIMEOUT_MS });
    expect(hub.count("GET /v1/lightning/inbound-channels/:pubkey")).toBeGreaterThan(1);

    // Opened again later with the same node id, the card shows the channel as it is and asks for nothing.
    await page.reload();
    const again = await channelSection(page);
    await again.getByLabel("Your Lightning node id").fill(WALLET_NODE_ID);
    await expect(again.getByTestId("wallet-lightning-channel-status")).toHaveText("Ready: you can pay 19,700 sats.");
    expect(hub.count("POST /v1/lightning/inbound-channels")).toBe(1);
  });

  test("the hub's refusals in plain words: add the peer first, the limit; a wallet that has a channel already sees it", async ({ page, context }) => {
    const hub = new LiveHub();
    const peerFirst = `Connect your wallet to the hub first: ${HUB_LIGHTNING_NODE.uris[0]}`;
    hub.lightningAnswers.push(
      { status: 409, body: apiError("conflict", peerFirst) },
      { status: 429, body: apiError("rate_limited", "This wallet already got a channel today.") },
      { status: 409, body: apiError("conflict", "This wallet already has a channel with the hub.") },
    );
    await hub.install(context);
    const section = await channelSection(page);
    await section.getByLabel("Your Lightning node id").fill(WALLET_NODE_ID);
    const request = section.getByTestId("wallet-lightning-channel-request");
    const error = section.getByTestId("wallet-lightning-channel-error");

    await request.click();
    await expect(error).toContainText("Add the hub as a peer in your wallet first, then try again.");
    await expect(await openTip(section, "About this error")).toContainText(peerFirst);
    await page.keyboard.press("Escape");

    await request.click();
    await expect(error).toContainText("The hub's channel limit is reached. Try again later.");

    // A 409 while the hub lists a channel with the wallet: the channel shows, not an error.
    hub.setLightningChannel(WALLET_NODE_ID, "opening");
    await request.click();
    await expect(section.getByTestId("wallet-lightning-channel-status")).toHaveText("Opening: ready after a few confirmations.");
    await expect(error).toHaveCount(0);
    expect(hub.lightningBodies).toHaveLength(3);
  });

  test("no request when the hub does not know the route; the card's Lightning part says it cannot be read", async ({ page, context }) => {
    const hub = new LiveHub();
    hub.lightningNode = null;
    await hub.install(context);
    await page.goto("/app/guide#hub");
    const lightning = hubCard(page).getByTestId("hub-card-lightning");
    await expect(lightning.getByTestId("hub-card-unavailable")).toBeVisible({ timeout: CARD_TIMEOUT_MS });
    await expect(lightning.getByTestId("wallet-lightning-channel")).toHaveCount(0);
    expect(hub.lightningBodies).toEqual([]);
  });
});
