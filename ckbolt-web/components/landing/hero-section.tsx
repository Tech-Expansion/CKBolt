"use client";

import { useEffect, useState } from "react";
import { SiteLink } from "@/components/site-link";
import { APP_PAGE_PATH } from "@/lib/wallets/fiber-browser/constants";
import { Button } from "@/components/ui/button";
import { ArrowRight } from "lucide-react";
import { AnimatedSphere } from "./animated-sphere";
import { useRate } from "@/hooks/use-rate";
import { MOTION_EVENT, motionPaused, setMotionPaused } from "@/lib/motion";
import { quoteSwap, satsForUsd } from "@/lib/quote";
import { PAY_TOKENS } from "@/lib/tokens";

// Examples at reference prices plus the assumed hub costs, sized within the testnet hub's per-swap limits.
// The live hub quotes its own prices in the app.
const token = (symbol: string) => PAY_TOKENS.find((t) => t.symbol === symbol)!;

// Assets the testnet hub quotes. ETH joins with the Perun route in stage 5.
const words = ["CKB", "BTC", "RUSD"];

export function HeroSection() {
  const [isVisible, setIsVisible] = useState(false);
  const [wordIndex, setWordIndex] = useState(0);
  // Motion stops with the system "reduce motion" setting or the Pause motion button below.
  const [motionOff, setMotionOff] = useState(false);
  const { rate } = useRate();

  useEffect(() => {
    setIsVisible(true);
    const sync = () => setMotionOff(motionPaused());
    sync();
    window.addEventListener(MOTION_EVENT, sync);
    return () => window.removeEventListener(MOTION_EVENT, sync);
  }, []);

  useEffect(() => {
    if (motionOff) return;
    const interval = setInterval(() => {
      setWordIndex((prev) => (prev + 1) % words.length);
    }, 2500);
    return () => clearInterval(interval);
  }, [motionOff]);

  return (
    <section className="relative min-h-screen flex flex-col justify-center overflow-hidden">
      {/* Animated sphere background */}
      {/* Sits above the grid lines and inside the same centered container as the content */}
      <div className="absolute inset-0 z-[1] pointer-events-none">
        <div className="relative h-full w-full max-w-[1600px] mx-auto px-6 lg:px-12">
          <div className="absolute top-1/2 -translate-y-1/2 w-[380px] h-[380px] md:w-[480px] md:h-[480px] lg:w-[440px] lg:h-[440px] xl:w-[520px] xl:h-[520px] 2xl:w-[680px] 2xl:h-[680px] min-[1700px]:w-[760px] min-[1700px]:h-[760px] right-[10px] lg:right-[30px] xl:right-[27px] 2xl:right-[21px] min-[1700px]:right-[18px] opacity-15 lg:opacity-40">
            <AnimatedSphere />
          </div>
        </div>
      </div>
      
      {/* Subtle grid lines */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none opacity-30">
        {[...Array(8)].map((_, i) => (
          <div
            key={`h-${i}`}
            className="absolute h-px bg-foreground/10"
            style={{
              top: `${12.5 * (i + 1)}%`,
              left: 0,
              right: 0,
            }}
          />
        ))}
        {[...Array(12)].map((_, i) => (
          <div
            key={`v-${i}`}
            className="absolute w-px bg-foreground/10"
            style={{
              left: `${8.33 * (i + 1)}%`,
              top: 0,
              bottom: 0,
            }}
          />
        ))}
      </div>
      
      <div className="relative z-10 w-full max-w-[1600px] mx-auto px-6 lg:px-12 pt-32 pb-12 lg:pt-40 lg:pb-16">
        {/* Eyebrow */}
        <div 
          className="mb-8"
        >
          <span className="inline-flex items-center gap-3 text-sm font-mono text-muted-foreground">
            <span className="w-8 h-px bg-foreground/30" />
            Live testnet demo by TEX Labs, stage 3 of 6
          </span>
        </div>
        
        {/* Main headline */}
        <div className="mb-12">
          <h1 
            className="text-[clamp(3rem,6.6vw,7rem)] font-display leading-[0.9] tracking-tight"
          >
            <span className="block">Pay, get paid, swap.</span>
            <span className="block">
              In{" "}
              <span className="relative inline-block">
                <span 
                  key={wordIndex}
                  className="inline-flex"
                >
                  {words[wordIndex].split("").map((char, i) => (
                    <span
                      key={`${wordIndex}-${i}`}
                      className="inline-block animate-char-in"
                      style={{
                        animationDelay: `${i * 50}ms`,
                      }}
                    >
                      {char}
                    </span>
                  ))}
                </span>
                <span className="absolute -bottom-2 left-0 right-0 h-3 bg-foreground/10" />
              </span>
            </span>
          </h1>
        </div>
        
        {/* Description */}
        <div className="grid gap-8 items-start">
          <p 
            className="text-xl lg:text-2xl text-muted-foreground leading-relaxed max-w-[clamp(20rem,calc(46vw-8rem),36rem)]"
          >
            CKBolt connects Bitcoin Lightning to CKB&apos;s Fiber Network. Lightning users can pay CKB merchants, and CKB holders can pay
            Lightning invoices. Each payment completes on both sides, or the payer is refunded.
          </p>
          
          {/* CTAs */}
          <div 
            className="flex flex-col sm:flex-row items-start gap-4"
          >
            <Button 
              asChild
              size="lg" 
              className="bg-foreground hover:bg-foreground/90 text-background px-8 h-14 text-base rounded-full group"
            >
              <SiteLink href={APP_PAGE_PATH}>
                Try the demo
                <ArrowRight className="w-4 h-4 ml-2 transition-transform group-hover:translate-x-1" />
              </SiteLink>
            </Button>
            <Button 
              asChild
              size="lg" 
              variant="outline" 
              className="h-14 px-8 text-base rounded-full border-foreground/20 hover:bg-foreground/5"
            >
              <a href="#features">See use cases</a>
            </Button>
          </div>
        </div>
        
      </div>
      
      {/* Stats marquee - full width outside container, always below the buttons so it never overlaps them. */}
      <div
        className={`relative z-10 pb-16 lg:pb-24 transition-all duration-700 delay-500 ${
          isVisible ? "opacity-100" : "opacity-0"
        }`}
      >
        <div className="flex gap-16 marquee whitespace-nowrap" data-marquee>
          {[...Array(2)].map((_, i) => (
            <div key={i} className="flex gap-16" data-marquee-copy={i}>
              {(rate
                ? [
                    {
                      value: `${Math.round(5 / rate.ckbUsd).toLocaleString("en-US")} CKB`,
                      label: "to a merchant for a $5 Lightning payment",
                      company: `CUSTOMER PAYS ${satsForUsd(5, rate).sats.toLocaleString("en-US")} SATS · REFERENCE PRICES, INCL. 1% ASSUMED HUB COSTS`,
                    },
                    {
                      value: `${Math.floor(quoteSwap(1_000, token("CKB"), "BTC", rate)!.receiveAmount * 1e8).toLocaleString("en-US")} sats`,
                      label: "on Lightning for 1,000 CKB",
                      company: "CKB TO BTC · REFERENCE PRICES, AFTER 1% ASSUMED HUB COSTS",
                    },
                    {
                      value: `${Math.floor(quoteSwap(10, token("RUSD"), "BTC", rate)!.receiveAmount * 1e8).toLocaleString("en-US")} sats`,
                      label: "for 10 RUSD, a stablecoin on CKB",
                      company: "RUSD AT ITS $1 PEG · REFERENCE PRICES, AFTER 1% ASSUMED HUB COSTS",
                    },
                    {
                      value: `${satsForUsd(1, rate).sats.toLocaleString("en-US")} sats`,
                      label: "for a Fiber invoice worth $1, paid from Lightning",
                      company: "REFERENCE PRICES, INCL. 1% ASSUMED HUB COSTS",
                    },
                  ]
                : [{ value: "…", label: "fetching reference prices", company: "MARKET REFERENCE" }]
              ).map((stat) => (
                <div key={`${stat.company}-${i}`} className="flex items-baseline gap-4">
                  <span className="text-4xl lg:text-5xl font-display">{stat.value}</span>
                  <span className="text-sm text-muted-foreground">
                    {stat.label}
                    <span className="block font-mono text-xs mt-1">{stat.company}</span>
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className="relative z-10 w-full max-w-[1600px] mx-auto px-6 lg:px-12 -mt-10 lg:-mt-16 pb-6 flex justify-end">
        <button
          type="button"
          onClick={() => setMotionPaused(!motionOff)}
          aria-pressed={motionOff}
          className="min-h-10 px-3 font-mono text-xs text-muted-foreground hover:text-foreground"
        >
          {motionOff ? "Play motion" : "Pause motion"}
        </button>
      </div>
    </section>
  );
}
