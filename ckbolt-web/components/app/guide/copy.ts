import { cwbtcFaucetUrl, FAUCET_LINK_LABEL } from "@/lib/faucets";
import { LIGHTNING_CHANNEL_TITLE } from "@/lib/swap/copy";
import { APP_PAGE_PATH, CKB_TESTNET_FAUCET_URL } from "@/lib/wallets/fiber-browser/constants";
import {
  ALBY_HUB_DOCKER_RUN,
  ALBY_HUB_LOCAL_URL,
  FAUCET_CHANNEL,
  GUIDE_HUB_HREF,
  MEGALITH_PEER_URI,
  MUTINYNET_FAUCET_URL,
  NODE_FUNDING_CKB,
  SWAP_LIMITS_SATS,
  TOKEN_CHANNEL_CKB,
} from "./constants";

/**
 * The testnet guide (/app/guide, phase-3c plan F1.1 and F10.1): what a tester needs, then every step from an empty
 * browser to a swap both ways, in short lines. Scannable on purpose: one action per line, no paragraph.
 */

export const GUIDE_INTRO = {
  eyebrow: "Testnet guide",
  heading: "Try a live swap.",
  lead: "What you need, and every step to a swap both ways.",
} as const;

export const GUIDE_TITLE = {
  NEEDS: "What you need",
  STEPS: "Step by step",
  LIMITS: "Limits",
  HELP: "Something wrong?",
} as const;

export const GUIDE_NEEDS: readonly string[] = [
  "Desktop Chrome or Edge: the Fiber node runs in them. Others open it in a window.",
  "JoyID on CKB testnet, to fund the node. It uses a passkey; nothing to install.",
  "A Lightning wallet on Mutinynet. This guide uses Alby Hub, which runs in Docker.",
];

export const GUIDE_LIMITS: readonly string[] = [
  `${SWAP_LIMITS_SATS.min} to ${SWAP_LIMITS_SATS.max} sats per swap.`,
  "Test networks only: nothing here has value. Mainnet invoices are refused.",
  "The browser node is experimental. Keep the page open while you swap.",
];

export const GUIDE_HELP_LINE = "Report it with the swap id from the swap's Details.";

/** A command or address to copy, in a scrollable block: `label` names the block, `copy` is its button. */
export interface GuideCode {
  label: string;
  copy: string;
  text: string;
}

export interface GuideLink {
  label: string;
  href: string;
  /** Another site: opens in a new tab. */
  external?: boolean;
}

export interface GuideStep {
  title: string;
  /** One action per line. */
  lines: readonly string[];
  /** Shown after the first line. */
  code?: GuideCode;
  links?: readonly GuideLink[];
}

export const GUIDE_STEPS: readonly GuideStep[] = [
  {
    title: "Run a Lightning wallet on Mutinynet",
    lines: ["Start Alby Hub in Docker:", `Open ${ALBY_HUB_LOCAL_URL}, set a password and skip the Alby account.`],
    code: { label: "Docker command for Alby Hub on Mutinynet", copy: "Copy command", text: ALBY_HUB_DOCKER_RUN },
  },
  {
    title: "Get test sats",
    lines: [
      "In Alby Hub: Node, Advanced, Connect Peer. Add Megalith:",
      "Copy your node's pubkey from the same page.",
      `At the Mutinynet faucet, open a channel to it: ${FAUCET_CHANNEL.capacitySats} sats, push ${FAUCET_CHANNEL.pushPercent}.`,
      "It is ready in about 3 minutes.",
    ],
    code: { label: "Megalith's address", copy: "Copy address", text: MEGALITH_PEER_URI },
    links: [{ label: "Mutinynet faucet", href: MUTINYNET_FAUCET_URL, external: true }],
  },
  {
    title: LIGHTNING_CHANNEL_TITLE,
    lines: [
      "Alby Hub can pay the hub only over a channel of its own.",
      "Copy the hub's Lightning address from the hub card above.",
      "In Alby Hub, Connect Peer with it, and copy your node's pubkey.",
      "On the hub card, paste it and press Get a channel. Ready in about 3 minutes.",
    ],
    links: [{ label: "The hub card", href: GUIDE_HUB_HREF }],
  },
  {
    title: "Create your browser Fiber node",
    lines: ["At the top right, open Fiber node.", "Create node and choose a password.", "Back up the key: Settings, Download encrypted backup."],
  },
  {
    title: "Fund it with testnet CKB",
    lines: [
      "Claim testnet CKB to your JoyID testnet address at the Nervos faucet.",
      `In the node's Add funds, Fund from a wallet with about ${NODE_FUNDING_CKB} CKB. JoyID signs once.`,
      "Test cWBTC on chain, if you want some: claim it to the node's address.",
    ],
    links: [
      { label: "Nervos faucet", href: CKB_TESTNET_FAUCET_URL, external: true },
      { label: FAUCET_LINK_LABEL("cWBTC"), href: cwbtcFaucetUrl(), external: true },
    ],
  },
  {
    title: "Open a channel with the hub",
    lines: [
      "In the node's Channels, tick CKB and any tokens such as cWBTC, then Open.",
      `Each token is its own channel and needs about ${TOKEN_CHANNEL_CKB} CKB more on chain.`,
      "It is ready after a few CKB confirmations.",
    ],
  },
  {
    title: "Swap both ways",
    lines: [
      "In the app: Connect Fiber, then CKBolt node.",
      "BTC to CKB: type the sats, press Swap, pay the invoice from Alby Hub.",
      "CKB to BTC: flip with ⇅, paste an invoice from Alby Hub, press Swap.",
      "Keep the page open until the swap completes.",
    ],
    links: [{ label: "Open the app", href: APP_PAGE_PATH }],
  },
  {
    title: "Take your CKB back",
    lines: [
      "Before you clear browser data, close the hub's channel in the node's Channels.",
      "On Close, choose My wallet to send the node's share straight to your address.",
      "Or let it return to the node, then Withdraw with the node's password.",
      "Withdraw sends all the node's on-chain CKB to your address, minus a small fee.",
      "Clearing browser data deletes the node's keys: keep the backup.",
    ],
  },
];

/** The link other parts of the app use to reach the guide's hub card. */
export const HUB_DETAILS_LINK = "Hub connection details";

/** "Get a Lightning channel from the hub" on the hub card (hub-channel.tsx): the node id, the request, the reason behind a "?". */
export const HUB_CHANNEL_COPY = {
  TITLE: LIGHTNING_CHANNEL_TITLE,
  TIP_LABEL: "Why a channel from the hub",
  TIP: "Wallets such as Alby Hub (LDK) on Mutinynet can pay the hub only over a direct channel. Add the hub as a peer in your wallet, then paste your wallet's node id here. The hub opens a private channel to it, with sats on your side to pay with.",
  NODE_ID_LABEL: "Your Lightning node id",
  NODE_ID_PLACEHOLDER: "02… or 03…",
  REQUEST: "Get a channel",
  REQUESTING: "Asking the hub…",
  OPENING: "Opening: ready after a few confirmations.",
  READY: (sats: string) => `Ready: you can pay ${sats} sats.`,
  CLOSING: "Closing.",
  ERROR_LABEL: "About this error",
} as const;

/**
 * An external node (Fiber Studio, fnn) on the hub card's Fiber side (fiber-channel.tsx): connect it to the hub, let it
 * accept a token, ask the hub for a channel. Short lines; the why behind a "?".
 */
export const FIBER_CHANNEL_COPY = {
  CONNECT_LABEL: "Connect your fnn to the hub",
  CONNECT_TIP: (rpc: string) =>
    `Runs connect_peer on your fnn (RPC at ${rpc}). In Fiber Studio, add this address as a peer. The hub opens channels only to nodes connected to it.`,
  TITLE: "Get a Fiber channel from the hub",
  TIP_LABEL: "Why a Fiber channel from the hub",
  TIP: "Your own Fiber node receives swaps over a channel the hub opens to it, with the hub's tokens on the hub's side. Connect your node first, then paste its node id and pick a token. Your node accepts the channel by itself: CKB as fnn does by default, a token once its config lists it.",
  NODE_ID_LABEL: "Your Fiber node id",
  NODE_ID_PLACEHOLDER: "02… or 03…",
  TOKEN_LABEL: "Token",
  TOKEN_OPTION: (symbol: string, amount: string) => `${symbol} · the hub puts in ${amount}`,
  WHITELIST_LABEL: (symbol: string) => `Let your node accept ${symbol}`,
  WHITELIST_TIP: "Add this entry under ckb.udt_whitelist in your fnn config, then restart fnn. It then accepts the hub's channel in this token by itself.",
  COPY_WHITELIST: "Copy entry",
  REQUEST: "Get a channel",
  REQUESTING: "Asking the hub…",
  OPENING: "Opening: ready after a few confirmations.",
  READY: (amount: string) => `Ready: you can receive ${amount}.`,
  CLOSING: "Closing.",
  ERROR_LABEL: "About this error",
} as const;

/**
 * The "CKBolt hub" card at the top of the guide (hub-card.tsx): the testnet hub's addresses, read live from its API, so
 * a tester can connect a wallet or an own node to it. Short lines; the rest behind "?".
 */
export const HUB_CARD_COPY = {
  TITLE: "CKBolt hub",
  STEP: "00",
  STATUS: { off: "Unavailable", checking: "Checking…", live: "Live", degraded: "Degraded", offline: "Unavailable" },
  PAUSED: "Swaps are paused for maintenance.",
  CHECKING: "Asking the hub…",
  OFFLINE: "The hub cannot be reached right now. Try again later.",
  DEGRADED: "Reachable, but not taking swaps right now.",
  DEGRADED_TIP_LABEL: "Why the hub is not taking swaps",
  LIGHTNING: "Lightning",
  FIBER: "Fiber",
  LOADING: "…",
  UNREADABLE: "Not available from this hub right now.",
  ERROR_TIP_LABEL: "About this error",
  ADD_PEER: "Add it as a peer in your Lightning wallet (Alby Hub: Node → Advanced → Connect Peer).",
  NO_URIS: "The hub lists no public address.",
  COPY_ADDRESS: "Copy address",
  CHANNELS: "Channels from the hub",
  LIGHTNING_CHANNEL: (capacity: string, push: string) => `${capacity} sats, ${push} on your side`,
  FIBER_CHANNEL: (amounts: string) => `Inbound ${amounts}`,
  NOT_OFFERED: "Not offered",
  NODE_ID: "Node id",
  COPY_NODE_ID: "Copy node id",
  P2P: "Address for Fiber Studio or fnn",
  NO_P2P: "The hub lists no TCP address.",
  WS_TIP_LABEL: "About the hub's WebSocket addresses",
  WS_TIP: "The browser node on this site dials these WebSocket addresses itself:",
  WS_NONE: "The hub lists no WebSocket address.",
  NETWORK: "Network",
  LIMITS: "Per swap",
  NO_LIMITS: "Shown once the hub serves swaps.",
} as const;
