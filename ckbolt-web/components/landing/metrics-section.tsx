"use client";

import { useEffect, useState, useRef } from "react";
import { motionPaused } from "@/lib/motion";

function AnimatedCounter({ end, suffix = "", prefix = "" }: { end: number; suffix?: string; prefix?: string }) {
  const [count, setCount] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const [hasAnimated, setHasAnimated] = useState(false);
  const doneRef = useRef(false);

  // After the intro animation, follow live value updates directly.
  useEffect(() => {
    if (doneRef.current) setCount(end);
  }, [end]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !hasAnimated) {
          setHasAnimated(true);
          if (motionPaused()) {
            doneRef.current = true;
            setCount(end);
            return;
          }
          let start = 0;
          const duration = 2000;
          const startTime = performance.now();

          const animate = (currentTime: number) => {
            const elapsed = currentTime - startTime;
            const progress = Math.min(elapsed / duration, 1);
            const eased = 1 - Math.pow(1 - progress, 3);
            setCount(Math.floor(eased * end));

            if (progress < 1) {
              requestAnimationFrame(animate);
            } else {
              doneRef.current = true;
              setCount(end);
            }
          };

          requestAnimationFrame(animate);
        }
      },
      { threshold: 0.5 }
    );

    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [end, hasAnimated]);

  return (
    <div ref={ref} className="text-6xl lg:text-8xl font-display tracking-tight">
      {prefix}{count.toLocaleString("en-US")}<span className="text-2xl lg:text-4xl text-muted-foreground">{suffix}</span>
    </div>
  );
}



type LightningStats = { nodes: number; channels: number; capacitySats: number; asOf: string; source: string; snapshot?: boolean };

export function MetricsSection() {
  const [isVisible, setIsVisible] = useState(false);
  const [stats, setStats] = useState<LightningStats | null>(null);
  const [statsFailed, setStatsFailed] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/lightning-stats")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: LightningStats) => !cancelled && setStats(j))
      .catch(() => !cancelled && setStatsFailed(true));
    return () => {
      cancelled = true;
    };
  }, []);

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

  const metrics = [
    ...(stats
      ? [
          { value: stats.nodes, suffix: "", label: "Public Lightning nodes" },
          { value: stats.channels, suffix: "", label: "Public Lightning channels" },
          { value: Math.round(stats.capacitySats / 1e8), suffix: " BTC", label: "Public Lightning capacity" },
        ]
      : []),
    ...(stats ? [{ value: Math.round(stats.capacitySats / stats.channels), suffix: " sats", label: "Average public channel" }] : []),
  ];
  const asOf = stats ? new Date(stats.asOf).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) : null;

  return (
    <section id="prices" ref={sectionRef} className="relative py-24 lg:py-32 border-y border-foreground/10">
      <div className="max-w-[1400px] mx-auto px-6 lg:px-12">
        {/* Header */}
        <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-8 mb-16 lg:mb-24">
          <div>
            <span className="inline-flex items-center gap-3 text-sm font-mono text-muted-foreground mb-6">
              <span className="w-8 h-px bg-foreground/30" />
              Lightning today
            </span>
            <h2
              className={`text-4xl lg:text-6xl font-display tracking-tight transition-all duration-700 ${
                isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
              }`}
            >
              The market
              <br />
              CKBolt opens to CKB.
            </h2>
          </div>
          <p className="max-w-md text-muted-foreground leading-relaxed">
            Every wallet on this network can already pay a Lightning invoice. With CKBolt, those payments can reach CKB: on testnet
            today, on mainnet from stage 6.
          </p>
        </div>

        {/* Metrics Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-px bg-foreground/10">
          {metrics.length === 0 && (
            <div className="bg-background p-8 lg:p-12 text-lg text-muted-foreground md:col-span-2">Fetching network data…</div>
          )}
          {metrics.map((metric, index) => (
            <div
              key={metric.label}
              className={`bg-background p-8 lg:p-12 transition-all duration-700 ${
                metrics.length % 2 === 1 && index === metrics.length - 1 ? "md:col-span-2" : ""
              } ${isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"}`}
              style={{ transitionDelay: `${index * 100}ms` }}
            >
              <AnimatedCounter end={metric.value} suffix={metric.suffix} />
              <div className="mt-4 text-lg text-muted-foreground">{metric.label}</div>
            </div>
          ))}
        </div>
        <p className="mt-6 text-sm text-muted-foreground">
          {stats
            ? `Lightning figures: ${stats.source} latest published public-network statistics (dated ${asOf})${stats.snapshot ? " (saved snapshot; the live source did not answer)" : ""}; private channels are not counted. `
            : statsFailed
              ? "Lightning statistics are unavailable right now. "
              : ""}
        </p>
      </div>
    </section>
  );
}
