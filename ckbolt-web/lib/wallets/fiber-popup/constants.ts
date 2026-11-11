/**
 * The Fiber node popup (docs/fiber-wallet-popup.md): the browser node runs in an iframe of /app/wallet, mounted once
 * by the root layout the first time the visitor opens the wallet from the header, and shown in a popover.
 */

/**
 * The wallet's own route: Document-Isolation-Policy and same-origin framing only (next.config.mjs, which repeats this
 * path; tests/unit/fiber-wallet-popup.spec.ts checks they agree).
 */
export const FIBER_WALLET_PATH = "/app/wallet";

/**
 * Browsers without Document-Isolation-Policy (Firefox, Safari) cannot isolate the iframe, so the wallet opens in a window
 * instead: the node page (/app/fiber, isolated with COOP/COEP) in the wallet's layout.
 */
export const FIBER_WALLET_WINDOW = {
  /** Query parameter and value of the node page that render the wallet layout: /app/fiber?view=wallet. */
  PARAM: "view",
  VALUE: "wallet",
  /** window.open target, so the same window is reused where the browser can. */
  NAME: "ckbolt-fiber-wallet",
  WIDTH_PX: 420,
  HEIGHT_PX: 720,
} as const;

/** postMessage between the page and the wallet's iframe. Same origin only; it never carries keys, passwords or secrets. */
export const WALLET_RELAY = {
  /** Every message carries it, so other messages on the window are ignored. */
  SOURCE: "ckbolt:fiber-wallet",
  VERSION: 1,
  KIND: {
    /** iframe → page: what the header button shows. */
    STATUS: "status",
    /** iframe → page: Escape was pressed inside the wallet. */
    CLOSE: "close",
    /** page → iframe: move focus to the wallet's first or last control (the popover's focus trap). */
    FOCUS: "focus",
    /** page → iframe: the popover was shown or hidden (a hidden wallet clears the passwords typed in it). */
    VISIBILITY: "visibility",
    /** page → iframe: open one of the popup's pages (the swap card's "Ask the hub for a channel" opens Channels). */
    NAVIGATE: "navigate",
    /** page → iframe: open one entry of History (the app's "View in History" after a swap, a payment or a request). */
    OPEN_ENTRY: "open-entry",
  },
} as const;

/**
 * The popup's pages: Home, the pages its buttons open, History (everything that moved money through the node), and
 * Confirm, where the visitor confirms what Pay on /app asked the node for (it opens by itself when a request comes; the
 * page opens it with `navigate` too).
 */
export const WALLET_PAGES = ["home", "add-funds", "channels", "withdraw", "settings", "history", "confirm"] as const;
export type WalletPage = (typeof WALLET_PAGES)[number];

/** How the page tells a wallet that stopped answering. */
export const WALLET_RELAY_TIMING = {
  /** The wallet posts its status again this often, even unchanged, so the page knows it is alive. */
  REPOST_MS: 10_000,
  /** A status older than this is stale: the wallet stopped answering. */
  STALE_MS: 30_000,
  /** The wallet's first status must arrive this soon after the iframe is created. */
  LOAD_TIMEOUT_MS: 15_000,
  /** The page looks at the age of the last status this often. */
  TICK_MS: 2_000,
} as const;

/** Decimals the header button shows of the CKB the node can send. */
export const WALLET_BUTTON_FRACTION_DIGITS = 2;
