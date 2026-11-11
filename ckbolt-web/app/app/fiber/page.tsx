import type { Metadata } from "next";
import { Navigation } from "@/components/landing/navigation";
import { FooterSection } from "@/components/landing/footer-section";
import { FiberNodeApp } from "@/components/app/fiber-node/fiber-node-app";
import { FiberWalletApp } from "@/components/app/fiber-wallet/wallet-app";
import { PageIntro } from "@/components/app/page-intro";
import { FIBER_JS_VERSION } from "@/lib/wallets/fiber-browser/constants";
import { isWalletWindowQuery } from "@/lib/wallets/fiber-browser/links";
import { FIBER_WALLET_WINDOW } from "@/lib/wallets/fiber-popup/constants";

export const metadata: Metadata = {
  title: "CKBolt app - Your Fiber node in the browser",
  description:
    "Run your own Fiber node in this browser tab on CKB testnet, fund it from your CKB wallet, open a channel with the CKBolt hub, and use it to pay and receive in live testnet swaps. Experimental; test networks only.",
};

/** The page's intro: one line, with what the node is behind the "?". */
const FIBER_PAGE_COPY = {
  eyebrow: "Testnet, experimental: a Fiber node in your browser",
  heading: "Your Fiber node.",
  lead: "A Fiber node in this tab, for live swaps on testnet.",
  tip: {
    label: "About the browser node",
    text: `fiber-js ${FIBER_JS_VERSION} runs in this tab on CKB testnet. Its keys are made here and stay in this browser, encrypted with your password. Fund it, connect it to the hub, then swap with it on the app page.`,
  },
} as const;

/**
 * The visitor's own Fiber node (fiber-js) on an isolated page: next.config.mjs sends Document-Isolation-Policy and
 * COOP/COEP for this route only, so the CCC wallet popups on /app keep working. Links here are plain <a>, never
 * next/link: only a full load gets this page's headers. With ?view=wallet it is the Fiber node popup in a window of its own,
 * for browsers that cannot isolate the header's popover (Firefox, Safari).
 */
export default async function FiberNodeRoute({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (isWalletWindowQuery((await searchParams)[FIBER_WALLET_WINDOW.PARAM])) return <FiberWalletApp view="window" />;
  return (
    <>
      <Navigation isolatedPage />
      <main className="relative max-w-[1400px] mx-auto px-6 lg:px-12 pt-32 lg:pt-40 pb-24">
        <PageIntro {...FIBER_PAGE_COPY} />
        <FiberNodeApp />
      </main>
      <FooterSection />
    </>
  );
}
