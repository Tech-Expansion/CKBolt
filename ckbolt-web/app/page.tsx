import { Navigation } from "@/components/landing/navigation";
import { HeroSection } from "@/components/landing/hero-section";
import { OverviewSection } from "@/components/landing/overview-section";
import { FeaturesSection } from "@/components/landing/features-section";
import { HowItWorksSection } from "@/components/landing/how-it-works-section";
import { InfrastructureSection } from "@/components/landing/infrastructure-section";
import { MetricsSection } from "@/components/landing/metrics-section";
import { SecuritySection } from "@/components/landing/security-section";
import { FaqSection } from "@/components/landing/faq-section";
import { PricingSection } from "@/components/landing/pricing-section";
import { CtaSection } from "@/components/landing/cta-section";
import { FooterSection } from "@/components/landing/footer-section";
import { RateProvider } from "@/hooks/use-rate";

// Order follows a reviewer's read: what it is, the problem, the solution and what CKB
// gains, the market it opens, the uses, how it works, the architecture, the roadmap.
export default function Home() {
  return (
    // One shared price feed for the hero, How it works and the market figures.
    <RateProvider>
    <main className="relative min-h-screen overflow-x-hidden noise-overlay">
      <Navigation />
      <HeroSection />
      <SecuritySection />
      <OverviewSection />
      <MetricsSection />
      <FeaturesSection />
      <HowItWorksSection />
      <InfrastructureSection />
      <PricingSection />
      <FaqSection />
      <CtaSection />
      <FooterSection />
    </main>
    </RateProvider>
  );
}
