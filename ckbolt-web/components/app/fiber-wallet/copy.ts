import { FIBER_JS_VERSION } from "@/lib/wallets/fiber-browser/constants";
import type { WalletPage } from "@/lib/wallets/fiber-popup/constants";

/**
 * Copy of the Fiber node popup (docs/fiber-wallet-popup.md). Few words on screen; the rest behind "?" (style guide:
 * Copy). The forms it shares with the node page keep their own copy in ../fiber-node/copy.ts.
 */

/** The popup's pages, by their titles (WALLET_PAGES in lib/wallets/fiber-popup/constants.ts). */
export const WALLET_PAGE_TITLE: Readonly<Record<WalletPage, string>> = {
  home: "Home",
  "add-funds": "Add funds",
  channels: "Channels",
  withdraw: "Withdraw",
  settings: "Settings",
  history: "History",
  confirm: "Confirm",
};

/** Pages that need the running node; Home, Settings and History work while it is locked. */
export const PAGES_NEEDING_NODE: readonly WalletPage[] = ["add-funds", "channels", "withdraw", "confirm"];

/** Home's large buttons, two by two. */
export const HOME_ACTIONS: readonly WalletPage[] = ["add-funds", "channels", "withdraw", "settings"];

/** The popover around the node, and the node's own title bar in a window. */
export const WALLET_CHROME = {
  TITLE: "Fiber node",
  TAG: "Testnet",
  CLOSE: "Close the Fiber node",
  /** The title bar's move handle (from sm up): its name, and the hint its tooltip and description give. */
  MOVE: "Move the Fiber node popup",
  MOVE_HINT: "Drag it, or use the arrow keys. Double-click or press Home to put it back.",
  BACK: "Back",
  ACTIONS_LABEL: "Node pages",
  /** Said on a page that needs the running node while it does not run. */
  NEEDS_NODE: "Opens once your node runs.",
  LOADING: "Loading the node…",
  NOT_ANSWERING: "The node is not answering.",
  RELOAD: "Reload",
  /** The popup's route opened on its own goes to its window, which has the isolation headers of a window. */
  OPENING_WINDOW: "Opening the Fiber node…",
  /** The app's button that opens the popup on an entry of History. */
  VIEW_IN_HISTORY: "View in History",
} as const;

export const HOME_COPY = {
  LEAD: "A Fiber node in this browser.",
  TIP_LABEL: "About this node",
  TIP: `fiber-js ${FIBER_JS_VERSION} runs here on CKB testnet, and the app swaps through it. Its keys are made in this browser and stay here, encrypted with your password. It keeps running while you move around the site; a reload asks for the password again.`,
  READY: "Ready to swap",
  READY_TIP_LABEL: "About ready to swap",
  READY_TIP:
    "What a swap can move now over your node's channels with the hub: Send for CKB to BTC, Receive for BTC to CKB. Channels with other nodes do not count.",
  NO_CHANNELS: "No channel with the hub yet.",
  ON_CHAIN: "On-chain",
  HUB: "Hub",
  HUB_CONNECTED: "Connected",
  HUB_CONNECTING: "Connecting…",
  HUB_NOT_CONNECTED: "Not connected",
  HUB_UNAVAILABLE: "Unavailable",
  CONNECT: "Connect",
  HISTORY: "History",
  VIEW_ALL: "View all",
} as const;

export const ADD_FUNDS_COPY = {
  FUND: "Fund from a wallet",
} as const;

export const WITHDRAW_PAGE_COPY = {
  CHANNELS_NOTE: "Closing a channel returns its funds to the node.",
  CHANNELS: "Channels",
} as const;

export const HISTORY_PAGE_COPY = {
  LEAD: "Kept in this browser.",
  TIP_LABEL: "About History",
  EMPTY: "No swaps, payments or channels yet.",
} as const;

export const CHANNELS_COPY = {
  YOURS: "Your channels",
  REFRESH: "Refresh",
  HUB_WRONG_NETWORK: (hub: string, node: string) => `The hub runs on CKB ${hub}; this node on CKB ${node}.`,
  HUB_UNAVAILABLE: "The hub cannot be reached right now.",
  HUB_LOADING: "Asking the hub…",
  TRY_AGAIN: "Try again",
  /** Channels with other nodes, collapsed: swaps never use them. */
  ADVANCED: "Advanced",
} as const;

export const SETTINGS_COPY = {
  KEY: "Key",
  NODE: "Node",
  NODE_ID: "Node id",
  COPY_NODE_ID: "Copy node id",
  LOCK: "Lock",
  LOCK_BUSY: "Wait until the node's swaps finish.",
  LINKS: "More",
  FULL_PAGE: "Full page",
  FULL_PAGE_TIP_LABEL: "About the full page",
  FULL_PAGE_TIP: "The same node on its own page. Only one place runs it at a time: lock it here first.",
  GUIDE: "Testnet guide",
  LIMITS_LABEL: "Before you fund it",
  LIMITS_TIP_LABEL: "About the limits",
  LIMITS_TIP:
    "Testnet only, and experimental. The node runs while this page is open: a closed tab cannot receive a payout or finish a swap. Channels live in this browser, so close them before you clear site data. No watchtower watches a browser node, so close channels cooperatively from here.",
} as const;

/** Inside the popover of a browser without Document-Isolation-Policy: the node in a window instead. */
export const FALLBACK_COPY = {
  TITLE: "Open the node in a window",
  LEAD: "This browser cannot run the node in this popup.",
  TIP_LABEL: "Why a window",
  TIP: "The node needs shared memory, which this browser gives only to a page of its own. Chrome and Edge run it here; Firefox and Safari open it in a window. Keep that window open while you swap.",
  OPEN: "Open the node in a window",
  NEW_WINDOW: "(opens a new window)",
  RUNNING: "Your node window runs the node.",
  BLOCKED: "The browser blocked the window. Allow popups for this site, then try again.",
} as const;
