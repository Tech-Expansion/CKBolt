import type { Metadata } from "next";
import { Navigation } from "@/components/landing/navigation";
import { FooterSection } from "@/components/landing/footer-section";
import { BrandGuidelines } from "@/components/brand/guidelines";

export const metadata: Metadata = {
  title: "CKBolt - Brand guidelines",
  description:
    "How CKBolt looks, sounds and shows up: the mark, color, type, interface, voice and usage. For anyone writing, building or presenting about payments between Lightning and CKB.",
};

/** The brand guidelines (brand kit v1.0). The kit's files are on /brand-assets. */
export default function BrandPage() {
  return (
    <>
      <Navigation />
      <main>
        <BrandGuidelines />
      </main>
      <FooterSection />
    </>
  );
}
