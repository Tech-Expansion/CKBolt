import { randomBytes } from "node:crypto";
import { test as base, expect, type BrowserContext, type Locator, type Page, type Route } from "@playwright/test";
import { ccc } from "@ckb-ccc/core";
import type { Script } from "../../lib/hub/contract";
import { peerIdOf } from "../../lib/wallets/fiber-browser/peer-id";
import { CKB_RPC_DEFAULT_URL } from "../../lib/wallets/fiber-browser/constants";
import { FIBER_WALLET_PATH } from "../../lib/wallets/fiber-popup/constants";
import { POPUP_POSITION } from "../../lib/wallets/fiber-popup/popup-position";
import { FALLBACK_COPY, WALLET_CHROME } from "../../components/app/fiber-wallet/copy";
import { closeMessage, navigateMessage, statusMessage } from "../../lib/wallets/fiber-popup/relay";
import { FakeCkbChain, type JsonRpcRequest } from "./fiber-byo-fakes";
import { lightningInvoice } from "./fakes/hub";
import { expectNoHorizontalOverflow, expectNoSeriousAxe } from "./page-checks";
import {
  FakeCkbRpc,
  HUB_FIBER_NODE,
  hubChannel,
  installFakeNode,
  knownPeer,
  nodeCalls,
  nodeIdentity,
  nodeInvoices,
  RUSD_SCRIPT,
  setNodeChannels,
  shareNodeHash,
  units,
} from "./support/fiber-node";
import {
  browserHasDip,
  createWalletNode,
  DIP_PROBE_TIMEOUT_MS,
  exposeRealLockArgs,
  NO_DIP_REASON,
  NODE_POLL_TIMEOUT_MS,
  openPage,
  openWallet,
  openWalletPopup,
  unlockAfterReload,
  unlockWallet,
  WALLET_PASSWORD,
  WALLET_TIMEOUT_MS,
  WALLET_WINDOW_PATH,
  walletFrame,
  withoutWalletIsolation,
  type Wallet,
} from "./support/fiber-wallet";
import { isolate, LiveHub } from "./support/live-hub";
import { SwapCard } from "./support/swap-card";

/*
 * The Fiber node popup (docs/fiber-wallet-popup.md): the header button, its popover and the iframe of /app/wallet that
 * runs the node, Home and every page of it. The popover's iframe is isolated by Document-Isolation-Policy, which real
 * Chrome and Edge have and Playwright's bundled Chromium does not: run these with PW_CHANNEL=chrome. On a browser
 * without it the pages are tested in the window the popover offers instead (/app/fiber?view=wallet), and the tests that
 * need the iframe itself are skipped. fiber-js is the fake of support/fiber-node.ts, the hub the fake of
 * support/live-hub.ts; nothing reaches a real network.
 */

const SECP_CODE_HASH = "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8";
const CKB_RPC = CKB_RPC_DEFAULT_URL.testnet;
const FRAME = '[data-testid="fiber-wallet-frame"]';
/** The popover from sm up: about an extension's size (components/app/fiber-wallet/styles.ts). */
const POPOVER_PX = { width: 380, height: 600 };
/** The popover's room for the node: its size less its title bar, for checking the node's own page at that size. */
const WALLET_FRAME_PX = { width: 380, height: 550 };
const TEST_TIMEOUT_MS = 120_000;

const hexQ = (n: bigint) => `0x${n.toString(16)}`;
const shorten = (s: string, n = 10) => (s.length > n * 2 + 3 ? `${s.slice(0, n)}…${s.slice(-n)}` : s);
const rpcScript = (s: Script) => ({ code_hash: s.codeHash, hash_type: s.hashType, args: s.args });

/** A plain wallet's lock and address on CKB testnet. */
function walletAddress() {
  const lock: Script = { codeHash: SECP_CODE_HASH, hashType: "type", args: `0x${randomBytes(20).toString("hex")}` };
  return { lock, address: ccc.Address.from({ script: lock, prefix: "ckt" }).toString() };
}

const nodeAddress = (lockArgs: string) =>
  ccc.Address.from({ script: { codeHash: SECP_CODE_HASH, hashType: "type", args: lockArgs }, prefix: "ckt" }).toString();

/** The CKB testnet RPC as a whole fake chain (support for CCC's withdrawal), with CORS like the real one. */
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

/**
 * Clicks a link of the site and waits for its client-side navigation to land. Next.js changes the URL only once the new
 * page has committed, and under load that takes seconds: measured 2.9 to 5.3 s from the click to the landing page's
 * commit on the phone profile with the CPU slowed four times and six workers, where a URL assertion's 5 s ran out
 * while the navigation was still on its way (the click itself always landed on the link). So this waits for the
 * navigation event, within the test's own timeout.
 */
async function followLink(page: Page, link: Locator, url: RegExp) {
  await Promise.all([page.waitForURL(url), link.click()]);
}

/** True when focus is in the popover: on its own controls, or anywhere inside its iframe. */
const focusInPopover = (page: Page) => page.evaluate(() => !!document.getElementById("fiber-wallet-popover")?.contains(document.activeElement));

interface Fixtures {
  hub: LiveHub;
  /** The browser isolates the popover's iframe with Document-Isolation-Policy. */
  dip: boolean;
}

const test = base.extend<Fixtures>({
  hub: async ({ context }, use) => {
    await isolate(context);
    const hub = new LiveHub();
    await hub.install(context);
    await use(hub);
  },
  dip: [
    async ({ browser, baseURL }, use) => {
      await use(await browserHasDip(browser, baseURL!));
    },
    { timeout: DIP_PROBE_TIMEOUT_MS },
  ],
});

/** A running wallet with a fresh node, its id and lock args. */
async function runningWallet(page: Page, dip: boolean): Promise<Wallet & { nodeId: string; lockArgs: string }> {
  const wallet = await openWallet(page, dip);
  await createWalletNode(wallet.ui);
  const { nodeId, lockArgs } = await nodeIdentity(wallet.scope);
  return { ...wallet, nodeId: nodeId!, lockArgs: lockArgs! };
}

/* ------------------------------------------------------------------------------------- route and headers */

test.describe("the popup's route", () => {
  test("only /app/wallet may be framed, by this site alone, and it isolates itself with Document-Isolation-Policy, no COOP", async ({ request }) => {
    const wallet = await request.get(FIBER_WALLET_PATH);
    expect(wallet.status()).toBe(200);
    const headers = wallet.headers();
    expect(headers["document-isolation-policy"]).toBe("isolate-and-credentialless");
    expect(headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(headers["content-security-policy"]).toBe("frame-ancestors 'self'; object-src 'none'; base-uri 'self'; form-action 'self'");
    expect(headers["cross-origin-opener-policy"]).toBeUndefined();
    expect(headers["cross-origin-embedder-policy"]).toBeUndefined();
    expect(headers["x-content-type-options"]).toBe("nosniff");
    // One policy each: the rule that forbids framing everywhere else does not also match the wallet.
    const names = wallet.headersArray().map((h) => h.name.toLowerCase());
    expect(names.filter((n) => n === "content-security-policy")).toHaveLength(1);
    expect(names.filter((n) => n === "x-frame-options")).toHaveLength(1);

    for (const path of ["/", "/app", "/app/guide", "/app/fiber", "/app/fiber/fund", WALLET_WINDOW_PATH]) {
      const other = await request.get(path);
      expect(other.status(), path).toBe(200);
      expect(other.headers()["x-frame-options"], path).toBe("DENY");
      expect(other.headers()["content-security-policy"], path).toContain("frame-ancestors 'none'");
      expect(other.headers()["content-security-policy"], path).not.toContain("'self'; object-src");
    }
  });
});

/* ------------------------------------------------------------------------------------ button and popover */

test.describe("the header's Fiber node", () => {
  test("opens in a popover anchored top right (a sheet on a phone); Escape, Close and a click outside hide it; the iframe loads once", async ({
    page,
    hub: _hub,
    dip,
    isMobile,
  }) => {
    // It waits for the isolated iframe to load (up to WALLET_TIMEOUT_MS, seconds under a full parallel run), so its own
    // budget must be larger than the default 30 s: the step that ran out was the last one, not a slow one.
    test.setTimeout(TEST_TIMEOUT_MS);
    await page.goto("/app");
    const button = page.getByTestId("fiber-wallet-button");
    await expect(button).toHaveText("Fiber node");
    await expect(button).toHaveAccessibleName("Fiber node: not opened");
    await expect(button).toHaveAttribute("aria-expanded", "false");
    await expect(button).toHaveAttribute("aria-haspopup", "dialog");
    // Nothing of the node loads before the visitor opens it.
    await expect(page.locator(FRAME)).toHaveCount(0);

    await button.click();
    const popover = page.getByRole("dialog", { name: "Fiber node" });
    await expect(popover).toBeVisible();
    await expect(popover).toHaveAttribute("aria-modal", "true");
    await expect(button).toHaveAttribute("aria-expanded", "true");
    await expect(button).toHaveAttribute("aria-controls", "fiber-wallet-popover");
    await expect(page.getByTestId("fiber-wallet-close")).toBeFocused();
    await expect(page.getByTestId("fiber-wallet-close")).toHaveAccessibleName("Close the Fiber node");
    const ui = page.frameLocator(FRAME);
    await expect(ui.locator("[data-testid=fiber-wallet], [data-testid=fiber-wallet-fallback]")).toBeVisible({ timeout: WALLET_TIMEOUT_MS });
    // The iframe tells the button where it stands: no key yet, or (without DIP) a node that opens in a window.
    await expect(button).toHaveAccessibleName(dip ? "Fiber node: no key yet" : "Fiber node: opens in a window");
    // A mark in the node's document: a reloaded iframe would lose it.
    const frame = await walletFrame(page);
    await frame.evaluate(() => {
      (window as unknown as { __walletMark: string }).__walletMark = "first load";
    });

    const box = (await popover.boundingBox())!;
    const viewport = page.viewportSize()!;
    if (isMobile) {
      expect(Math.round(box.width)).toBe(viewport.width);
      expect(Math.round(box.height)).toBe(viewport.height);
    } else {
      expect(Math.round(box.width)).toBe(POPOVER_PX.width);
      expect(Math.round(box.height)).toBe(POPOVER_PX.height);
      expect(viewport.width - (box.x + box.width)).toBeLessThanOrEqual(17);
      expect(box.y).toBeLessThan(100);
    }

    // Escape on the popover's own controls, and Escape inside the node.
    await page.keyboard.press("Escape");
    await expect(popover).toBeHidden();
    await expect(button).toBeFocused();
    await expect(button).toHaveAttribute("aria-expanded", "false");
    await button.click();
    await expect(popover).toBeVisible();
    await ui.locator("button").first().focus();
    await page.keyboard.press("Escape");
    await expect(popover).toBeHidden();
    await expect(button).toBeFocused();

    // Close; and on a desktop, a click anywhere else on the page.
    await button.click();
    await page.getByTestId("fiber-wallet-close").click();
    await expect(popover).toBeHidden();
    if (!isMobile) {
      await button.click();
      await expect(popover).toBeVisible();
      await page.mouse.click(40, viewport.height - 40);
      await expect(popover).toBeHidden();
    }
    // The same iframe throughout: hidden, never reloaded.
    await expect(page.locator(FRAME)).toHaveCount(1);
    expect(await frame.evaluate(() => (window as unknown as { __walletMark?: string }).__walletMark)).toBe("first load");
  });

  test("keeps keyboard focus inside while open: Tab and Shift+Tab go round Close and the node", async ({ page, hub: _hub }) => {
    await openWalletPopup(page);
    await expect(page.getByTestId("fiber-wallet-close")).toBeFocused();
    let back = false;
    for (let i = 0; i < 30 && !back; i++) {
      await page.keyboard.press("Tab");
      expect(await focusInPopover(page), `after ${i + 1} Tab`).toBe(true);
      back = await page.getByTestId("fiber-wallet-close").evaluate((el) => el === document.activeElement);
    }
    expect(back, "Tab comes back round to Close").toBe(true);
    // Backwards from Close: into the node's last control, never out of the popover.
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("Shift+Tab");
      expect(await focusInPopover(page), `after ${i + 1} Shift+Tab`).toBe(true);
    }
  });

  test("create, lock and unlock: the button shows Locked, then the CKB a swap can send; pages that need the node say so", async ({ page, context, hub: _hub, dip }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    await installFakeNode(context, { channels: [hubChannel({ local: units(1_101), remote: units(901) })] });
    const wallet = await openWallet(page, dip);
    const { ui } = wallet;
    const button = page.getByTestId("fiber-wallet-button");
    // No key yet: the key forms, no page buttons, and Settings to restore a backup.
    await expect(ui.getByTestId("fiber-wallet-open-channels")).toHaveCount(0);
    await openPage(ui, "settings");
    await expect(ui.getByTestId("fiber-node-restore")).toBeVisible();
    await openPage(ui, "home");

    // Password rules, then a running node: what a swap can move, its CKB, the hub, its pages.
    const home = ui.getByTestId("fiber-wallet-home");
    await home.getByLabel("Password, at least 8 characters").fill("short");
    await home.getByLabel("Repeat the password").fill("short");
    await home.getByRole("button", { name: "Create node" }).click();
    await expect(home.getByTestId("fiber-node-key-error")).toHaveText("Use at least 8 characters.");
    await createWalletNode(ui);
    const { nodeId } = await nodeIdentity(wallet.scope);
    await expect(ui.getByTestId("fiber-wallet-ready")).toContainText("Ready to swap");
    await expect(ui.getByTestId("fiber-wallet-liquidity").getByRole("row", { name: /CKB/ }).first()).toContainText("1,101");
    await expect(ui.getByTestId("fiber-wallet-balance")).toHaveText("600 CKB");
    await expect(ui.getByTestId("fiber-wallet-hub")).toContainText("Connected");
    for (const p of ["add-funds", "channels", "withdraw", "settings"]) await expect(ui.getByTestId(`fiber-wallet-open-${p}`)).toBeVisible();
    if (wallet.popup) {
      await expect(button).toHaveText("1,101 CKB");
      await expect(button).toHaveAccessibleName("Fiber node: running, can send 1,101 CKB");
    }
    await openPage(ui, "settings");
    await expect(ui.getByTestId("fiber-wallet-node-id")).toContainText(shorten(nodeId!, 8));

    // Lock (in Settings): the key is asked for again on Home.
    await ui.getByTestId("fiber-wallet-lock").click();
    await openPage(ui, "home");
    await expect(home.getByTestId("fiber-node-unlock")).toContainText(`Node ${shorten(nodeId!, 8)} is stored in this browser.`);
    await expect(ui.getByTestId("fiber-wallet-open-channels")).toHaveCount(0);
    if (wallet.popup) {
      await expect(button).toHaveText("Locked");
      // The page asks for a page that needs the node: it says so until the node runs.
      await page.evaluate((m) => (document.querySelector("[data-testid=fiber-wallet-frame]") as HTMLIFrameElement).contentWindow!.postMessage(m, location.origin), navigateMessage("withdraw"));
      await expect(ui.getByTestId("fiber-wallet-page-title")).toHaveText("Withdraw");
      await expect(ui.getByTestId("fiber-wallet-page-withdraw").getByTestId("fiber-wallet-needs-node")).toHaveText("Opens once your node runs.");
      await openPage(ui, "home");
    }

    await home.getByLabel("Password", { exact: true }).fill("not the password");
    await home.getByRole("button", { name: "Unlock and start node" }).click();
    await expect(home.getByTestId("fiber-node-key-error")).toHaveText("Wrong password, or the stored node key was changed.");
    await unlockWallet(ui);
    expect((await nodeIdentity(wallet.scope)).nodeId).toBe(nodeId);
    if (wallet.popup) await expect(button).toHaveText("1,101 CKB");
  });

  test("the node keeps running across client-side navigation: same iframe, same node, no password again", async ({
    page,
    context,
    hub: _hub,
    dip,
    isMobile,
  }) => {
    test.skip(!dip, NO_DIP_REASON);
    test.setTimeout(TEST_TIMEOUT_MS);
    await installFakeNode(context, { channels: [hubChannel({ local: units(1_101), remote: units(901) })] });
    const wallet = await openWalletPopup(page, "/app");
    await createWalletNode(wallet.ui);
    await wallet.scope.evaluate(() => {
      (window as unknown as { __walletMark: string }).__walletMark = "still here";
    });
    await page.getByTestId("fiber-wallet-close").click();
    const button = page.getByTestId("fiber-wallet-button");
    await expect(button).toHaveText("1,101 CKB");

    // The header's links move client-side: to the guide, then home by the logo.
    if (isMobile) await page.getByRole("button", { name: "Open menu" }).click();
    await followLink(page, page.locator("header").getByRole("link", { name: "Guide", exact: true }).filter({ visible: true }), /\/app\/guide$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Try a live swap.");
    await expect(button).toHaveText("1,101 CKB");
    await followLink(page, page.locator("header").getByRole("link", { name: /CKBolt/ }).first(), /\/$/);
    await expect(button).toHaveText("1,101 CKB");

    const frame = await walletFrame(page);
    expect(await frame.evaluate(() => (window as unknown as { __walletMark?: string }).__walletMark)).toBe("still here");
    expect(await nodeCalls(frame, "node_info")).toHaveLength(1);
    await button.click();
    await expect(page.frameLocator(FRAME).getByTestId("fiber-wallet-balance")).toBeVisible();
  });
});

/* ------------------------------------------------------------------------------------- moving the popup */

/** A desktop window tall enough for the popup (600 px) to move up and down as well as sideways. */
const ROOMY_PX = { width: 1280, height: 900 };
/** A phone's width in a desktop browser: below sm, where the popup is a sheet. */
const NARROW_PX = { width: 390, height: 844 };
/** The popup's anchored place from sm up (styles.ts): 16 px from the right (`sm:right-4`), 88 px from the top (`sm:top-[5.5rem]`). */
const ANCHOR_PX = { right: 16, top: 88 };
const MARGIN = POPUP_POSITION.MARGIN_PX;
const PHONE_SKIP = "On a phone the popup is a full-height sheet that does not move: tested in its own test below.";

const popoverOf = (page: Page) => page.getByTestId("fiber-wallet-popover");
const popupTitle = (page: Page) => page.getByTestId("fiber-wallet-handle").getByRole("heading", { name: "Fiber node" });
const keptPoint = (page: Page) => page.evaluate((key) => localStorage.getItem(key), POPUP_POSITION.STORAGE_KEY);

/** The viewport fixed elements are placed in, without scroll bars. */
const viewportOf = (page: Page) => page.evaluate(() => ({ width: document.documentElement.clientWidth, height: document.documentElement.clientHeight }));

async function popupBox(page: Page) {
  const box = await popoverOf(page).boundingBox();
  expect(box, "the popover shows").not.toBeNull();
  return { x: Math.round(box!.x), y: Math.round(box!.y), width: Math.round(box!.width), height: Math.round(box!.height) };
}

/** Unmoved, the popup sits anchored top right under the header. */
async function expectAnchored(page: Page) {
  const viewport = await viewportOf(page);
  await expect.poll(async () => {
    const box = await popupBox(page);
    return { right: viewport.width - (box.x + box.width), top: box.y };
  }).toEqual(ANCHOR_PX);
}

/** Presses the real mouse at the middle of `target`, and returns where. */
async function pressOn(page: Page, target: Locator) {
  const box = (await target.boundingBox())!;
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  return at;
}

/** Drags `target` by (dx, dy) with the real mouse, in steps as a hand would, and releases. */
async function dragBy(page: Page, target: Locator, dx: number, dy: number) {
  const at = await pressOn(page, target);
  await page.mouse.move(at.x + dx, at.y + dy, { steps: 10 });
  await page.mouse.up();
}

/** Drags the popup's title to a point of the viewport and releases there. */
async function dragTitleTo(page: Page, x: number, y: number) {
  await pressOn(page, popupTitle(page));
  await page.mouse.move(x, y, { steps: 12 });
  await page.mouse.up();
}

/**
 * Clicks a control inside the node's iframe with the real mouse and checks the node took it: the create form's password
 * field where the browser isolates the iframe, else the fallback's "?" (Playwright's Chromium has no DIP).
 */
async function clickInsideNode(page: Page) {
  const ui = page.frameLocator(FRAME);
  const fallback = ui.getByTestId("fiber-wallet-fallback");
  await expect(ui.locator("[data-testid=fiber-node-create], [data-testid=fiber-wallet-fallback]")).toBeVisible({ timeout: WALLET_TIMEOUT_MS });
  if (await fallback.isVisible()) {
    await pressOn(page, fallback.getByTestId("info-tip"));
    await page.mouse.up();
    await expect(ui.getByText(FALLBACK_COPY.TIP)).toBeVisible();
    return;
  }
  const field = ui.getByLabel("Password, at least 8 characters");
  await pressOn(page, field);
  await page.mouse.up();
  await expect(field).toBeFocused();
  await page.keyboard.type("typed after a drag");
  await expect(field).toHaveValue("typed after a drag");
}

test.describe("moving the popup", () => {
  test("its title bar drags it anywhere in the window, never past an edge; a drag is no click outside, a click still is", async ({ page, hub: _hub, isMobile }) => {
    test.skip(isMobile, PHONE_SKIP);
    await page.setViewportSize(ROOMY_PX);
    await openWalletPopup(page);
    await expectAnchored(page);
    const start = await popupBox(page);
    const viewport = await viewportOf(page);
    await expect(page.getByTestId("fiber-wallet-handle")).toHaveCSS("cursor", "grab");

    // Pressed, the iframe takes no pointer events (it would swallow the moves), and the popup follows the pointer.
    const at = await pressOn(page, popupTitle(page));
    await expect(page.locator(FRAME)).toHaveCSS("pointer-events", "none");
    await expect(page.getByTestId("fiber-wallet-handle")).toHaveCSS("cursor", "grabbing");
    await page.mouse.move(at.x - 500, at.y + 120, { steps: 10 });
    const moved = { ...start, x: start.x - 500, y: start.y + 120 };
    await expect.poll(() => popupBox(page)).toEqual(moved);
    await page.mouse.up();
    await expect(page.locator(FRAME)).toHaveCSS("pointer-events", "auto");
    expect(await popupBox(page)).toEqual(moved);
    expect(await keptPoint(page)).toBe(JSON.stringify({ x: moved.x, y: moved.y }));

    // Pulled past the top-left corner and released outside it, over the page: it stops MARGIN px from both edges and stays open.
    await dragTitleTo(page, 2, 2);
    await expect(popoverOf(page)).toBeVisible();
    expect(await popupBox(page)).toEqual({ ...start, x: MARGIN, y: MARGIN });
    // Past the bottom-right corner.
    await dragTitleTo(page, viewport.width - 2, viewport.height - 2);
    await expect(popoverOf(page)).toBeVisible();
    expect(await popupBox(page)).toEqual({ ...start, x: viewport.width - start.width - MARGIN, y: viewport.height - start.height - MARGIN });

    // A click on the page closes it, as before.
    await page.mouse.click(40, 140);
    await expect(popoverOf(page)).toBeHidden();
  });

  test("it stays where it was left: closed and opened again, after a reload, through Escape mid-drag; a double click puts it back", async ({ page, hub: _hub, isMobile }) => {
    test.skip(isMobile, PHONE_SKIP);
    test.setTimeout(TEST_TIMEOUT_MS);
    await page.setViewportSize(ROOMY_PX);
    await openWalletPopup(page);
    const button = page.getByTestId("fiber-wallet-button");
    await dragBy(page, popupTitle(page), -420, 160);
    const left = await popupBox(page);
    expect(left.y).toBe(ANCHOR_PX.top + 160);

    // Escape, then Close; each time the header button opens it where it was left.
    await page.keyboard.press("Escape");
    await expect(popoverOf(page)).toBeHidden();
    await button.click();
    expect(await popupBox(page)).toEqual(left);
    await page.getByTestId("fiber-wallet-close").click();
    await expect(popoverOf(page)).toBeHidden();
    await button.click();
    expect(await popupBox(page)).toEqual(left);

    // A reload: the place comes back from localStorage.
    await page.reload();
    await page.getByTestId("fiber-wallet-button").click();
    await expect(popoverOf(page)).toBeVisible();
    expect(await popupBox(page)).toEqual(left);

    // Escape in the middle of a drag closes it where it got to; it opens there.
    const at = await pressOn(page, popupTitle(page));
    await page.mouse.move(at.x + 100, at.y - 50, { steps: 6 });
    await expect.poll(() => popupBox(page)).toEqual({ ...left, x: left.x + 100, y: left.y - 50 });
    await page.keyboard.press("Escape");
    await expect(popoverOf(page)).toBeHidden();
    await page.mouse.up();
    await page.getByTestId("fiber-wallet-button").click();
    expect(await popupBox(page)).toEqual({ ...left, x: left.x + 100, y: left.y - 50 });

    // A double click on the title bar: anchored again, nothing kept, and so after a reload.
    await popupTitle(page).dblclick();
    await expectAnchored(page);
    expect(await keptPoint(page)).toBeNull();
    await page.reload();
    await page.getByTestId("fiber-wallet-button").click();
    await expect(popoverOf(page)).toBeVisible();
    await expectAnchored(page);

    // A place kept for a larger window is clamped into this one; one the page did not write is ignored.
    await page.evaluate((key) => localStorage.setItem(key, JSON.stringify({ x: 5000, y: -300 })), POPUP_POSITION.STORAGE_KEY);
    await page.reload();
    await page.getByTestId("fiber-wallet-button").click();
    const viewport = await viewportOf(page);
    expect(await popupBox(page)).toEqual({ ...left, x: viewport.width - left.width - MARGIN, y: MARGIN });
    await page.evaluate((key) => localStorage.setItem(key, "{\"x\":\"left\"}"), POPUP_POSITION.STORAGE_KEY);
    await page.reload();
    await page.getByTestId("fiber-wallet-button").click();
    await expectAnchored(page);
  });

  test("from the keyboard: Move, before Close, takes the arrow keys (Shift for big steps) and Home; Escape still closes", async ({ page, hub: _hub, isMobile }) => {
    test.skip(isMobile, PHONE_SKIP);
    await page.setViewportSize(ROOMY_PX);
    await openWalletPopup(page);
    const move = page.getByTestId("fiber-wallet-move");
    await expect(move).toHaveAccessibleName(WALLET_CHROME.MOVE);
    await expect(move).toHaveAccessibleDescription(WALLET_CHROME.MOVE_HINT);
    await expect(move).toHaveAttribute("title", WALLET_CHROME.MOVE_HINT);
    // Close keeps the focus it gets on opening; Move comes just before it.
    await expect(page.getByTestId("fiber-wallet-close")).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(move).toBeFocused();

    const start = await popupBox(page);
    const { STEP_PX, BIG_STEP_PX } = POPUP_POSITION;
    await page.keyboard.press("ArrowLeft");
    expect(await popupBox(page)).toEqual({ ...start, x: start.x - STEP_PX });
    await page.keyboard.press("ArrowDown");
    expect(await popupBox(page)).toEqual({ ...start, x: start.x - STEP_PX, y: start.y + STEP_PX });
    await page.keyboard.press("Shift+ArrowLeft");
    await page.keyboard.press("Shift+ArrowUp");
    const stepped = { ...start, x: start.x - STEP_PX - BIG_STEP_PX, y: start.y + STEP_PX - BIG_STEP_PX };
    expect(await popupBox(page)).toEqual(stepped);
    expect(await keptPoint(page)).toBe(JSON.stringify({ x: stepped.x, y: stepped.y }));
    // Never past an edge.
    for (let i = 0; i < 4; i++) await page.keyboard.press("Shift+ArrowUp");
    expect((await popupBox(page)).y).toBe(MARGIN);
    await expect(move).toBeFocused();
    await expectNoSeriousAxe(page, "[data-testid=fiber-wallet-popover]");
    await expectNoSeriousAxe(page, "header");

    // Home puts it back and forgets the place.
    await page.keyboard.press("Home");
    await expectAnchored(page);
    expect(await keptPoint(page)).toBeNull();
    // Tab past the node's last control comes round to Move, the popup's first control.
    await page.locator("[data-focus-guard=end]").focus();
    await expect(move).toBeFocused();
    // Escape on Move closes the popup, as anywhere in it, and focus goes back to the header button.
    await page.keyboard.press("Escape");
    await expect(popoverOf(page)).toBeHidden();
    await expect(page.getByTestId("fiber-wallet-button")).toBeFocused();
  });

  test("after a drag the node takes clicks again; badges drag with the bar, Close never drags and still closes", async ({ page, hub: _hub, isMobile }) => {
    test.skip(isMobile, PHONE_SKIP);
    test.setTimeout(TEST_TIMEOUT_MS);
    await page.setViewportSize(ROOMY_PX);
    await openWalletPopup(page);
    const close = page.getByTestId("fiber-wallet-close");
    // A press on the bar keeps focus where it was (Close has it on opening).
    await dragBy(page, popupTitle(page), -300, 100);
    await expect(close).toBeFocused();
    await clickInsideNode(page);

    // The Testnet badge is part of the bar: it drags the popup.
    const before = await popupBox(page);
    await dragBy(page, page.getByTestId("fiber-wallet-handle").getByText(WALLET_CHROME.TAG), -60, 30);
    expect(await popupBox(page)).toEqual({ ...before, x: before.x - 60, y: before.y + 30 });

    // Close is a control: a press on it that moves drags nothing, and its click still closes the popup.
    const placed = await popupBox(page);
    await dragBy(page, close, -200, 40);
    expect(await popupBox(page)).toEqual(placed);
    await expect(popoverOf(page)).toBeVisible();
    await close.click();
    await expect(popoverOf(page)).toBeHidden();
  });

  test("a window made smaller keeps it inside; made larger again, it goes back where it was left", async ({ page, hub: _hub, isMobile }) => {
    test.skip(isMobile, PHONE_SKIP);
    await page.setViewportSize(ROOMY_PX);
    await openWalletPopup(page);
    await dragTitleTo(page, ROOMY_PX.width - 2, ROOMY_PX.height - 2);
    const corner = await popupBox(page);
    expect(corner.x + corner.width).toBe((await viewportOf(page)).width - MARGIN);

    await page.setViewportSize({ width: 900, height: 720 });
    const small = await viewportOf(page);
    // 600 px tall fits 720 - 104 (sm:max-h-[calc(100dvh-6.5rem)]), so it keeps its size and moves in.
    await expect.poll(() => popupBox(page)).toEqual({ ...corner, x: small.width - corner.width - MARGIN, y: small.height - corner.height - MARGIN });
    await page.setViewportSize(ROOMY_PX);
    await expect.poll(() => popupBox(page)).toEqual(corner);
  });

  test("below sm (a phone, or 390 px) it is a full-height sheet that does not move; widened, it moves and keeps its place", async ({ page, hub: _hub, isMobile }) => {
    if (!isMobile) await page.setViewportSize(NARROW_PX);
    await openWalletPopup(page);
    const viewport = await viewportOf(page);
    const sheet = { x: 0, y: 0, width: viewport.width, height: viewport.height };
    expect(await popupBox(page)).toEqual(sheet);
    await expect(page.getByTestId("fiber-wallet-move")).toHaveCount(0);
    await expect(page.getByTestId("fiber-wallet-handle")).toHaveCSS("cursor", "auto");
    // A press on the title bar that moves moves nothing and closes nothing.
    await dragBy(page, popupTitle(page), 80, 120);
    expect(await popupBox(page)).toEqual(sheet);
    await expect(popoverOf(page)).toBeVisible();
    expect(await keptPoint(page)).toBeNull();
    await expectNoSeriousAxe(page, "[data-testid=fiber-wallet-popover]");
    await expectNoHorizontalOverflow(page);
    if (isMobile) return;

    // Widened past sm it is the anchored panel and moves; narrowed, a sheet again; widened, back where it was left.
    await page.setViewportSize(ROOMY_PX);
    await expect(page.getByTestId("fiber-wallet-move")).toBeVisible();
    await expectAnchored(page);
    await dragBy(page, popupTitle(page), -400, 100);
    const left = await popupBox(page);
    await page.setViewportSize(NARROW_PX);
    await expect(page.getByTestId("fiber-wallet-move")).toHaveCount(0);
    const narrow = await viewportOf(page);
    await expect.poll(() => popupBox(page)).toEqual({ x: 0, y: 0, width: narrow.width, height: narrow.height });
    await page.setViewportSize(ROOMY_PX);
    await expect.poll(() => popupBox(page)).toEqual(left);
  });
});

/* ------------------------------------------------------------------------------------------------ pages */

const PAGE_TITLE = { "add-funds": "Add funds", channels: "Channels", withdraw: "Withdraw", settings: "Settings", history: "History" } as const;

test.describe("the node's pages", () => {
  test("Home, then each page and Back: focus goes to the page's title and back to the button that opened it; passwords clear", async ({
    page,
    context,
    hub: _hub,
    dip,
  }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    await installFakeNode(context);
    const wallet = await openWallet(page, dip);
    const { ui } = wallet;
    const home = ui.getByTestId("fiber-wallet-home");
    await createWalletNode(ui);
    const title = ui.getByTestId("fiber-wallet-page-title");
    for (const p of Object.keys(PAGE_TITLE) as (keyof typeof PAGE_TITLE)[]) {
      const opener = ui.getByTestId(`fiber-wallet-open-${p}`);
      await opener.click();
      await expect(title).toHaveText(PAGE_TITLE[p]);
      await expect(title).toBeFocused();
      await expect(home).toBeHidden();
      await ui.getByTestId("fiber-wallet-back").click();
      await expect(home).toBeVisible();
      await expect(opener).toBeFocused();
    }
    // By keyboard: Enter on a page's button opens it, Enter on Back returns to that button.
    await ui.getByTestId("fiber-wallet-open-channels").focus();
    await page.keyboard.press("Enter");
    await expect(title).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(ui.getByTestId("fiber-wallet-back")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(ui.getByTestId("fiber-wallet-open-channels")).toBeFocused();

    // A password typed on one page is gone once another page shows (here: Home's unlock, then Settings and back).
    await openPage(ui, "settings");
    await ui.getByTestId("fiber-wallet-lock").click();
    await openPage(ui, "home");
    const password = home.getByLabel("Password", { exact: true });
    await password.fill(WALLET_PASSWORD);
    await openPage(ui, "settings");
    await openPage(ui, "home");
    await expect(password).toHaveValue("");
  });

  test("Add funds: the node's address with its QR code and Copy, and the funding page in a new tab", async ({ page, context, hub: _hub, dip }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    await installFakeNode(context);
    const { ui, lockArgs } = await runningWallet(page, dip);
    await openPage(ui, "add-funds");
    const funds = ui.getByTestId("fiber-wallet-add-funds");
    const address = nodeAddress(lockArgs);
    await expect(funds.getByTestId("fiber-node-address")).toContainText(address);
    await expect(funds.getByRole("img", { name: "QR code of the node's CKB testnet address" })).toBeVisible();
    await expect(funds.getByRole("button", { name: "Copy address" })).toBeVisible();
    const fund = funds.getByTestId("fiber-node-fund");
    await expect(fund).toHaveText("Fund from a wallet");
    await expect(fund).toHaveAttribute("href", `/app/fiber/fund?address=${address}`);
    await expect(fund).toHaveAttribute("target", "_blank");
    await funds.getByRole("button", { name: "About funding the node" }).click();
    await expect(ui.getByRole("dialog", { name: "About funding the node" })).toContainText("testnet CKB or RUSD");
  });

  test("Channels: the hub first (its rows, what the node puts in, one button), then the list, then other nodes under Advanced", async ({ page, context, hub, dip }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    const rpc = new FakeCkbRpc();
    rpc.balance = units(1_400);
    await rpc.install(context);
    // The CKB channel the node accepts is ready at once, so the run does not wait for its confirmations before RUSD.
    await installFakeNode(context, { acceptedState: "ChannelReady" });
    const { ui, nodeId, scope } = await runningWallet(page, dip);
    await openPage(ui, "channels");
    const channels = ui.getByTestId("fiber-wallet-channels");
    const request = channels.getByTestId("fiber-node-hub-request");
    const yours = channels.getByRole("heading", { name: "Your channels" });
    const advanced = channels.getByRole("button", { name: "Advanced" });
    expect((await request.boundingBox())!.y).toBeLessThan((await yours.boundingBox())!.y);
    expect((await yours.boundingBox())!.y).toBeLessThan((await advanced.boundingBox())!.y);
    await expect(advanced).toHaveAttribute("aria-expanded", "false");
    await expect(channels.getByLabel("Your node puts in")).toHaveValue("1200");
    await expect(channels.getByTestId("fiber-node-hub-line-CKB")).toHaveText("Hub funds 1,000 CKB");
    await expect(channels.getByTestId("fiber-node-hub-line-RUSD")).toHaveText("Hub funds 20 RUSD · needs 181 CKB reserve");

    // Both ticked, one press: CKB, then RUSD.
    await channels.getByRole("checkbox", { name: "CKB", exact: true }).check();
    await channels.getByRole("checkbox", { name: "RUSD", exact: true }).check();
    await expect(channels.getByTestId("fiber-node-hub-total")).toHaveText("Needs 1,382 CKB on chain · you have 1,400 CKB");
    await channels.getByTestId("fiber-node-hub-open").click();
    await expect(channels.getByTestId("fiber-node-hub-summary")).toHaveText("2 channels asked for. Each reads Ready after a few confirmations.", {
      timeout: WALLET_TIMEOUT_MS,
    });
    // The node accepted the hub's CKB channel itself (accept_channel), with the 1,200 CKB chosen: no restart.
    expect(await nodeCalls(scope, "accept_channel")).toContainEqual({ temporary_channel_id: expect.stringMatching(/^0x[0-9a-f]{64}$/), funding_amount: "0x1bf08eb000" });
    expect(hub.fiberChannelBodies).toEqual([
      { nodeId, asset: "CKB" },
      { nodeId, asset: "RUSD" },
    ]);
  });

  test("Channels, Advanced: opens and funds a channel with another node over its WebSocket address, in CKB or RUSD; never with the hub", async ({
    page,
    context,
    hub: _hub,
    dip,
  }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    const peer = `03${"cd".repeat(32)}`;
    // The node holds 50 RUSD on chain: the form reads it (get_cells) before it lets a RUSD channel go.
    const rpc = new FakeCkbRpc();
    rpc.tokenCells[RUSD_SCRIPT.args.toLowerCase()] = [units(50)];
    await rpc.install(context);
    // fnn lists a dialled peer only once connected, and refuses open_channel before that: the page must wait.
    await installFakeNode(context, { knownPeers: knownPeer(peer), peerListDelay: { [peer]: 3 } });
    const { ui, scope } = await runningWallet(page, dip);
    await openPage(ui, "channels");
    await ui.getByRole("button", { name: "Advanced" }).click();
    const form = ui.getByTestId("fiber-wallet-peer-channel");
    await form.getByRole("button", { name: "About channels with other nodes" }).click();
    await expect(ui.getByRole("dialog", { name: "About channels with other nodes" })).toContainText(
      "The CKBolt hub takes payments only over channels it opened itself",
    );
    await page.keyboard.press("Escape");

    const nodeIdField = form.getByLabel("Node id");
    const address = form.getByLabel("WebSocket address");
    const amount = form.getByLabel("Channel amount");
    const submit = form.getByRole("button", { name: "Open channel" });
    await nodeIdField.fill(HUB_FIBER_NODE.nodeId);
    await expect(form).toContainText("That is the CKBolt hub. Use Open with the hub instead.");
    await nodeIdField.fill(peer);
    await address.fill("/ip4/1.2.3.4/tcp/8228");
    await expect(form).toContainText("Enter the node's WebSocket address");
    await address.fill(`/dns4/peer.example/tcp/443/wss/p2p/${peerIdOf(HUB_FIBER_NODE.nodeId)}`);
    await expect(form).toContainText("This address names another node than this id.");
    await address.fill("/dns4/peer.example/tcp/443/wss");
    await amount.fill("50");
    await expect(form).toContainText("Put in at least 100 CKB");
    await amount.fill("700");
    await expect(form).toContainText("Your node needs 701 CKB on chain for this. Add funds first.");
    await expect(submit).toBeDisabled();
    await amount.fill("500");
    await submit.click();
    // The result shows inside the form, next to the button that asked.
    await expect(form.getByTestId("fiber-wallet-channels-notice")).toContainText(`Opening a channel with ${shorten(peer, 6)}.`, { timeout: WALLET_TIMEOUT_MS });
    const dialled = `/dns4/peer.example/tcp/443/wss/p2p/${peerIdOf(peer)}`;
    expect(await nodeCalls(scope, "connect_peer")).toContainEqual({ address: dialled });
    // Opened once the peer was listed: no refusal on the way.
    expect(await nodeCalls(scope, "open_channel")).toEqual([{ pubkey: peer, funding_amount: hexQ(units(500)), public: false }]);
    await expect(form.getByTestId("fiber-wallet-channels-error")).toHaveCount(0);
    await expect(ui.getByTestId("fiber-node-channels")).toContainText("Opening", { timeout: NODE_POLL_TIMEOUT_MS });

    // A RUSD channel names the token's script.
    await form.getByRole("radio", { name: "RUSD" }).click();
    await expect(form).toContainText("50 RUSD");
    await amount.fill("10");
    await submit.click();
    await expect.poll(async () => (await nodeCalls(scope, "open_channel")).length).toBe(2);
    expect((await nodeCalls(scope, "open_channel"))[1]).toEqual({
      pubkey: peer,
      funding_amount: hexQ(units(10)),
      public: false,
      funding_udt_type_script: rpcScript(RUSD_SCRIPT),
    });
    // Already a peer: not dialled again.
    expect((await nodeCalls(scope, "connect_peer")).filter((c) => c?.address === dialled)).toHaveLength(1);
  });

  test("Channels: closes the hub's channel to the visitor's wallet (close_script)", async ({ page, context, hub: _hub, dip }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    const channel = hubChannel({ local: units(401), remote: units(0) });
    await installFakeNode(context, { channels: [channel] });
    const { ui, scope } = await runningWallet(page, dip);
    await openPage(ui, "channels");
    const list = ui.getByTestId("fiber-node-channels");
    await expect(list).toContainText("CKBolt hub · CKB");
    await expect(list).toContainText("Send 401 · Receive 0");
    await list.getByRole("button", { name: "Close" }).click();
    const confirm = ui.getByTestId("fiber-node-close-confirm");
    await expect(confirm).toContainText("Close the CKB channel with the CKBolt hub?");
    await confirm.getByRole("radio", { name: /^My wallet/ }).click();
    const wallet = walletAddress();
    await confirm.getByLabel("Your CKB testnet address").fill(wallet.address);
    await confirm.getByRole("button", { name: "Yes, close" }).click();
    await expect(ui.getByTestId("fiber-wallet-channels-notice")).toHaveText(
      `Closing the channel cooperatively. Its share goes to ${shorten(wallet.address, 12)} once confirmed.`,
    );
    expect(await nodeCalls(scope, "shutdown_channel")).toEqual([{ channel_id: channel.channel_id, close_script: rpcScript(wallet.lock) }]);
    await expect(list).toContainText("Closing");
  });

  test("History: a channel asked for and a channel closed show on Home and in History, and follow the node's channels", async ({
    page,
    context,
    hub: _hub,
    dip,
  }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    const rpc = new FakeCkbRpc();
    rpc.balance = units(1_300);
    await rpc.install(context);
    const ckbChannel = hubChannel({ local: units(401), remote: units(0) });
    await installFakeNode(context, { channels: [ckbChannel] });
    const { ui, scope } = await runningWallet(page, dip);
    // Nothing yet: one line, and the first steps.
    await openPage(ui, "history");
    const empty = ui.getByTestId("fiber-wallet-history-empty");
    await expect(empty).toContainText("No swaps, payments or channels yet.");
    await empty.getByRole("button", { name: "Channels" }).click();
    await expect(ui.getByTestId("fiber-wallet-page-title")).toHaveText("Channels");

    const channels = ui.getByTestId("fiber-wallet-channels");
    // The CKB row reads Open (the node has that channel); RUSD is ticked and opened.
    await expect(channels.getByTestId("fiber-node-hub-row-CKB")).toHaveAttribute("data-status", "open", { timeout: NODE_POLL_TIMEOUT_MS });
    await channels.getByRole("checkbox", { name: "RUSD", exact: true }).check();
    await channels.getByTestId("fiber-node-hub-open").click();
    await expect(channels.getByTestId("fiber-node-hub-summary")).toHaveText("Channel asked for. It reads Ready after a few confirmations.");
    await ui.getByTestId("fiber-node-channels").getByRole("button", { name: "Close" }).click();
    await ui.getByTestId("fiber-node-close-confirm").getByRole("button", { name: "Yes, close" }).click();
    await expect(ui.getByTestId("fiber-wallet-channels-notice")).toContainText("Closing the channel cooperatively.");

    // Home: the newest first, each with its status.
    await openPage(ui, "home");
    const recent = ui.getByTestId("fiber-wallet-recent").getByTestId("history-entry");
    await expect(recent).toHaveCount(2);
    await expect(recent.nth(0)).toContainText("Closing channel with the CKBolt hub · 401 CKB");
    await expect(recent.nth(0)).toHaveAttribute("data-status", "Closing");
    await expect(recent.nth(1)).toContainText("Opening channel with the CKBolt hub · 20 RUSD");
    await expect(recent.nth(1)).toHaveAttribute("data-status", "Opening");

    // The hub's RUSD channel turns Ready and the CKB one closes: the entries follow.
    await setNodeChannels(scope, [
      { ...ckbChannel, state: { state_name: "Closed" } },
      hubChannel({ local: units(0), remote: units(20), udt: RUSD_SCRIPT }),
    ]);
    await expect(recent.nth(0)).toHaveAttribute("data-status", "Closed", { timeout: NODE_POLL_TIMEOUT_MS });
    await expect(recent.nth(0)).toContainText("Closed channel with the CKBolt hub · 401 CKB");
    await expect(recent.nth(1)).toHaveAttribute("data-status", "Open", { timeout: NODE_POLL_TIMEOUT_MS });

    // History: by day, with a filter; a row opens to its detail.
    await ui.getByTestId("fiber-wallet-open-history").click();
    const list = ui.getByTestId("fiber-wallet-history-list");
    await expect(list.getByTestId("history-entry")).toHaveCount(2);
    for (const filter of ["Swaps", "Payments", "Funds"]) {
      await list.getByRole("radio", { name: filter }).click();
      await expect(list).toContainText("Nothing of this kind yet.");
    }
    await list.getByRole("radio", { name: "Channels" }).click();
    await expect(list.getByTestId("history-entry")).toHaveCount(2);
    const closed = list.getByTestId("history-entry").first();
    await closed.getByRole("button").first().click();
    await expect(closed.getByTestId("history-entry-detail")).toContainText(shorten(ckbChannel.channel_id, 10));
    await expect(closed.getByRole("button", { name: "Copy channel" })).toBeVisible();
  });

  test("Withdraw: all the node's on-chain CKB to the visitor's address, signed with the node's password; it shows in History", async ({
    page,
    context,
    hub: _hub,
    dip,
  }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    const chain = new FakeCkbChain();
    await installChain(context, chain);
    await exposeRealLockArgs(context);
    await installFakeNode(context);
    const { ui, lockArgs, popup } = await runningWallet(page, dip);
    chain.addCell({ lock: { codeHash: SECP_CODE_HASH, hashType: "type", args: lockArgs }, capacity: units(750) });
    await openPage(ui, "add-funds");
    await ui.getByRole("button", { name: "Refresh balance" }).click();
    await openPage(ui, "withdraw");
    // Closing a channel brings its funds back to the node: Channels is one click away.
    await expect(ui.getByTestId("fiber-wallet-withdraw")).toContainText("Closing a channel returns its funds to the node.");
    await ui.getByTestId("fiber-wallet-withdraw-channels").click();
    await expect(ui.getByTestId("fiber-wallet-page-title")).toHaveText("Channels");
    await openPage(ui, "withdraw");
    const form = ui.getByTestId("fiber-node-withdraw");
    await expect(form.getByTestId("fiber-node-withdraw-amount")).toHaveText("Sends all 750 CKB, minus a small fee.");
    const wallet = walletAddress();
    await form.getByLabel("To your CKB testnet address").fill(wallet.address);
    // A typed password does not stay behind: leaving the page (or hiding the popover) clears it; the address stays.
    await form.getByLabel("Node password").fill(WALLET_PASSWORD);
    await openPage(ui, "home");
    await openPage(ui, "withdraw");
    await expect(form.getByLabel("Node password")).toHaveValue("");
    await expect(form.getByLabel("To your CKB testnet address")).toHaveValue(wallet.address);
    if (popup) {
      await form.getByLabel("Node password").fill(WALLET_PASSWORD);
      await page.getByTestId("fiber-wallet-close").click();
      await page.getByTestId("fiber-wallet-button").click();
      await expect(form.getByLabel("Node password")).toHaveValue("");
    }
    await form.getByLabel("Node password").fill(WALLET_PASSWORD);
    await form.getByRole("button", { name: "Withdraw 750 CKB" }).click();
    await expect(ui.getByTestId("fiber-node-withdraw-sent")).toBeVisible({ timeout: WALLET_TIMEOUT_MS });
    expect(chain.sent).toHaveLength(1);
    expect(chain.sent[0].outputs).toHaveLength(1);
    expect(chain.sent[0].outputs[0].lock.args).toBe(wallet.lock.args);

    await openPage(ui, "history");
    const list = ui.getByTestId("fiber-wallet-history-list");
    const entry = list.getByTestId("history-entry");
    await expect(entry).toHaveCount(1);
    await expect(entry).toHaveAttribute("data-kind", "withdraw");
    await list.getByRole("radio", { name: "Funds" }).click();
    await expect(entry).toHaveCount(1);
    await expect(entry).toContainText(/Withdrew [\d,.]+ CKB/);
    await entry.getByRole("button").first().click();
    await expect(entry.getByRole("link", { name: "View on CKB Explorer (testnet)" })).toHaveAttribute("href", /explorer.*\/transaction\/0x/);
  });

  test("Settings: back up, restore and forget the key, the node id and Lock; the full page and the guide open in new tabs", async ({ page, context, hub: _hub, dip }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    await installFakeNode(context);
    const { ui } = await runningWallet(page, dip);
    await openPage(ui, "settings");
    const settings = ui.getByTestId("fiber-wallet-settings");
    await expect(settings.getByTestId("fiber-node-backup")).toContainText("Download encrypted backup");
    await expect(settings.getByTestId("fiber-wallet-lock")).toBeEnabled();
    for (const [testId, href] of [
      ["fiber-wallet-full-page", "/app/fiber"],
      ["fiber-wallet-guide", "/app/guide"],
    ]) {
      await expect(settings.getByTestId(testId)).toHaveAttribute("href", href);
      await expect(settings.getByTestId(testId)).toHaveAttribute("target", "_blank");
    }
    await settings.getByRole("button", { name: "Forget this node" }).click();
    await settings.getByRole("button", { name: "Yes, forget it" }).click();
    await expect(ui.getByTestId("fiber-wallet-home").getByTestId("fiber-node-create")).toBeAttached();
    await expect(settings.getByTestId("fiber-node-restore")).toBeVisible();
  });
});

/* ------------------------------------------------------------------------------------- with the swap card */

test.describe("the node and the swap card", () => {
  test("Open your Fiber node opens the popup on Home, and a swap uses the popup's node", async ({ page, context, hub, dip }) => {
    test.skip(!dip, NO_DIP_REASON);
    test.setTimeout(TEST_TIMEOUT_MS);
    await installFakeNode(context, { channels: [hubChannel({ local: units(0), remote: units(5_000) })] });
    const card = new SwapCard(page);
    await card.open();
    await card.chooseFiber("browser-node");
    await card.type("2000");
    await card.expectPrimary("Open your Fiber node", { enabled: true });
    await card.primary.click();
    await expect(page.getByTestId("fiber-wallet-popover")).toBeVisible();
    await expect(page.getByTestId("fiber-wallet-close")).toBeFocused();
    const ui = page.frameLocator(FRAME);
    await expect(ui.getByTestId("fiber-wallet-page-home")).toBeVisible({ timeout: WALLET_TIMEOUT_MS });

    await createWalletNode(ui);
    await page.getByTestId("fiber-wallet-close").click();
    await expect(card.walletButton()).toHaveAccessibleName("Fiber node: CKBolt node, ready", { timeout: NODE_POLL_TIMEOUT_MS });
    await card.expectPrimary("Swap", { enabled: true });
    await card.swap();
    await card.expectStep(1, "done", "Invoice ready");
    await card.expectStep(2, "done", "Locked");

    // The popup's node made the payout invoice the hub got, and lists the swap in its History.
    const frame = await walletFrame(page);
    const [asked] = await nodeCalls(frame, "new_invoice");
    expect(BigInt(String(asked?.amount))).toBe(BigInt(hub.lastQuote.receive.amount));
    expect(hub.swapBodies[0]).toMatchObject({ payoutInvoice: (await nodeInvoices(frame))[0] });
    const swaps = ui.getByTestId("fiber-wallet-recent").getByTestId("history-entry");
    await expect(swaps.first()).toHaveAttribute("data-kind", "swap");

    // The node made the payout invoice before the swap had an id; the swap the card kept carries the same payment hash
    // (the fake hub draws its own, so it takes the node's here, as the real hub does): one entry, with both sides.
    const nodeHash = await shareNodeHash(hub, frame);
    hub.holdPayment();
    await card.expectStep(3, "done", "The hub holds your payment");
    await card.progress.getByRole("button", { name: "Hide" }).click();
    await page.getByTestId("fiber-wallet-button").click();
    await expect(swaps).toHaveCount(1);
    const entry = swaps.first();
    await expect(entry).toHaveAttribute("data-key", nodeHash);
    await expect(entry).toContainText("Swap: 2,000 sats → ");
    await expect(entry).toHaveAttribute("data-status", "incoming_accepted", { timeout: NODE_POLL_TIMEOUT_MS });
    await expect(entry).toContainText("In progress");
    await entry.getByRole("button").first().click();
    const detail = entry.getByTestId("history-entry-detail");
    await expect(detail).toContainText(hub.current.id);
    await expect(detail).toContainText("2,000 sats");
    await expect(detail.getByTestId("history-entry-report")).toHaveAttribute("href", new RegExp(hub.current.id));
  });

  test("View in History on the swap's result opens the popup on that swap, client-side: the node keeps running", async ({ page, context, hub, dip }) => {
    test.skip(!dip, NO_DIP_REASON);
    test.setTimeout(TEST_TIMEOUT_MS);
    await installFakeNode(context, { channels: [hubChannel({ local: units(20_000), remote: units(0) })] });
    const card = new SwapCard(page);
    await card.open();
    const wallet = await openWalletPopup(page, "");
    await createWalletNode(wallet.ui);
    await wallet.scope.evaluate(() => {
      (window as unknown as { __walletMark: string }).__walletMark = "still here";
    });
    await page.getByTestId("fiber-wallet-close").click();
    await card.chooseFiber("browser-node");
    await card.flipTo("fiber_to_ln");
    // The visitor's own Lightning invoice fixes the amount: 24,750 sats cost 10,000 CKB.
    await card.pasteInvoice(lightningInvoice({ sats: 24_750 }));
    await expect(card.amount).toHaveValue("10,000", { timeout: WALLET_TIMEOUT_MS });
    await card.expectPrimary("Swap", { enabled: true });
    await card.swap();
    await card.expectStep(3, "active", "Sent; waiting for the hub");
    hub.holdPayment();
    hub.startPayout();
    hub.settle();
    await expect(card.result).toContainText("Swap complete", { timeout: WALLET_TIMEOUT_MS });

    // The result's "View in History" hides the dialog and opens the popup on History, open on this swap: the node's
    // payment of the hub's hold invoice and the swap the card kept, one entry.
    await card.progress.getByTestId("history-entry-view").click();
    await expect(card.progress).toBeHidden();
    await expect(page.getByTestId("fiber-wallet-popover")).toBeVisible();
    await expect(wallet.ui.getByTestId("fiber-wallet-page-history")).toBeVisible();
    const list = wallet.ui.getByTestId("fiber-wallet-history-list");
    const entry = list.locator('[data-testid="history-entry"][data-kind="swap"]');
    await expect(entry).toHaveCount(1);
    await expect(entry.getByRole("button").first()).toHaveAttribute("aria-expanded", "true");
    const detail = entry.getByTestId("history-entry-detail");
    await expect(detail).toBeVisible();
    await expect(detail).toContainText(hub.current.id);
    await expect(detail.getByRole("definition")).toContainText(["10,000 CKB", "24,750 sats"]);
    await expect(entry).toContainText("Completed");
    // The banner brings the result back; the card did not put the run away.
    await expect(card.banner).toBeVisible();
    // Nothing moved: the same page, the same iframe, the same node, no password again.
    expect(new URL(page.url()).pathname).toBe("/app");
    const frame = await walletFrame(page);
    expect(await frame.evaluate(() => (window as unknown as { __walletMark?: string }).__walletMark)).toBe("still here");
    expect(await nodeCalls(frame, "node_info")).toHaveLength(1);
  });

  test("the card's other CTAs land on the page that fixes the node: Add funds while it holds too little CKB, else Channels", async ({
    page,
    context,
    hub: _hub,
    dip,
  }) => {
    test.skip(!dip, NO_DIP_REASON);
    test.setTimeout(TEST_TIMEOUT_MS);
    const rpc = new FakeCkbRpc();
    rpc.balance = units(100);
    await rpc.install(context);
    await installFakeNode(context);
    const card = new SwapCard(page);
    await card.open();
    const wallet = await openWalletPopup(page, "");
    await createWalletNode(wallet.ui);
    await page.getByTestId("fiber-wallet-close").click();
    await card.chooseFiber("browser-node");
    await card.type("2000");

    // No channel, and 100 CKB on chain: too little to put into the hub's channel. Add funds first.
    await card.expectPrimary("Ask the hub for a channel", { enabled: true });
    await card.primary.click();
    const title = wallet.ui.getByTestId("fiber-wallet-page-title");
    await expect(page.getByTestId("fiber-wallet-popover")).toBeVisible();
    await expect(title).toHaveText("Add funds");
    // Funded: once the card hears the node's new balance (its Fiber dialog then offers Channels), the button opens Channels.
    rpc.balance = units(1_300);
    await wallet.ui.getByRole("button", { name: "Refresh balance" }).click();
    await page.getByTestId("fiber-wallet-close").click();
    const dialog = await card.openWalletDialog();
    await expect(dialog.getByTestId("fiber-fix-in-node")).toHaveText("Open Channels", { timeout: NODE_POLL_TIMEOUT_MS });
    await card.closeDialog(dialog);
    await card.primary.click();
    await expect(title).toHaveText("Channels");
    await expect(wallet.ui.getByTestId("fiber-wallet-page-channels")).toBeVisible();

    // A channel too small for the payout: "can't receive" opens Channels as well. The node reads its channels now
    // (Refresh), and the card hears it on its next status check.
    await setNodeChannels(wallet.scope, [hubChannel({ local: units(0), remote: units(5) })]);
    await wallet.ui.getByTestId("fiber-wallet-channels").getByRole("button", { name: "Refresh" }).click();
    await expect(wallet.ui.getByTestId("fiber-node-channels")).toContainText("CKBolt hub · CKB");
    await page.getByTestId("fiber-wallet-close").click();
    await card.expectPrimary("Your node can't receive this much CKB", { enabled: true });
    // A swap too big for the node is a step to take, not a failure: the chip's dot is amber.
    await expect(card.walletButton()).toHaveAccessibleName("Fiber node: CKBolt node, needs attention");
    await card.primary.click();
    await expect(title).toHaveText("Channels");
    // Back on Home, focus returns to the Channels button even though the card opened the page.
    await wallet.ui.getByTestId("fiber-wallet-back").click();
    await expect(wallet.ui.getByTestId("fiber-wallet-open-channels")).toBeFocused();
  });

  test("the Fiber dialog opens the page that fixes the node", async ({ page, context, hub: _hub, dip }) => {
    test.skip(!dip, NO_DIP_REASON);
    test.setTimeout(TEST_TIMEOUT_MS);
    const rpc = new FakeCkbRpc();
    rpc.balance = units(1_300);
    await rpc.install(context);
    await installFakeNode(context);
    const card = new SwapCard(page);
    await card.open();
    const wallet = await openWalletPopup(page, "");
    await createWalletNode(wallet.ui);
    await page.getByTestId("fiber-wallet-close").click();
    await card.chooseFiber("browser-node");
    const dialog = await card.openWalletDialog();
    await expect(dialog.getByTestId("fiber-node-problem")).toHaveText("Ask the hub for a channel", { timeout: NODE_POLL_TIMEOUT_MS });
    await dialog.getByTestId("fiber-fix-in-node").click();
    await expect(dialog).toBeHidden();
    await expect(wallet.ui.getByTestId("fiber-wallet-page-title")).toHaveText("Channels");
    await page.getByTestId("fiber-wallet-close").click();
    const again = await card.openWalletDialog();
    await again.getByTestId("fiber-add-funds").click();
    await expect(wallet.ui.getByTestId("fiber-wallet-page-title")).toHaveText("Add funds");
  });
});

/* ------------------------------------------------------------------------------ browsers without DIP */

test.describe("browsers without Document-Isolation-Policy", () => {
  test("the popover offers the node in a window, which runs it; the header button follows that window's node", async ({ page, context, hub: _hub }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    await installFakeNode(context);
    // As in Firefox or Safari: the iframe gets no isolation.
    await withoutWalletIsolation(page);
    await page.goto("/app");
    const button = page.getByTestId("fiber-wallet-button");
    await button.click();
    const fallback = page.frameLocator(FRAME).getByTestId("fiber-wallet-fallback");
    await expect(fallback).toBeVisible({ timeout: WALLET_TIMEOUT_MS });
    await expect(fallback).toContainText("This browser cannot run the node in this popup.");
    await expect(button).toHaveAccessibleName("Fiber node: opens in a window");
    expect(await (await walletFrame(page)).evaluate(() => crossOriginIsolated)).toBe(false);

    const [win] = await Promise.all([context.waitForEvent("page"), fallback.getByRole("button", { name: /^Open the node in a window/ }).click()]);
    await win.waitForLoadState();
    expect(`${new URL(win.url()).pathname}${new URL(win.url()).search}`).toBe(WALLET_WINDOW_PATH);
    await expect(win.getByRole("heading", { name: "Fiber node" })).toBeVisible({ timeout: WALLET_TIMEOUT_MS });
    expect(await win.evaluate(() => crossOriginIsolated)).toBe(true);
    await createWalletNode(win);

    // The popover hears the window's node over the bridge and tells the button.
    await expect(button).toHaveText("0 CKB", { timeout: NODE_POLL_TIMEOUT_MS });
    await expect(fallback).toContainText("Your node window runs the node.");
    await win.close();
  });
});

/* -------------------------------------------------------------------------------- layout, accessibility */

test.describe("the node's layout and accessibility", () => {
  test("the popover over the page: no serious axe finding, nothing wider than the screen", async ({ page, hub: _hub }) => {
    await openWalletPopup(page);
    await expectNoSeriousAxe(page, "[data-testid=fiber-wallet-popover]");
    await expectNoSeriousAxe(page, "header");
    await expectNoHorizontalOverflow(page);
  });

  test("Home and every page fit the popover's size or a phone, with no serious axe finding", async ({ page, context, hub: _hub, isMobile }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    await installFakeNode(context, {
      channels: [hubChannel({ local: units(401), remote: units(150) }), hubChannel({ local: units(0), remote: units(20), udt: RUSD_SCRIPT })],
    });
    if (!isMobile) await page.setViewportSize(WALLET_FRAME_PX);
    // The node's own document at the popover's size: its window, the same popup as in the popover.
    await page.goto(WALLET_WINDOW_PATH);
    await expect(page.getByTestId("fiber-wallet")).toBeVisible({ timeout: WALLET_TIMEOUT_MS });
    await expectNoSeriousAxe(page);
    await expectNoHorizontalOverflow(page);
    await createWalletNode(page);
    for (const p of ["home", "add-funds", "channels", "withdraw", "settings", "history"] as const) {
      await openPage(page, p);
      if (p === "channels") await page.getByRole("button", { name: "Advanced" }).click();
      await expectNoSeriousAxe(page);
      await expectNoHorizontalOverflow(page);
    }
  });
});

/* ------------------------------------------------------------------- relay, leaving, other tabs, links */

test.describe("the node's edges", () => {
  test("opened on its own, /app/wallet goes to the node's window, which has the isolation headers of a window", async ({ page, hub: _hub }) => {
    await page.goto(FIBER_WALLET_PATH);
    await expect(page).toHaveURL(new RegExp(`${WALLET_WINDOW_PATH.replace(/[?]/g, "\\?")}$`));
    await expect(page.getByTestId("fiber-wallet")).toBeVisible({ timeout: WALLET_TIMEOUT_MS });
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  });

  test("a node that does not answer says so and offers Reload, which loads it again", async ({ page, hub: _hub }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    // The first load of the popup fails, as on a dropped connection.
    let failed = false;
    await page.route(`**${FIBER_WALLET_PATH}`, (route) => {
      if (failed) return route.continue();
      failed = true;
      return route.abort("connectionreset");
    });
    await page.goto("/app");
    const button = page.getByTestId("fiber-wallet-button");
    await button.click();
    const silent = page.getByTestId("fiber-wallet-silent");
    await expect(silent).toContainText("The node is not answering.", { timeout: 25_000 });
    await expect(button).toHaveAccessibleName("Fiber node: not answering");
    await page.getByTestId("fiber-wallet-reload").click();
    await expect(page.frameLocator(FRAME).locator("[data-testid=fiber-wallet], [data-testid=fiber-wallet-fallback]")).toBeVisible({ timeout: WALLET_TIMEOUT_MS });
    await expect(silent).toHaveCount(0);
    await expect(button).not.toHaveAccessibleName("Fiber node: not answering");
  });

  test("messages posted by the page itself or by another window of the site neither close the popover nor change the button", async ({
    page,
    context,
    hub: _hub,
  }) => {
    await openWalletPopup(page);
    const button = page.getByTestId("fiber-wallet-button");
    const popover = page.getByTestId("fiber-wallet-popover");
    await expect(button).not.toHaveAccessibleName("Fiber node: loading");
    const name = await button.getAttribute("aria-label");
    const forged = { close: closeMessage(), status: statusMessage({ isolated: true, phase: "running", hasKey: true, sendCkb: "999900000000" }) };
    await page.evaluate((m) => {
      window.postMessage(m.close, location.origin);
      window.postMessage(m.status, location.origin);
    }, forged);
    const [other] = await Promise.all([context.waitForEvent("page"), page.evaluate(() => void window.open("/app/guide", "_blank"))]);
    await other.waitForLoadState();
    await other.evaluate((m) => {
      window.opener?.postMessage(m.close, location.origin);
      window.opener?.postMessage(m.status, location.origin);
    }, forged);
    // Give the page time to act on them, had it taken them.
    await page.waitForTimeout(1_000);
    await expect(popover).toBeVisible();
    await expect(button).toHaveAttribute("aria-label", name!);
    await expect(button).not.toHaveText("9,999 CKB");
    await other.close();
  });

  test("while a swap still needs the node, leaving the page asks first and Lock waits; both free once it is done", async ({ page, context, hub: _hub, dip }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    await installFakeNode(context, { channels: [hubChannel({ local: units(1_101), remote: units(901) })] });
    const { nodeId } = await runningWallet(page, dip);
    // A swap's payment the node made before a reload, still in flight: kept in this browser's activity.
    const hash = `0x${"5e".repeat(32)}`;
    const entry = {
      id: hash,
      kind: "swap",
      asset: "CKB",
      amount: String(units(100)),
      status: "Inflight",
      error: null,
      at: Date.now(),
      swap: { id: "swap-1", leg: "payment", lightningSats: "20000" },
    };
    await page.evaluate(([key, value]) => localStorage.setItem(key, value), [`ckbolt:fiber-browser:testnet:history:${nodeId}`, JSON.stringify([entry])]);
    // A reload: the new document unlocks once the old one let go of the node's Web Lock (an event, not a wait).
    const wallet = await openWallet(page, dip);
    const { ui, scope } = wallet;
    await unlockAfterReload(wallet);
    const leaveAsks = () =>
      scope.evaluate(() => {
        const event = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      });
    const recent = ui.getByTestId("fiber-wallet-recent").getByTestId("history-entry");
    await expect(recent).toContainText("Swap: payment of 100 CKB");
    await expect(recent).toHaveAttribute("data-status", "Inflight");
    await expect(ui.getByTestId("fiber-wallet-page-home").getByTestId("fiber-node-keep-open")).toBeVisible();
    expect(await leaveAsks()).toBe(true);
    await openPage(ui, "settings");
    await expect(ui.getByTestId("fiber-wallet-lock")).toBeDisabled();
    // The node reports the payment done: the entry's status moves once the node read it (get_payment, every 5 s), and
    // then nothing holds the page or Lock.
    await scope.evaluate((h) => {
      (window as unknown as { __fakeFiber: { payments: Record<string, unknown> } }).__fakeFiber.payments[h] = { invoice: "", status: "Success", failed_error: null };
    }, hash);
    await expect(recent).toHaveAttribute("data-status", "Success", { timeout: NODE_POLL_TIMEOUT_MS });
    await expect(ui.getByTestId("fiber-wallet-lock")).toBeEnabled();
    await expect.poll(leaveAsks).toBe(false);
  });

  test("one node at a time: with the popup running it, the node page in another tab says so and does not start it", async ({
    page,
    context,
    hub: _hub,
    dip,
  }) => {
    test.skip(!dip, NO_DIP_REASON);
    test.setTimeout(TEST_TIMEOUT_MS);
    await installFakeNode(context);
    const wallet = await openWalletPopup(page, "/app");
    await createWalletNode(wallet.ui);
    const second = await context.newPage();
    await second.goto("/app/fiber");
    await expect(second.getByTestId("fiber-node-other-tab")).toHaveText("This node runs in another tab or window. Use that one, or close it and unlock here.", {
      timeout: WALLET_TIMEOUT_MS,
    });
    await second.getByLabel("Password", { exact: true }).fill(WALLET_PASSWORD);
    await second.getByRole("button", { name: "Unlock and start node" }).click();
    await expect(second.getByTestId("fiber-node-other-tab")).toBeVisible({ timeout: WALLET_TIMEOUT_MS });
    expect(await nodeCalls(second, "node_info")).toEqual([]);
    await expect(page.getByTestId("fiber-wallet-button")).toHaveText("0 CKB");
    await second.close();
  });

  test("the node keeps running through the guide's, How it works' and the landing page's links to the app and the guide", async ({
    page,
    context,
    hub: _hub,
    dip,
  }) => {
    test.skip(!dip, NO_DIP_REASON);
    test.setTimeout(TEST_TIMEOUT_MS);
    await installFakeNode(context);
    const wallet = await openWalletPopup(page, "/app/guide");
    await createWalletNode(wallet.ui);
    await wallet.scope.evaluate(() => {
      (window as unknown as { __walletMark: string }).__walletMark = "still here";
    });
    await page.getByTestId("fiber-wallet-close").click();

    // The guide's step link to the app.
    await followLink(page, page.getByTestId("testnet-guide-steps").getByRole("link", { name: /^Open the app/ }).first(), /\/app$/);
    // How it works on the live card, then its link to the guide.
    await page.getByTestId("how-it-works").click();
    await followLink(page, page.getByTestId("how-it-works-guide-link"), /\/app\/guide$/);
    // The footer's link home, then the landing page's call to try the demo.
    await followLink(page, page.locator("footer").getByRole("link", { name: /CKBolt/ }).first(), /\/$/);
    await followLink(page, page.getByRole("link", { name: "Try the demo" }).first(), /\/app$/);

    const frame = await walletFrame(page);
    expect(await frame.evaluate(() => (window as unknown as { __walletMark?: string }).__walletMark)).toBe("still here");
    expect(await nodeCalls(frame, "node_info")).toHaveLength(1);
    await expect(page.getByTestId("fiber-wallet-button")).toHaveText("0 CKB");
  });
});
