"use client";

import { ArrowUpRight } from "lucide-react";
import { SiteLink } from "@/components/site-link";
import { GUIDE_PAGE_PATH } from "@/components/app/guide/constants";
import { AnimatedWave } from "./animated-wave";

const footerLinks = {
  Product: [
    { name: "App (testnet)", href: "/app" },
    { name: "Testnet guide", href: GUIDE_PAGE_PATH },
    { name: "Problem", href: "/#problem" },
    { name: "Impact on CKB", href: "/#impact" },
    { name: "Use cases", href: "/#features" },
    { name: "How it works", href: "/#how-it-works" },
    { name: "Architecture", href: "/#architecture" },
    { name: "Roadmap", href: "/#roadmap" },
    { name: "FAQ", href: "/#faq" },
  ],
  Developers: [
    { name: "Nervos docs", href: "https://docs.nervos.org" },
    { name: "Fiber on GitHub", href: "https://github.com/nervosnetwork/fiber" },
    { name: "go-perun on GitHub", href: "https://github.com/hyperledger-labs/go-perun" },
    { name: "Reference price endpoint", href: "/api/rate" },
  ],
  "TEX Labs": [
    { name: "texlabs.org", href: "https://texlabs.org" },
    { name: "Midnight Explorer (earlier work)", href: "https://www.midnightexplorer.com/" },
    { name: "Midnight API Platform (earlier work)", href: "https://api-management.midnightexplorer.com/" },
  ],
  Ecosystem: [
    { name: "Nervos Network", href: "https://www.nervos.org" },
    { name: "Nervos Talk", href: "https://talk.nervos.org" },
    { name: "Perun Network", href: "https://perun.network" },
  ],
};

const socialLinks = [
  { name: "X (TEX Labs)", href: "https://x.com/texlabsorg/" },
  { name: "TEX Labs", href: "https://texlabs.org" },
];

export function FooterSection() {
  return (
    <footer className="relative border-t border-foreground/10">
      {/* Animated wave background */}
      <div className="absolute inset-0 h-64 opacity-20 pointer-events-none overflow-hidden">
        <AnimatedWave />
      </div>
      
      <div className="relative z-10 max-w-[1400px] mx-auto px-6 lg:px-12">
        {/* Main Footer */}
        <div className="py-16 lg:py-24">
          <div className="grid grid-cols-2 md:grid-cols-6 gap-12 lg:gap-8">
            {/* Brand Column */}
            <div className="col-span-2">
              <SiteLink href="/" className="inline-flex items-center gap-2 mb-6">
                <span className="text-2xl font-display">CKBolt</span>
                <span className="text-xs text-muted-foreground font-mono">Prototype</span>
              </SiteLink>

              <p className="text-muted-foreground leading-relaxed mb-8 max-w-xs">
                Pay, get paid and swap between Bitcoin Lightning and CKB. A prototype by TEX Labs.
              </p>

              {/* Social Links */}
              <div className="flex gap-6">
                {socialLinks.map((link) => (
                  <a
                    key={link.name}
                    href={link.href}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1 group"
                  >
                    {link.name}
                    <ArrowUpRight className="w-3 h-3 opacity-0 -translate-x-1 group-hover:opacity-100 group-hover:translate-x-0 transition-all" />
                  </a>
                ))}
              </div>
            </div>

            {/* Link Columns */}
            {Object.entries(footerLinks).map(([title, links]) => (
              <div key={title}>
                <h3 className="text-sm font-medium mb-6">{title}</h3>
                <ul className="space-y-4">
                  {links.map((link) => (
                    <li key={link.name}>
                      <SiteLink
                        href={link.href}
                        {...(link.href.startsWith("http") ? { target: "_blank", rel: "noreferrer" } : {})}
                        className="text-sm text-muted-foreground hover:text-foreground transition-colors inline-flex items-center gap-2"
                      >
                        {link.name}
                      </SiteLink>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        {/* Bottom Bar */}
        <div className="py-8 border-t border-foreground/10 flex flex-col md:flex-row items-center justify-between gap-4">
          <p className="text-sm text-muted-foreground">
            &copy; 2026 CKBolt by TEX Labs. Prototype on test networks, not financial advice.
          </p>

          <div className="flex items-center gap-4 text-sm text-muted-foreground">
            <span className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-foreground/40" />
              Live testnet demo: stage 3 of 6
            </span>
          </div>
        </div>
      </div>
    </footer>
  );
}
