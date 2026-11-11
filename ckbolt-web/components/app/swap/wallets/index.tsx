/**
 * The wallets part of the live swap card (docs/live-swap-ui.md, part "wallets" and "One wallet"). The swap card uses
 * only these names and the types in ../contracts.ts:
 * - `FiberWalletProvider`: wraps the card; holds the Fiber node and renders its dialog.
 * - `useFiberWallet()`: the visitor's Fiber node (`FiberWalletApi`).
 * - `useWalletDialogs()`: `openWalletDialog()` for the primary button's Fiber states, and `open`.
 * - `WalletButton`: the Fiber node's chip on the card.
 * The Lightning side has no wallet here: a QR code or a pasted invoice, from any wallet.
 */
export { FiberWalletProvider, useFiberWallet, useWalletDialogs, type WalletDialogs } from "./fiber-wallet-provider";
export { WalletButton } from "./wallet-button";
