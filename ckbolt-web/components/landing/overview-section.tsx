"use client";

import { useEffect, useRef, useState } from "react";
import { SiteLink } from "@/components/site-link";
import { APP_PAGE_PATH } from "@/lib/wallets/fiber-browser/constants";
import { ArrowRight } from "lucide-react";
import { GUIDE_PAGE_PATH } from "@/components/app/guide/constants";

const columns = [
  {
    title: "What CKBolt adds",
    points: [
      "Fiber's Cross-Chain Hub links Lightning and Fiber for one wrapped-BTC token at a fixed 1:1 rate.",
      "CKBolt adds a price for each route, so native CKB and stablecoins such as RUSD can use the same hash-lock pattern, in both directions.",
      "On top come swaps, Get paid for merchants and Pay for CKB holders, all live on testnet. An API for wallets and POS terminals is planned for stage 4.",
    ],
  },
  {
    title: "Why build it on CKB",
    points: [
      "Fiber already supports hold invoices, SHA-256 hash locks and token channels: what a hash-locked hub needs.",
      "Fiber carries tokens as well as CKB, so stablecoins can settle on L2.",
    ],
  },
  {
    title: "What CKB gains",
    points: [
      "Lightning users become customers of CKB merchants and apps, without leaving their wallets or holding CKB.",
      "CKB and CKB stablecoins become settlement assets for real payments.",
      "Payment volume flows through Fiber channels, giving node operators fees and a reason to add liquidity.",
    ],
  },
];

const today = [
  "Real swaps with test money",
  "BTC on Lightning to CKB and RUSD on Fiber, and back",
  "Pay Lightning and Fiber invoices",
  "Get paid from Lightning or Fiber",
  "Fiber node in your browser",
  "Refund when a payout fails",
];

export function OverviewSection() {
  const [isVisible, setIsVisible] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setIsVisible(true);
      },
      { threshold: 0.1 }
    );
    if (sectionRef.current) observer.observe(sectionRef.current);
    return () => observer.disconnect();
  }, []);

  return (
    <section id="impact" ref={sectionRef} className="relative py-24 lg:py-32 border-t border-foreground/10">
      <div className="max-w-[1400px] mx-auto px-6 lg:px-12">
        <div
          className={`max-w-4xl mb-16 lg:mb-20 transition-all duration-700 ${
            isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
          }`}
        >
          <span className="inline-flex items-center gap-3 text-sm font-mono text-muted-foreground mb-6">
            <span className="w-8 h-px bg-foreground/30" />
            Solution and impact on CKB
          </span>
          <h2 className="text-4xl lg:text-6xl font-display tracking-tight mb-8">
            Lightning&apos;s users,
            <br />
            <span className="text-muted-foreground">paying into CKB.</span>
          </h2>
          <p className="text-xl text-muted-foreground leading-relaxed">
            CKBolt connects CKB&apos;s Fiber Network to Bitcoin Lightning, so people can pay, get paid and swap between BTC, CKB and
            tokens issued on CKB, all on L2. It has three parts: a hub that runs a Lightning node and a Fiber node, a quote engine that
            prices each route, and an API for wallets, POS terminals and apps. The hub and the quote engine run on testnet; the API is
            planned for stage 4.
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-12 lg:gap-16">
          {columns.map((col, index) => (
            <div
              key={col.title}
              className={`border-t border-foreground pt-6 transition-all duration-700 ${
                isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-6"
              }`}
              style={{ transitionDelay: `${index * 100 + 150}ms` }}
            >
              <h3 className="font-display text-2xl lg:text-3xl mb-6">{col.title}</h3>
              <ul className="space-y-4">
                {col.points.map((p) => (
                  <li key={p} className="text-muted-foreground leading-relaxed">
                    {p}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-16 lg:mt-20 border border-foreground/10 p-6 lg:p-8 flex flex-col lg:flex-row lg:items-center gap-6 lg:gap-10">
          <div className="lg:w-56 shrink-0">
            <p className="font-mono text-xs text-muted-foreground">Today, stage 3 of 6</p>
            <p className="font-display text-2xl mt-1">Live testnet demo</p>
          </div>
          <ul className="flex-1 flex flex-wrap gap-2">
            {today.map((t) => (
              <li key={t} className="px-3 py-1.5 border border-foreground/10 text-sm">
                {t}
              </li>
            ))}
          </ul>
          <div className="flex gap-4 text-sm shrink-0">
            <SiteLink href={APP_PAGE_PATH} className="inline-flex items-center gap-2 font-medium hover:underline underline-offset-4">
              Try the live demo <ArrowRight className="w-4 h-4" />
            </SiteLink>
            <SiteLink href={GUIDE_PAGE_PATH} className="text-muted-foreground hover:text-foreground">
              Testnet guide
            </SiteLink>
            <a href="#roadmap" className="text-muted-foreground hover:text-foreground">
              See the roadmap
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
