/**
 * Copy of the swap card's Fiber node, short enough for the swap card's primary button (docs/live-swap-ui.md: at most 12 words per
 * sentence on screen). Explanations go behind an InfoTip, not here.
 */

/** Why the browser node cannot act now. Each one is also the label of the swap card's primary button. */
export const FIBER_WALLET_PROBLEM = {
  /** No status answer has come back yet. */
  LOOKING: "Looking for your Fiber node…",
  /** No node answered: neither the header's Fiber node nor a node page runs it. */
  NOT_OPEN: "Open your Fiber node",
  LOCKED: "Unlock your Fiber node",
  STARTING: "Your Fiber node is starting…",
  /** The tab that answered waits while another tab runs the node. */
  OTHER_TAB: "Use the tab that runs your node",
  FAILED: "Check your Fiber node",
  /** The browser node runs on CKB testnet only (fiber-js), so a hub on another network cannot pay it. */
  WRONG_NETWORK: (hubNetwork: string) => `Hub is on CKB ${hubNetwork}: use your own node`,
  HUB_NOT_CONNECTED: "Connect your node to the hub",
  /** Running and connected, but no ready channel in any asset. */
  NO_CHANNEL: "Ask the hub for a channel",
} as const;

/** Errors of the Fiber node's actions: what is wrong, then what to do. */
export const FIBER_WALLET_MESSAGE = {
  NOT_CHOSEN: "Choose a Fiber node first.",
  INVOICE_UNREADABLE: "Your Fiber node made an invoice CKBolt cannot read. Try again.",
  INVOICE_WRONG_NETWORK: (invoiceNetwork: string, hubNetwork: string) =>
    `Your Fiber node made a CKB ${invoiceNetwork} invoice. The hub needs CKB ${hubNetwork}.`,
  INVOICE_NO_AMOUNT: "Your Fiber node made an invoice without an amount. Try again.",
  INVOICE_WRONG_AMOUNT: "Your Fiber node made an invoice for another amount. Try again.",
} as const;
