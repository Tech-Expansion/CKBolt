import type { Metadata } from "next";
import { FiberWalletApp } from "@/components/app/fiber-wallet/wallet-app";

export const metadata: Metadata = {
  title: "CKBolt - Fiber node",
  description: "Your Fiber node in the browser: the header's Fiber node shows this page. Testnet only.",
  robots: { index: false },
};

/**
 * The Fiber node that the header opens in a popover (docs/fiber-wallet-popup.md), in an iframe the root layout mounts
 * once. next.config.mjs sends Document-Isolation-Policy for this route, so this document alone is cross-origin isolated
 * and can run fiber-js, and lets only this site's own pages frame it. No navigation or footer: the popover is the frame.
 */
export default function FiberWalletRoute() {
  return <FiberWalletApp view="frame" />;
}
