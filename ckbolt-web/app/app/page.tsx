import type { Metadata } from "next";
import { Navigation } from "@/components/landing/navigation";
import { FooterSection } from "@/components/landing/footer-section";
import { AppIntro } from "@/components/app/app-intro";
import { AppShell } from "@/components/app/app-shell";
import { HubStatusProvider } from "@/hooks/use-hub-status";

export const metadata: Metadata = {
  title: "CKBolt app - Pay, get paid and swap across Lightning and CKB",
  description:
    "Swap BTC on Lightning for CKB and CKB tokens on Fiber, and back, through the CKBolt testnet hub: any Lightning wallet by QR code or invoice, and your Fiber node. Test networks only.",
};

export default function AppPage() {
  return (
    <>
      <Navigation />
      <main className="relative max-w-[1400px] mx-auto px-6 lg:px-12 pt-32 lg:pt-40 pb-24">
        {/* One hub status for the intro and the swap form, so both say the same and the hub is asked once. */}
        <HubStatusProvider>
          <AppIntro />
          <AppShell />
        </HubStatusProvider>
      </main>
      <FooterSection />
    </>
  );
}
