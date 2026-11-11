"use client";

import { useEffect, useRef, useState } from "react";
import { useRate } from "@/hooks/use-rate";
import { MOTION_EVENT, motionPaused } from "@/lib/motion";
import { QUOTE_ASSUMPTIONS, satsForUsd } from "@/lib/quote";

const SALE_USD = 5;

const baseSteps = [
  {
    number: "I",
    title: "Pick a route",
    description: "Pay, get paid or swap: BTC on Lightning in or out, CKB and CKB tokens on Fiber in or out. ETH through Perun comes in stage 5.",
    code: "",
  },
  {
    number: "II",
    title: "Get one quote",
    description: "The hub prices the whole route and pays from its own liquidity, on testnet today. The quote is tied to one SHA-256 payment hash.",
    code: "",
  },
  {
    number: "III",
    title: "Pay from your wallet",
    description: "A Lightning wallet scans a BOLT11 or BIP21 QR code, or a CKB holder pays from a Fiber node. The hub holds the incoming payment and cannot take it yet.",
    code: "",
  },
  {
    number: "IV",
    title: "Pay out first, then settle",
    description: "The hub pays out on the other network. The recipient reveals the preimage to claim it, and the hub uses that same preimage to settle the held payment. If the payout fails, the payer is refunded.",
    code: "",
  },
];

export function HowItWorksSection() {
  const [activeStep, setActiveStep] = useState(0);
  // Auto-advance stops once the reader picks a step, and never runs with reduced motion.
  const [paused, setPaused] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const sectionRef = useRef<HTMLDivElement>(null);
  const { rate } = useRate();

  const a = QUOTE_ASSUMPTIONS;
  const ckb = rate ? SALE_USD / rate.ckbUsd : null;
  const sats = rate ? satsForUsd(SALE_USD, rate).sats : null;
  const ckbText = ckb ? `${Math.round(ckb).toLocaleString("en-US")} CKB` : "… CKB";
  const satsText = sats ? `${sats.toLocaleString("en-US")} sats` : "… sats";

  const codes = [
    `// What goes in        -> what comes out
BTC on Lightning     -> CKB, RUSD         get paid, buy
CKB, RUSD            -> BTC on Lightning  pay, sell
CKB                  -> ETH via Perun     stage 5

// Example used below: a $${SALE_USD} sale
// customer pays in BTC, merchant gets CKB`,
    rate
      ? `// CKBolt quote, ${rate.source} reference price
in              ${satsText}  (Lightning)
out             ${ckbText}  (Fiber)
rate            1 BTC = ${Math.round(rate.btcUsd / rate.ckbUsd).toLocaleString("en-US")} CKB
hub costs       ${a.liquiditySpreadPct + a.routingFeeBudgetPct}% (assumed)
payment_hash    0x9f2c…  (same on both sides)
expires         900s`
      : "// Fetching reference prices...",
    `// Lightning, Bitcoin L2
customer -> hub   ${satsText}
status            HELD, locked to 0x9f2c…

// Paying from CKB instead:
// CKB wallet -> hub over Fiber, also HELD`,
    `// Fiber, CKB L2
hub -> merchant   ${ckbText}
merchant reveals  preimage (to claim)
hub settles       the held Lightning payment

// Same pattern for every route:
// pay out first, settle in second`,
  ];
  const steps = baseSteps.map((st, i) => ({ ...st, code: codes[i] }));

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

  useEffect(() => {
    const sync = () => motionPaused() && setPaused(true);
    sync();
    window.addEventListener(MOTION_EVENT, sync);
    return () => window.removeEventListener(MOTION_EVENT, sync);
  }, []);

  useEffect(() => {
    if (paused) return;
    const interval = setInterval(() => {
      setActiveStep((prev) => (prev + 1) % steps.length);
    }, 5000);
    return () => clearInterval(interval);
  }, [paused, steps.length]);

  return (
    <section
      id="how-it-works"
      ref={sectionRef}
      className="relative py-24 lg:py-32 bg-foreground text-background overflow-hidden"
    >
      {/* Diagonal lines pattern */}
      <div className="absolute inset-0 opacity-[0.03] pointer-events-none">
        <div className="absolute inset-0" style={{
          backgroundImage: `repeating-linear-gradient(
            -45deg,
            transparent,
            transparent 40px,
            currentColor 40px,
            currentColor 41px
          )`
        }} />
      </div>

      <div className="relative z-10 max-w-[1400px] mx-auto px-6 lg:px-12">
        {/* Header */}
        <div className="mb-16 lg:mb-24">
          <span className="inline-flex items-center gap-3 text-sm font-mono text-background/50 mb-6">
            <span className="w-8 h-px bg-background/30" />
            How it works
          </span>
          <h2
            className={`text-4xl lg:text-6xl font-display tracking-tight transition-all duration-700 ${
              isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
            }`}
          >
            Four steps.
            <br />
            <span className="text-background/50">Both directions.</span>
          </h2>
        </div>

        {/* Main content */}
        <div className="grid lg:grid-cols-2 gap-16 lg:gap-24">
          {/* Steps */}
          <div className="space-y-0 min-w-0">
            {steps.map((step, index) => (
              <button
                key={step.number}
                type="button"
                onClick={() => {
                  setActiveStep(index);
                  setPaused(true);
                }}
                aria-pressed={activeStep === index}
                className="w-full text-left py-8 border-b border-background/10 group"
              >
                <div className="flex items-start gap-6">
                  <span className="w-12 shrink-0 font-display text-3xl text-background/40" aria-hidden="true">{step.number}</span>
                  <div className="flex-1">
                    <h3
                      className={`text-2xl lg:text-3xl font-display mb-3 group-hover:translate-x-2 transition-all duration-300 ${
                        activeStep === index ? "text-background" : "text-background/60 group-hover:text-background/80"
                      }`}
                    >
                      {step.title}
                    </h3>
                    <p className={`leading-relaxed transition-colors duration-300 ${activeStep === index ? "text-background/75" : "text-background/55"}`}>
                      {step.description}
                    </p>
                    
                    {/* Progress indicator */}
                    {activeStep === index && !paused && (
                      <div className="mt-4 h-px bg-background/20 overflow-hidden">
                        <div 
                          className="h-full w-full bg-background origin-left"
                          style={{
                            animation: 'progress 5s linear both'
                          }}
                        />
                      </div>
                    )}
                  </div>
                </div>
              </button>
            ))}
          </div>

          {/* Code display */}
          <div className="lg:sticky lg:top-32 self-start min-w-0">
            <div className="border border-background/10 overflow-hidden">
              {/* Window header */}
              <div className="px-6 py-4 border-b border-background/10 flex items-center justify-between">
                <div className="flex gap-2">
                  <div className="w-3 h-3 rounded-full bg-background/20" />
                  <div className="w-3 h-3 rounded-full bg-background/20" />
                  <div className="w-3 h-3 rounded-full bg-background/20" />
                </div>
                <span className="text-xs font-mono text-background/60">checkout-flow.txt</span>
              </div>

              {/* Code content */}
              <div className="p-5 sm:p-8 font-mono text-xs sm:text-sm min-h-[280px] overflow-x-auto" tabIndex={0} role="region" aria-label="Example for the selected step">
                <pre className="text-background/70">
                  {steps[activeStep].code.split('\n').map((line, lineIndex) => (
                    <div 
                      key={`${activeStep}-${lineIndex}`} 
                      className="leading-loose code-line-reveal"
                      style={{ 
                        animationDelay: `${lineIndex * 80}ms`,
                      }}
                    >
                      <span className="text-background/20 select-none w-8 inline-block" aria-hidden="true">{lineIndex + 1}</span>
                      <span className="inline-flex">
                        {line.split('').map((char, charIndex) => (
                          <span
                            key={`${activeStep}-${lineIndex}-${charIndex}`}
                            className="code-char-reveal"
                            style={{
                              animationDelay: `${lineIndex * 80 + charIndex * 15}ms`,
                            }}
                          >
                            {char === ' ' ? '\u00A0' : char}
                          </span>
                        ))}
                      </span>
                    </div>
                  ))}
                </pre>
              </div>

              {/* Status */}
              <div className="px-6 py-4 border-t border-background/10 flex items-center gap-3">
                <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                <span className="text-xs font-mono text-background/60">Illustrative. No transaction is created.</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <style jsx>{`
        @keyframes progress {
          from { transform: scaleX(0); }
          to { transform: scaleX(1); }
        }
        
        .code-line-reveal {
          opacity: 0;
          transform: translateX(-8px);
          animation: lineReveal 0.4s cubic-bezier(0.22, 1, 0.36, 1) forwards;
        }
        
        @keyframes lineReveal {
          to {
            opacity: 1;
            transform: translateX(0);
          }
        }
        
        .code-char-reveal {
          opacity: 0;
          filter: blur(8px);
          animation: charReveal 0.3s cubic-bezier(0.22, 1, 0.36, 1) forwards;
        }
        
        @keyframes charReveal {
          to {
            opacity: 1;
            filter: blur(0);
          }
        }
      `}</style>
    </section>
  );
}
