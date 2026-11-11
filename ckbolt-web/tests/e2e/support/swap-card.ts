import { expect, type Locator, type Page } from "@playwright/test";
import type { FiberWalletKind } from "../../../components/app/swap/contracts";
import type { Direction } from "../../../lib/hub/contract";

/*
 * The live swap card (components/app/swap, docs/live-swap-ui.md) as the specs drive it: its parts by test id, the user's
 * actions (type, paste an invoice, choose the Fiber node, pick a token, swap) and two checks of the spec's word budget
 * and screen width. The card's one wallet is the Fiber node; the Lightning side is a QR code or a pasted invoice.
 */

/** The page may need this long on a cold dev server: it compiles /app on first load. */
export const CARD_TIMEOUT_MS = 30_000;
/** A swap step follows the hub's state, which the page reads every 2 s; allow a few reads. */
export const STEP_TIMEOUT_MS = 10_000;

export type StepStatus = "pending" | "active" | "done" | "failed";

export class SwapCard {
  readonly card: Locator;
  readonly amount: Locator;
  readonly receiveAmount: Locator;
  readonly primary: Locator;
  readonly error: Locator;
  readonly payBox: Locator;
  readonly receiveBox: Locator;
  readonly flipButton: Locator;
  readonly details: Locator;
  readonly timer: Locator;
  readonly ownInvoice: Locator;
  /** CKB or RUSD to BTC: the visitor's own Lightning invoice. */
  readonly lnInvoice: Locator;
  readonly banner: Locator;
  readonly progress: Locator;
  readonly result: Locator;
  readonly manualInvoice: Locator;
  /** BTC to CKB or RUSD: the hub's Lightning hold invoice to pay, under the run's steps. */
  readonly holdInvoice: Locator;

  constructor(readonly page: Page) {
    const id = (testId: string) => page.getByTestId(testId);
    this.card = id("swap-card");
    this.amount = id("swap-amount");
    this.receiveAmount = id("swap-receive-amount");
    this.primary = id("swap-primary");
    this.error = id("swap-error");
    this.payBox = id("swap-pay-box");
    this.receiveBox = id("swap-receive-box");
    this.flipButton = id("swap-flip");
    this.details = id("swap-details");
    this.timer = id("swap-quote-timer");
    this.ownInvoice = id("swap-own-invoice");
    this.lnInvoice = id("swap-ln-invoice");
    this.banner = id("swap-banner");
    this.progress = id("swap-progress");
    this.result = id("swap-result");
    this.manualInvoice = id("swap-manual-invoice");
    this.holdInvoice = id("swap-hold-invoice");
  }

  /** The Fiber node's chip: the card's one wallet. */
  walletButton(): Locator {
    return this.page.getByTestId("wallet-button-fiber");
  }

  walletDialog(): Locator {
    return this.page.getByTestId("wallet-dialog-fiber");
  }

  step(n: number): Locator {
    return this.page.getByTestId(`swap-step-${n}`);
  }

  /** Opens /app against the faked hub and waits until the live card is on screen with its first state. */
  async open(path = "/app") {
    await this.page.goto(path);
    await expect(this.card).toBeVisible({ timeout: CARD_TIMEOUT_MS });
    await expect(this.primary).toBeVisible({ timeout: CARD_TIMEOUT_MS });
  }

  async type(amount: string) {
    await this.amount.fill(amount);
  }

  async expectPrimary(label: string, opts: { enabled: boolean }) {
    await expect(this.primary).toHaveText(label, { timeout: STEP_TIMEOUT_MS });
    if (opts.enabled) await expect(this.primary).toBeEnabled();
    else await expect(this.primary).toBeDisabled();
  }

  /** Switches the direction and waits until the Fiber node's chip sits in the box of the Fiber side. */
  async flipTo(direction: Direction) {
    await this.flipButton.click();
    const fiberBox = direction === "fiber_to_ln" ? this.payBox : this.receiveBox;
    await expect(fiberBox.getByTestId("wallet-button-fiber")).toBeVisible();
  }

  /** CKB or RUSD to BTC: pastes the visitor's own Lightning invoice. */
  async pasteInvoice(invoice: string) {
    await this.lnInvoice.fill(invoice);
  }

  /** Chooses which Fiber node the card uses, then closes its dialog. */
  async chooseFiber(kind: FiberWalletKind) {
    const dialog = await this.openWalletDialog();
    await dialog.getByTestId(`fiber-option-${kind}`).click();
    await expect(dialog.getByTestId(`fiber-option-${kind}`)).toHaveAttribute("aria-checked", "true");
    await this.closeDialog(dialog);
  }

  async openWalletDialog(): Promise<Locator> {
    await this.walletButton().click();
    const dialog = this.walletDialog();
    await expect(dialog).toBeVisible();
    return dialog;
  }

  async closeDialog(dialog: Locator) {
    await this.page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  }

  /** Picks the Fiber asset on the side that holds the picker ("pay" when a Fiber asset is paid). */
  async pickToken(side: "pay" | "receive", symbol: string) {
    await this.page.getByTestId(`swap-token-${side}`).click();
    const list = this.page.getByTestId("swap-token-list");
    await list.getByRole("button", { name: new RegExp(`^${symbol}\\b`) }).click();
    await expect(list).toHaveCount(0);
    await expect(this.page.getByTestId(`swap-token-${side}`)).toContainText(symbol);
  }

  /** Presses Swap (it must be ready) and waits for the progress dialog. */
  async swap() {
    await this.expectPrimary("Swap", { enabled: true });
    await this.primary.click();
    await expect(this.progress).toBeVisible();
  }

  async expectStep(n: number, status: StepStatus, line?: string | RegExp) {
    const step = this.step(n);
    await expect(step).toHaveAttribute("data-status", status, { timeout: STEP_TIMEOUT_MS });
    if (line !== undefined) await expect(step).toContainText(line);
  }

  /** Opens the collapsed Details of the run's result. */
  async openResultDetails() {
    const toggle = this.result.getByRole("button", { name: "Details" });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
  }
}

/* -------------------------------------------------------------------------------------- the word budget */

/** Token symbols the word budget leaves out (docs/live-swap-ui.md, Goals: "numbers and token symbols excluded"). */
const TOKEN_SYMBOLS = new Set(["BTC", "CKB", "RUSD", "cWBTC"]);
const SENTENCE_END = /(?<=[.!?])\s+/;

/**
 * The text a sighted user sees inside `root`, one string per block: text that renders with a size, is not
 * visibility-hidden or transparent, and is not clipped to a screen-reader-only box. Inline pieces of one block join up.
 */
export function visibleBlocks(root: Locator): Promise<string[]> {
  return root.evaluate((el) => {
    const isClipped = (node: Element | null): boolean => {
      for (let p = node; p && p !== el.parentElement; p = p.parentElement) {
        const style = getComputedStyle(p);
        if (style.visibility !== "visible" || Number(style.opacity) === 0) return true;
        const box = p.getBoundingClientRect();
        if (style.overflow === "hidden" && (box.width <= 1 || box.height <= 1)) return true;
        if (style.clip === "rect(0px, 0px, 0px, 0px)" || style.clipPath === "inset(50%)") return true;
      }
      return false;
    };
    const blockOf = (node: Element): Element => {
      for (let p: Element | null = node; p && p !== el; p = p.parentElement) {
        if (!getComputedStyle(p).display.startsWith("inline")) return p;
      }
      return el;
    };
    const blocks = new Map<Element, string>();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.textContent ?? "";
      const parent = n.parentElement;
      if (!text.trim() || !parent || isClipped(parent)) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      if (![...range.getClientRects()].some((r) => r.width > 0 && r.height > 0)) continue;
      const block = blockOf(parent);
      blocks.set(block, `${blocks.get(block) ?? ""} ${text}`);
    }
    return [...blocks.values()].map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean);
  });
}

const isWord = (token: string): boolean => {
  const bare = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  // Numbers ("2,000", "54.56M", "24s", "1%") and token symbols are not words of the budget.
  return /\p{L}/u.test(bare) && !/^\p{N}/u.test(bare) && !TOKEN_SYMBOLS.has(bare);
};

/** The words of the budget that `root` shows. */
export async function visibleWords(root: Locator): Promise<string[]> {
  return (await visibleBlocks(root)).flatMap((block) => block.split(/\s+/)).filter(isWord);
}

/** Every sentence `root` shows, with its number of words. */
export async function visibleSentences(root: Locator): Promise<{ text: string; words: number }[]> {
  return (await visibleBlocks(root))
    .flatMap((block) => block.split(SENTENCE_END))
    .map((text) => ({ text, words: text.split(/\s+/).filter(isWord).length }));
}

/* --------------------------------------------------------------------------------------- screen width */

/** How far past the edge an element may reach (sub-pixel rounding). */
const EDGE_TOLERANCE_PX = 1;
const MAX_LISTED = 10;

/**
 * `root` (the card, or a dialog, which sits outside <main>) fits the viewport's width: the root itself and every leaf
 * with text lie inside it, nothing inside scrolls sideways (a dialog scrolls up and down only), and neither does the page.
 */
export async function expectInsideViewport(root: Locator) {
  const found = await root.evaluate(
    (el, { tolerance, max }) => {
      const vw = document.documentElement.clientWidth;
      const out: string[] = [];
      const name = (node: Element) => `${node.tagName} "${(node.textContent ?? "").trim().slice(0, 40)}"`;
      for (const node of [el, ...el.querySelectorAll("*")]) {
        const r = node.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const overflowX = getComputedStyle(node).overflowX;
        if ((overflowX === "auto" || overflowX === "scroll") && node.scrollWidth > node.clientWidth + tolerance) out.push(`${name(node)} scrolls sideways`);
        const leaf = node === el || node.children.length === 0;
        if (leaf && (node.textContent ?? "").trim() && (r.right > vw + tolerance || r.left < -tolerance)) out.push(`${name(node)} is off screen`);
      }
      return { out: out.slice(0, max), pageScrolls: document.documentElement.scrollWidth > vw + tolerance };
    },
    { tolerance: EDGE_TOLERANCE_PX, max: MAX_LISTED },
  );
  expect(found.out).toEqual([]);
  expect(found.pageScrolls, "the page scrolls sideways").toBe(false);
}
