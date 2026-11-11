import { randomBytes } from "node:crypto";
import { ccc } from "@ckb-ccc/core";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { expect, type Browser, type BrowserContext, type FrameLocator, type Page } from "@playwright/test";
import type { Script } from "../../../lib/hub/contract";
import { decodeFiberInvoice, demoFiberInvoice, type FiberNetwork } from "../../../lib/payment-request";
import { BROWSER_NODE_NETWORK, STORAGE_NAME } from "../../../lib/wallets/fiber-browser/constants";
import { storageKey } from "../../../lib/wallets/fiber-browser/storage";
import { FIBER_WALLET_PATH, type WalletPage } from "../../../lib/wallets/fiber-popup/constants";
import type { NodeScope } from "./fiber-node";

/*
 * The Fiber node popup (docs/fiber-wallet-popup.md) as the specs drive it. Where the browser has
 * Document-Isolation-Policy (real Chrome or Edge: PW_CHANNEL=chrome) it is the header's popover, an iframe of
 * /app/wallet; Playwright's bundled Chromium has none, so there the same popup runs as the window the popover offers
 * instead (/app/fiber?view=wallet, isolated with COOP/COEP). The fake fiber-js is ./fiber-node.ts's, in every frame.
 */

export const WALLET_PASSWORD = "testnet node pass";
/** Creating keys (scrypt), starting the fake node and reaching the hub, on a cold server. */
export const WALLET_TIMEOUT_MS = 30_000;
/** The node reads its channels, invoices and payments every 5 s. */
export const NODE_POLL_TIMEOUT_MS = 15_000;
/** The wallet in a window of its own, for browsers without Document-Isolation-Policy. */
export const WALLET_WINDOW_PATH = "/app/fiber?view=wallet";

const FRAME_SELECTOR = '[data-testid="fiber-wallet-frame"]';

/* ------------------------------------------------------------------------------------------ DIP support */

const dipByBrowser = new WeakMap<Browser, Promise<boolean>>();
/** A light page of the site that may frame the wallet. */
const DIP_PROBE_PAGE = "/app/guide";
/** One try of the probe's page, then of its iframe: a few seconds while a project's browsers all start at once. */
const DIP_PROBE_STEP_MS = 15_000;
/**
 * The `dip` fixture's own budget, apart from the test's: the probe runs in a worker's first test, as its browser starts
 * with the others, and may try twice.
 */
export const DIP_PROBE_TIMEOUT_MS = 60_000;

/**
 * True when this browser isolates a document with Document-Isolation-Policy alone (Chrome and Edge 137+). Measured
 * once per browser on an iframe of /app/wallet, which sends only that header (opened on its own it goes to the window).
 * A fresh browser once got no answer at all to the probe's page (25 s, while the server answered the other workers'
 * pages at once), so a try that gets none within DIP_PROBE_STEP_MS is dropped with its context and made again; a probe
 * that fails is not remembered.
 */
export function browserHasDip(browser: Browser, baseURL: string): Promise<boolean> {
  let known = dipByBrowser.get(browser);
  if (!known) {
    known = (async () => {
      let isolated = false;
      await expect(async () => {
        isolated = await probeDip(browser, baseURL);
      }).toPass({ timeout: DIP_PROBE_TIMEOUT_MS });
      return isolated;
    })();
    dipByBrowser.set(browser, known);
    known.catch(() => dipByBrowser.delete(browser));
  }
  return known;
}

async function probeDip(browser: Browser, baseURL: string): Promise<boolean> {
  const context = await browser.newContext({ baseURL });
  try {
    const page = await context.newPage();
    await page.goto(DIP_PROBE_PAGE, { timeout: DIP_PROBE_STEP_MS });
    await page.evaluate(
      ({ src, ms }) =>
        new Promise<void>((resolve, reject) => {
          const frame = document.createElement("iframe");
          frame.src = src;
          frame.onload = () => resolve();
          document.body.append(frame);
          setTimeout(() => reject(new Error(`${src} did not load in ${ms} ms`)), ms);
        }),
      { src: FIBER_WALLET_PATH, ms: DIP_PROBE_STEP_MS },
    );
    const frame = page.frames().find((f) => f !== page.mainFrame() && new URL(f.url()).pathname === FIBER_WALLET_PATH);
    return frame ? await frame.evaluate(() => crossOriginIsolated) : false;
  } finally {
    await context.close();
  }
}

export const NO_DIP_REASON = "This browser has no Document-Isolation-Policy (Playwright's Chromium 140): run with PW_CHANNEL=chrome.";

/** Serves /app/wallet without Document-Isolation-Policy on this page, as Firefox or Safari would load it. */
export async function withoutWalletIsolation(page: Page) {
  await page.route(`**${FIBER_WALLET_PATH}`, async (route) => {
    const response = await route.fetch();
    const headers = { ...response.headers() };
    delete headers["document-isolation-policy"];
    await route.fulfill({ response, headers });
  });
}

/* --------------------------------------------------------------------------------------- the wallet */

/** The wallet under test: where to find its controls, and where its fake node runs. */
export interface Wallet {
  /** The popover's iframe, or the wallet window. */
  ui: FrameLocator | Page;
  scope: NodeScope;
  /** The wallet runs in the header's popover (an iframe of the page). */
  popup: boolean;
}

/** The wallet's iframe once the page created it. */
export async function walletFrame(page: Page): Promise<NodeScope> {
  const find = () => page.frames().find((f) => f !== page.mainFrame() && new URL(f.url()).pathname === FIBER_WALLET_PATH);
  await expect.poll(() => !!find(), { timeout: WALLET_TIMEOUT_MS }).toBe(true);
  return find()!;
}

/** Opens the header's wallet on `path` and waits until the wallet inside the popover has rendered. */
export async function openWalletPopup(page: Page, path = "/app"): Promise<Wallet> {
  if (path) await page.goto(path);
  await page.getByTestId("fiber-wallet-button").click();
  await expect(page.getByTestId("fiber-wallet-popover")).toBeVisible();
  const ui = page.frameLocator(FRAME_SELECTOR);
  await expect(ui.locator("[data-testid=fiber-wallet], [data-testid=fiber-wallet-fallback]")).toBeVisible({ timeout: WALLET_TIMEOUT_MS });
  return { ui, scope: await walletFrame(page), popup: true };
}

/** The wallet: the header's popover where the browser has DIP, else the window view on this page. */
export async function openWallet(page: Page, dip: boolean): Promise<Wallet> {
  if (dip) return openWalletPopup(page);
  await page.goto(WALLET_WINDOW_PATH);
  await expect(page.getByTestId("fiber-wallet")).toBeVisible({ timeout: WALLET_TIMEOUT_MS });
  return { ui: page, scope: page, popup: false };
}

/** Creates the node from Home (a fresh browser has no key) and waits until it runs and reaches the hub. */
export async function createWalletNode(ui: Wallet["ui"]) {
  const home = ui.getByTestId("fiber-wallet-home");
  await expect(home.getByTestId("fiber-node-create")).toBeVisible({ timeout: WALLET_TIMEOUT_MS });
  await home.getByLabel("Password, at least 8 characters").fill(WALLET_PASSWORD);
  await home.getByLabel("Repeat the password").fill(WALLET_PASSWORD);
  await home.getByRole("button", { name: "Create node" }).click();
  await expect(ui.getByTestId("fiber-wallet-balance")).toBeVisible({ timeout: WALLET_TIMEOUT_MS });
  await expect(ui.getByTestId("fiber-wallet-hub")).toContainText("Connected", { timeout: WALLET_TIMEOUT_MS });
}

export async function unlockWallet(ui: Wallet["ui"]) {
  const home = ui.getByTestId("fiber-wallet-home");
  await home.getByLabel("Password", { exact: true }).fill(WALLET_PASSWORD);
  await home.getByRole("button", { name: "Unlock and start node" }).click();
  await expect(ui.getByTestId("fiber-wallet-balance")).toBeVisible({ timeout: WALLET_TIMEOUT_MS });
}

/** The Web Lock the one document that runs the node holds (lib/wallets/fiber-browser/node-controller.ts, nodeLockName). */
const NODE_LOCK = storageKey(BROWSER_NODE_NETWORK, STORAGE_NAME.NODE_LOCK);

/**
 * Unlocks the node in a document that replaced the one that ran it (a reload). The old document holds the node's Web
 * Lock until the browser tears it down, which under load takes seconds; unlocked before then, the new node finds itself
 * "in another tab" and does not start. So this waits for that event first: navigator.locks.request resolves the moment
 * the lock is free (and lets it go at once), then the node is unlocked once.
 */
export async function unlockAfterReload(wallet: Pick<Wallet, "ui" | "scope">) {
  await wallet.scope.evaluate((name) => navigator.locks.request(name, () => undefined), NODE_LOCK);
  await unlockWallet(wallet.ui);
}

/** Opens a page from Home (going Back first from another page); Home itself is Back. */
export const openPage = async (ui: Wallet["ui"], page: WalletPage) => {
  const back = ui.getByTestId("fiber-wallet-back");
  if (await back.isVisible()) await back.click();
  if (page !== "home") await ui.getByTestId(`fiber-wallet-open-${page}`).click();
  await expect(ui.getByTestId(`fiber-wallet-page-${page}`)).toBeVisible();
};

/**
 * Answers the request the node puts up (Confirm or Decline) and makes sure the node's document got the click. The answer
 * comes right after the popover showed the node again, and with DIP the node is an iframe in a process of its own: under
 * a full parallel run Chrome once let such a click go nowhere (sent ~60 ms after the popover opened, before the iframe
 * had painted the request), and the request waited on, unanswered. So the click is sent again until a click on that
 * button reached the node's document. Only the delivery is retried: what the node does with it stays the test's to
 * check, and the node runs one answer per request anyway (a later click finds the request running or gone).
 */
export async function answerInNode(node: { ui: Wallet["ui"]; scope: NodeScope }, answer: "accept" | "decline"): Promise<void> {
  const testId = `fiber-wallet-confirm-${answer}`;
  const button = node.ui.getByTestId("fiber-wallet-confirm-request").getByTestId(testId);
  await expect(button).toBeEnabled({ timeout: WALLET_TIMEOUT_MS });
  // Clicks the node's document saw, by the data-testid they landed in (the listener is added once per document).
  const clicks = () =>
    node.scope.evaluate((id) => {
      const w = window as unknown as { __nodeClicks?: Record<string, number> };
      if (!w.__nodeClicks) {
        const seen: Record<string, number> = {};
        w.__nodeClicks = seen;
        document.addEventListener(
          "click",
          (e) => {
            const key = (e.target as Element | null)?.closest?.("[data-testid]")?.getAttribute("data-testid");
            if (key) seen[key] = (seen[key] ?? 0) + 1;
          },
          true,
        );
      }
      return w.__nodeClicks[id] ?? 0;
    }, testId);
  const before = await clicks();
  await expect(async () => {
    if ((await clicks()) > before) return;
    await button.click({ timeout: 5_000 });
    await expect.poll(clicks, { timeout: 2_000 }).toBeGreaterThan(before);
  }).toPass({ timeout: WALLET_TIMEOUT_MS });
}

/* ---------------------------------------------------------------------------- invoices the node reads */

export interface InvoiceFacts {
  amount: bigint;
  network?: FiberNetwork;
  udt?: Script | null;
  payee?: string;
  description?: string;
  /** null: it never expires. */
  expirySeconds?: number | null;
  createdAtMs?: number;
}

/** A molecule-encoded Script, as fnn writes a token into an invoice's `udt_script`. */
export const moleculeScriptHex = (script: Script): string => ccc.hexFrom(ccc.Script.from(script).toBytes());

const hexQ = (n: bigint | number) => `0x${BigInt(n).toString(16)}`;
const CURRENCY: Record<FiberNetwork, string> = { mainnet: "Fibb", testnet: "Fibt", devnet: "Fibd" };
/** A payee for invoices the test makes: some testnet node, never the node's own nor the hub's. */
export const PAYEE_NODE_ID = `03${"5a".repeat(32)}`;
const DEFAULT_EXPIRY_SECONDS = 3_600;

/**
 * The Fiber invoices a test pastes, and what parse_invoice says about each, as fnn 0.9.1 writes it: timestamp in ms,
 * attributes in snake_case, the token as a molecule Script, and one payment hash per invoice. The fake node asks for it
 * through an exposed function (support/fiber-node.ts, parse_invoice).
 */
export class InvoiceBook {
  private readonly facts = new Map<string, InvoiceFacts & { paymentHash: string }>();

  async install(context: BrowserContext) {
    await context.exposeFunction("__testParseFiberInvoice", (invoice: string) => this.read(invoice));
  }

  /** A new Fiber invoice (right prefix, amount and checksum) whose parse gives `facts`. */
  add(facts: InvoiceFacts): string {
    const invoice = demoFiberInvoice(facts.network ?? "testnet", facts.amount);
    this.facts.set(invoice, { ...facts, paymentHash: `0x${randomBytes(32).toString("hex")}` });
    return invoice;
  }

  /** The payment hash parse_invoice reads in `invoice`. */
  hashOf(invoice: string): string {
    const facts = this.facts.get(invoice);
    if (!facts) throw new Error("not an invoice of this book");
    return facts.paymentHash;
  }

  private read(invoice: string): unknown {
    const facts = this.facts.get(invoice.trim());
    if (!facts) return null;
    const { network } = decodeFiberInvoice(invoice.trim());
    const expiry = facts.expirySeconds === undefined ? DEFAULT_EXPIRY_SECONDS : facts.expirySeconds;
    const attrs: Record<string, unknown>[] = [
      { hash_algorithm: "sha256" },
      { payee_public_key: facts.payee ?? PAYEE_NODE_ID },
      ...(expiry === null ? [] : [{ expiry_time: hexQ(expiry) }]),
      ...(facts.description ? [{ description: facts.description }] : []),
      ...(facts.udt ? [{ udt_script: moleculeScriptHex(facts.udt) }] : []),
    ];
    return {
      currency: CURRENCY[network],
      amount: hexQ(facts.amount),
      signature: "00",
      data: { timestamp: hexQ(facts.createdAtMs ?? Date.now()), payment_hash: facts.paymentHash, attrs },
    };
  }
}

/** The CKB lock args of a secret key (blake160 of its compressed public key), as fnn and CCC derive them. */
const ckbLockArgs = (keyHex: string): string => ccc.hashCkb(secp256k1.getPublicKey(hexToBytes(keyHex), true)).slice(0, 42);

/** Lets the fake node's address be the real lock of its CKB key, so the page can sign a withdrawal for it. */
export async function exposeRealLockArgs(context: BrowserContext) {
  await context.exposeFunction("__testCkbLockArgs", ckbLockArgs);
}
