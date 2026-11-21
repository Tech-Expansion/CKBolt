import type { Metadata } from "next";
import { connection } from "next/server";
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
 * It renders per request: proxy.ts sends its Content-Security-Policy with a fresh nonce, which Next.js puts on the
 * page's scripts, and a page prerendered at build time would have none.
 */
export default async function FiberWalletRoute() {
  await connection();
  return <FiberWalletApp view="frame" />;
}
