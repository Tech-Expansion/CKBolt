/**
 * Contracts between the parts of the live swap UI (docs/live-swap-ui.md). The swap card (components/app/swap/*.tsx)
 * uses the wallets part (components/app/swap/wallets/) only through these types and the names exported by
 * wallets/index.ts (FiberWalletProvider, useFiberWallet, useWalletDialogs, WalletButton), and the help part
 * (components/app/swap/help/) only through help/index.ts (HowItWorksButton). The page mounts the card as
 * `<FiberWalletProvider><SwapCard /></FiberWalletProvider>` under the page's HubStatusProvider (app-modes.tsx).
 * The card's only wallet is the Fiber node: the Lightning side is a QR code or a pasted invoice, from any wallet.
 */
import type { FiberAssetId } from "@/lib/hub/contract";
import type { NodeFunds } from "@/lib/wallets/fiber-wallet/node-page";

/** How the user's Fiber side is connected. */
export type FiberWalletKind =
  /** fiber-js running in the user's /app/fiber tab, driven over the same-origin bridge: fully automatic. */
  | "browser-node"
  /** Fiber Studio or the user's own fnn: the user pastes the payout invoice and pays the hold invoice by hand. */
  | "own-node";

/** What a Fiber node can move now over its ready channels, per asset, in base units (decimal strings). */
export type FiberLiquidity = Partial<Record<FiberAssetId, { send: string; receive: string }>>;

export interface FiberWalletState {
  kind: FiberWalletKind | null;
  /** Short name for the wallet button: "CKBolt node" (browser-node), "External node" (own-node); null when nothing is chosen. */
  label: string | null;
  /** The wallet can act now (browser node: its tab answers and runs a node connected to the hub). */
  ready: boolean;
  /** Per asset, for the browser node; null when unknown (own node, or no answer yet). */
  liquidity: FiberLiquidity | null;
  /** One short sentence saying why it is not ready, or null. */
  problem: string | null;
  /** The browser node's CKB on chain and what it puts into a channel from the hub; null when unknown or another kind. */
  funds: NodeFunds | null;
}

export interface FiberInvoiceRequest {
  asset: FiberAssetId;
  /** Exactly the quote's receive amount, base units. */
  amount: string;
  /** The invoice must stay payable past this ISO time. */
  quoteExpiresAt: string;
  /** The hub's CKB network from its health, or null. */
  network: string | null;
  /** The Get paid request it is for (its id), or null for a swap. */
  request?: string | null;
}

/** The user must act in their own node (own-node kind): the card shows the manual step instead. */
export class ManualFiberStep extends Error {
  constructor(message = "Do this step in your own Fiber node.") {
    super(message);
    this.name = "ManualFiberStep";
  }
}

export interface FiberWalletApi extends FiberWalletState {
  choose(kind: FiberWalletKind): void;
  disconnect(): void;
  /** ln_to_fiber payout invoice. Browser node: made and checked. Own node: rejects with ManualFiberStep. */
  makeInvoice(request: FiberInvoiceRequest): Promise<string>;
  /** fiber_to_ln: pay the hub's hold invoice. Browser node: sent. Own node: rejects with ManualFiberStep. */
  payInvoice(request: { swapId: string; invoice: string }): Promise<void>;
}

/** Props of the Fiber node's chip on the Fiber side of the swap card (wallets part). */
export interface WalletButtonProps {
  disabled?: boolean;
  /** The swap on the card needs a step of the node (the browser node cannot carry it yet). */
  attention?: boolean;
}
