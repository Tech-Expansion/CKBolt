"use client";

import { useEffect, useState, useRef } from "react";
import { MOTION_EVENT, motionPaused } from "@/lib/motion";

const locations = [
  { city: "Wallets", region: "Lightning and CKB wallets; Ethereum wallets from stage 5", latency: "Existing" },
  { city: "CKBolt quote & routing engine", region: "Firm quotes signed by the hub, from a median of exchange prices plus its spread", latency: "Testnet" },
  { city: "Liquidity", region: "The CKBolt hub's own on testnet; Cross-Chain Hub operators and independent providers later", latency: "Testnet" },
  { city: "Bitcoin Lightning", region: "Bitcoin L2. BTC in and out, hold invoices", latency: "Existing" },
  { city: "Fiber Network", region: "CKB L2. CKB and whitelisted tokens, such as RUSD on testnet", latency: "Existing" },
  { city: "Perun channels", region: "CKB to Ethereum in one multi-ledger channel", latency: "Stage 5" },
  { city: "Merchants, apps and users", region: "Receive the asset they asked for", latency: "Endpoint" },
];

export function InfrastructureSection() {
  const [isVisible, setIsVisible] = useState(false);
  const [activeLocation, setActiveLocation] = useState(0);
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

  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;
    const sync = () => {
      clearInterval(interval);
      interval = undefined;
      if (motionPaused()) return;
      interval = setInterval(() => setActiveLocation((prev) => (prev + 1) % locations.length), 2000);
    };
    sync();
    window.addEventListener(MOTION_EVENT, sync);
    return () => {
      clearInterval(interval);
      window.removeEventListener(MOTION_EVENT, sync);
    };
  }, []);

  return (
    <section id="architecture" ref={sectionRef} className="relative py-24 lg:py-32 overflow-hidden">
      <div className="max-w-[1400px] mx-auto px-6 lg:px-12">
        <div className="grid lg:grid-cols-2 gap-16 lg:gap-24 items-center">
          {/* Left: Content */}
          <div
            className={`transition-all duration-700 ${
              isVisible ? "opacity-100 translate-x-0" : "opacity-0 -translate-x-8"
            }`}
          >
            <span className="inline-flex items-center gap-3 text-sm font-mono text-muted-foreground mb-6">
              <span className="w-8 h-px bg-foreground/30" />
              Architecture
            </span>
            <h2 className="text-4xl lg:text-6xl font-display tracking-tight mb-8">
              One quote.
              <br />
              Both networks.
            </h2>
            <p className="text-xl text-muted-foreground leading-relaxed mb-12">
              CKBolt sits between Lightning and Fiber, with Ethereum in stage 5. A quote engine prices each route; picking the cheapest
              of several liquidity sources is planned for stage 6. Hubs running a Lightning node and a Fiber node link both legs of a
              payment through one SHA-256 hash, in either direction. The Ethereum route uses a Perun multi-ledger channel instead, where both assets sit in one jointly signed channel.
            </p>

            {/* Stats */}
            <div className="grid grid-cols-3 gap-8">
              <div>
                <div className="text-4xl lg:text-5xl font-display mb-2">3</div>
                <div className="text-sm text-muted-foreground">Networks: Lightning, Fiber and, later, Ethereum</div>
              </div>
              <div>
                <div className="text-4xl lg:text-5xl font-display mb-2">3</div>
                <div className="text-sm text-muted-foreground">Assets quoted on testnet: BTC, CKB, RUSD</div>
              </div>
              <div>
                <div className="text-4xl lg:text-5xl font-display mb-2">0</div>
                <div className="text-sm text-muted-foreground">Real funds moved: test money only</div>
              </div>
            </div>
          </div>

          {/* Right: Location list */}
          <div
            className={`transition-all duration-700 delay-200 ${
              isVisible ? "opacity-100 translate-x-0" : "opacity-0 translate-x-8"
            }`}
          >
            <div className="border border-foreground/10">
              {/* Header */}
              <div className="px-6 py-4 border-b border-foreground/10 flex items-center justify-between">
                <span className="text-sm font-mono text-muted-foreground">Payment route</span>
                <span className="flex items-center gap-2 text-xs font-mono text-muted-foreground">
                  <span className="w-2 h-2 rounded-full bg-foreground/40 animate-pulse" />
                  Intended architecture
                </span>
              </div>

              {/* Locations */}
              <div>
                {locations.map((location, index) => (
                  <div
                    key={location.city}
                    className={`px-6 py-5 border-b border-foreground/5 last:border-b-0 flex items-center justify-between gap-4 transition-all duration-300 ${
                      activeLocation === index ? "bg-foreground/[0.02]" : ""
                    }`}
                  >
                    <div className="flex items-center gap-4 min-w-0">
                      <span 
                        className={`shrink-0 w-2 h-2 rounded-full transition-colors duration-300 ${
                          activeLocation === index ? "bg-foreground" : "bg-foreground/20"
                        }`}
                      />
                      <div>
                        <div className="font-medium">{location.city}</div>
                        <div className="text-sm text-muted-foreground">{location.region}</div>
                      </div>
                    </div>
                    <span className="shrink-0 font-mono text-sm text-muted-foreground">{location.latency}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
