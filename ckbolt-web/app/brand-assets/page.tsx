import type { Metadata } from "next";
import { Navigation } from "@/components/landing/navigation";
import { FooterSection } from "@/components/landing/footer-section";
import { BrandKitPage } from "@/components/brand/kit-page";

export const metadata: Metadata = {
  title: "CKBolt - Brand kit",
  description:
    "Logos, icons, share cards and design tokens for CKBolt, in SVG, PNG, ICO, JSON and CSS. One download or file by file.",
};

/** The brand kit's files (v1.0), each with its own download. */
export default function BrandKitRoute() {
  return (
    <>
      <Navigation />
      <main>
        <BrandKitPage />
      </main>
      <FooterSection />
    </>
  );
}
