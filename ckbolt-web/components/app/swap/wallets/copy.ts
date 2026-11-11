import { hubNetworkLabel } from "@/lib/wallets/lightning/network";
import type { NodeFixPage } from "@/lib/wallets/fiber-wallet/node-page";

/**
 * Copy of the Fiber node's chip and dialog (docs/style-guide.md, Copy). Terse on screen; explanations sit in InfoTips.
 * The Lightning side has no wallet to connect: the visitor pays or gets paid by QR code or pasted invoice.
 */

export const WALLET_TITLE = "Fiber node";

/** What the Fiber node moves, under the dialog title: the hub's assets ("CKB, RUSD, and cWBTC"), or "CKB tokens". */
export const WALLET_ASSETS = (assets: string) => `${assets} on CKB L2`;

/** The chip's text before a node is chosen: it names the network the Fiber side needs. */
export const WALLET_CONNECT_CHIP = "Connect Fiber";

export const WALLET_ACTION = {
  CONNECT: "Connect",
  DISCONNECT: "Disconnect",
  CHECK_AGAIN: "Check again",
  OPEN_NODE: "Open Fiber node",
  /** Said to screen readers after a link that opens a new tab. */
  NEW_TAB: "(opens in a new tab)",
} as const;

/**
 * Friendly names of the test networks CKBolt's hubs run on, after the hub's own name ("Bitcoin signet (Mutinynet)").
 * CKBolt's testnet hub runs Lightning on Mutinynet, a public signet.
 */
export const LIGHTNING_NETWORK_NICKNAME: Readonly<Record<string, string>> = { signet: "Mutinynet" };

/** The hub's Lightning network for a sentence: "Bitcoin signet (Mutinynet)", or "a Bitcoin test network" when unknown. */
export function hubLightningNetworkName(network: string | null | undefined): string {
  const nickname = network ? LIGHTNING_NETWORK_NICKNAME[network.trim().toLowerCase()] : undefined;
  const label = hubNetworkLabel(network);
  return nickname ? `${label} (${nickname})` : label;
}

export const FIBER_COPY = {
  CHOICE_LABEL: "Which Fiber node",
  BROWSER_NODE_LINE: "Runs in this browser, at the top of the page. Makes and pays invoices for you.",
  OWN_NODE_TOOLS: "Fiber Studio, fnn",
  OWN_NODE_LINE: "Your node elsewhere: you paste invoices and pay by hand.",
  OWN_NODE_TIP_LABEL: "How an external node works",
  OWN_NODE_TIP: [
    "CKBolt cannot reach your node, so two steps are yours. The card gives the fnn command for each.",
    "BTC to CKB: make a sha256 invoice for the exact amount, then paste it.",
    "CKB to BTC: pay the hub's hold invoice from your node.",
    "Your node needs a channel that reaches the hub: the guide's hub card connects it and asks the hub for one.",
  ],
  GET_FIBER_STUDIO: "Get Fiber Studio",
  STATUS_NODE: "Node",
  STATUS_HUB: "Hub",
  ADD_FUNDS: "Add funds",
  ADD_FUNDS_TIP_LABEL: "How to add funds",
  ADD_FUNDS_TIP: "Opens Add funds in the Fiber node at the top of the page. Your CKB wallet (JoyID and others) signs once, on CKB L1.",
  OPEN_NODE_TIP_LABEL: "About the browser node",
  OPEN_NODE_TIP:
    "Your Fiber node runs at the top of the page. Create or unlock it there, add funds from your CKB wallet, and ask the hub for a channel. Keep this page open while you swap.",
  /** The button that opens the Fiber node's page fixing the node's problem (lib/wallets/fiber-wallet/node-page.ts). */
  OPEN_PAGE: { home: "Open Fiber node", channels: "Open Channels", "add-funds": "Add funds" } satisfies Record<NodeFixPage, string>,
} as const;

/** What the status dot means, for screen readers. */
export const WALLET_TONE_LABEL = {
  ok: "ready",
  wait: "connecting",
  /** A step is the visitor's to take: open or unlock the node, connect it, a channel for this swap. */
  attention: "needs attention",
  /** It cannot be used here: a failed node, a hub on another network. */
  problem: "not usable",
} as const;
