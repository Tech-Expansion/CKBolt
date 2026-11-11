/**
 * Copy of the "How it works" dialog of the live swap card (docs/live-swap-ui.md, part "help"). Terse on purpose: at
 * most four sections, no sentence over twelve words. The swap card itself stays as short as a DEX; this is where the
 * explanation lives.
 */

/** The trigger's text and the dialog's title. */
export const HOW_IT_WORKS_LABEL = "How it works";

/** Small print under the dialog title. */
export const HOW_IT_WORKS_SUMMARY = "Lightning and Fiber, locked to one hash.";

export interface HowItWorksStep {
  /** One or two words, shown next to the step number. */
  title: string;
  /** One short line. */
  text: string;
}

/** The four steps of every swap, in order, for both directions. */
export const HOW_IT_WORKS_STEPS: readonly HowItWorksStep[] = [
  { title: "Invoice", text: "Your receiving side gives an invoice for the quote." },
  { title: "Lock", text: "Your paying side pays the hub. The payment is held, not taken." },
  { title: "Payout", text: "The hub pays your invoice. That reveals the key." },
  { title: "Settle", text: "With that key, the hub takes your held payment." },
];

/** Under the steps: the Fiber node does its part by itself; the Lightning side is a QR code or a pasted invoice. */
export const HOW_IT_WORKS_ONE_CLICK = "Your Fiber node acts by itself. Lightning is a QR code or a paste.";

export interface HowItWorksWallet {
  /** The network, as the wallet buttons name it. */
  network: string;
  /** What moves on it. */
  assets: string;
  /** Which wallet fits. */
  text: string;
}

/** The two sides: `fiberAssets` is the hub's assets as a list ("CKB, RUSD, cWBTC"), or "CKB tokens" before it lists any. */
export const howItWorksWallets = (fiberAssets: string): readonly HowItWorksWallet[] => [
  { network: "Lightning", assets: "BTC", text: "Any wallet on Mutinynet, by QR code or pasted invoice." },
  { network: "Fiber", assets: fiberAssets, text: "The Fiber node at the top of the page, or your own." },
];

/** Where an L1 wallet fits: only in funding the Fiber node, never in the swap. */
export const HOW_IT_WORKS_L1_NOTE = "A CKB L1 wallet such as JoyID only funds the Fiber node.";

export const HOW_IT_WORKS_SAFETY: readonly string[] = [
  "Both payments are locked to one SHA-256 hash.",
  "The hub can take yours only after it pays you.",
  "No payout? Your payment goes back to your wallet automatically.",
  "A stuck payout can keep your payment locked for hours.",
];

export const HOW_IT_WORKS_TESTNET: readonly string[] = ["Test money on test networks only.", "Mainnet wallets are refused."];

/** Under the sections: the tester's guide, from an empty browser to a swap both ways. */
export const HOW_IT_WORKS_GUIDE_LINK = "Testnet guide: every step";

/** Beside it: the guide's live card with the hub's addresses (its Lightning URIs, its Fiber node). */
export { HUB_DETAILS_LINK as HOW_IT_WORKS_HUB_LINK } from "../../guide/copy";

/** Section headings, in the order the dialog shows them. */
export const HOW_IT_WORKS_HEADING = {
  STEPS: "What happens",
  WALLETS: "Wallets you need",
  SAFETY: "Is it safe?",
  TESTNET: "Test networks only",
} as const;
