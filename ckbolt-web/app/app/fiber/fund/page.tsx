import type { Metadata } from "next";
import { Navigation } from "@/components/landing/navigation";
import { FooterSection } from "@/components/landing/footer-section";
import { FundNodeApp } from "@/components/app/fiber-node/fund-node-app";
import { PageIntro } from "@/components/app/page-intro";

export const metadata: Metadata = {
  title: "CKBolt app - Fund your browser Fiber node",
  description:
    "Send test CKB from your CKB wallet to the Fiber node that runs in your browser, so it can open a channel with the CKBolt hub. CKB testnet only; test money.",
};

/** The page's intro: one line, with why funding has its own page behind the "?". */
const FUND_PAGE_COPY = {
  eyebrow: "Testnet: fund your browser Fiber node",
  heading: "Fund your Fiber node.",
  lead: "Send test CKB from your wallet to your browser node.",
  tip: {
    label: "About this page",
    text: "With CKB on it, your node can open a channel with the CKBolt hub. Your wallet signs here, because wallet popups do not work on the isolated node page.",
  },
} as const;

/**
 * Funding for the visitor's browser Fiber node: the node page's "Fund this node" opens it in a new tab with the node's
 * address. A normal page, not cross-origin isolated (next.config.mjs isolates /app/fiber alone), because the CCC wallet
 * popups need that.
 */
export default function FundFiberNodeRoute() {
  return (
    <>
      <Navigation />
      <main className="relative max-w-[1400px] mx-auto px-6 lg:px-12 pt-32 lg:pt-40 pb-24">
        <PageIntro {...FUND_PAGE_COPY} />
        <FundNodeApp />
      </main>
      <FooterSection />
    </>
  );
}
