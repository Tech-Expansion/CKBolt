import type { Metadata } from "next";
import { Navigation } from "@/components/landing/navigation";
import { FooterSection } from "@/components/landing/footer-section";
import { GUIDE_INTRO } from "@/components/app/guide/copy";
import { HubCard } from "@/components/app/guide/hub-card";
import { TestnetGuide } from "@/components/app/guide/testnet-guide";
import { PageIntro } from "@/components/app/page-intro";

export const metadata: Metadata = {
  title: "CKBolt app - Testnet guide",
  description:
    "How to try CKBolt's live testnet demo: a Mutinynet Lightning wallet, a Fiber node in your browser funded with testnet CKB, channels with the CKBolt hub, and swaps both ways. Test networks only.",
};

/**
 * The tester's guide: the hub to connect to (live, #hub), what to prepare and every step to a swap both ways (phase-3c
 * plan F1.1 and F10.1).
 */
export default function GuidePage() {
  return (
    <>
      <Navigation />
      <main className="relative max-w-[1400px] mx-auto px-6 lg:px-12 pt-32 lg:pt-40 pb-24">
        <PageIntro {...GUIDE_INTRO} />
        <HubCard />
        <TestnetGuide />
      </main>
      <FooterSection />
    </>
  );
}
