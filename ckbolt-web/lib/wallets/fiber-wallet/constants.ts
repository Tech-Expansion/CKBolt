import type { FiberWalletKind } from "@/components/app/swap/contracts";

/**
 * Facts of the visitor's Fiber wallet in the live swap card (docs/live-swap-ui.md, part "wallets"): the browser node on
 * /app/fiber, driven over the bridge, or the visitor's own node (Fiber Studio, fnn), driven by hand.
 */

/** Every kind, in the order the Fiber wallet dialog offers them. */
export const FIBER_WALLET_KINDS: readonly FiberWalletKind[] = ["browser-node", "own-node"];

/** Short names the wallet button shows. */
export const FIBER_WALLET_LABEL: Readonly<Record<FiberWalletKind, string>> = {
  "browser-node": "CKBolt node",
  "own-node": "External node",
};

/**
 * sessionStorage key of the chosen kind, so a reload keeps it for this tab. Only the kind is stored: the browser node's
 * keys stay with its own page, and an own node has nothing to store.
 */
export const FIBER_WALLET_KIND_STORAGE_KEY = "ckbolt.fiber-wallet.kind";
