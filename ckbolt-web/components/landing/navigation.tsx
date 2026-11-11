"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Menu, X } from "lucide-react";
import { FiberWalletButton } from "@/components/app/fiber-wallet/host/wallet-button";
import { SiteLink } from "@/components/site-link";
import { GUIDE_PAGE_PATH } from "@/components/app/guide/constants";
import { APP_PAGE_PATH } from "@/lib/wallets/fiber-browser/constants";

const navLinks = [
  { name: "Problem", href: "/#problem" },
  { name: "Impact on CKB", href: "/#impact" },
  { name: "How it works", href: "/#how-it-works" },
  { name: "Roadmap", href: "/#roadmap" },
  { name: "FAQ", href: "/#faq" },
];

/** The live demo's guide, next to "Open the app". The browser Fiber node is the Fiber node button beside them. */
const demoLinks = [{ name: "Guide", href: GUIDE_PAGE_PATH }];

/**
 * The site's header. `isolatedPage` is the node page (/app/fiber): its links load in full, and it has no wallet button,
 * since the page runs the node itself and an isolated page cannot frame the wallet.
 */
export function Navigation({ isolatedPage = false }: { isolatedPage?: boolean }) {
  const [isScrolled, setIsScrolled] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 20);
    };
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <header
      className={`fixed z-50 transition-all duration-500 ${
        isScrolled
          ? "top-4 left-4 right-4"
          : "top-0 left-0 right-0"
      }`}
    >
      <nav
        className={`mx-auto transition-all duration-500 ${
          isScrolled || isMobileMenuOpen
            ? "bg-background/80 backdrop-blur-xl border border-foreground/10 rounded-2xl shadow-lg max-w-[1200px]"
            : "bg-transparent max-w-[1400px]"
        }`}
      >
        <div
          className={`flex items-center justify-between gap-3 transition-all duration-500 px-6 lg:px-8 ${
            isScrolled ? "h-14" : "h-20"
          }`}
        >
          {/* Logo */}
          <SiteLink href="/" fullLoad={isolatedPage} className="flex items-center gap-2 group">
            <span className={`font-display tracking-tight transition-all duration-500 ${isScrolled ? "text-xl" : "text-2xl"}`}>CKBolt</span>
            <span className={`text-foreground/70 font-mono transition-all duration-500 ${isScrolled ? "text-[10px] mt-0.5" : "text-xs mt-1"}`}>Prototype</span>
          </SiteLink>

          {/* Desktop Navigation (from lg: below it the links and the demo's pages do not fit one row) */}
          <div className="hidden lg:flex items-center gap-8 xl:gap-12">
            {navLinks.map((link) => (
              <SiteLink
                key={link.name}
                href={link.href}
                fullLoad={isolatedPage}
                className="text-sm text-foreground/70 hover:text-foreground transition-colors duration-300 relative group"
              >
                {link.name}
                <span className="absolute -bottom-1 left-0 w-0 h-px bg-foreground transition-all duration-300 group-hover:w-full" />
              </SiteLink>
            ))}
          </div>

          <div className="flex items-center gap-3 lg:gap-4">
            {/* Desktop CTA; "View architecture" from xl, where the row has room for it */}
            <div className="hidden lg:flex items-center gap-4">
              <SiteLink
                href="/#architecture"
                fullLoad={isolatedPage}
                className={`hidden xl:inline text-foreground/70 hover:text-foreground transition-all duration-500 ${isScrolled ? "text-xs" : "text-sm"}`}
              >
                View architecture
              </SiteLink>
              {demoLinks.map((link) => (
                <SiteLink
                  key={link.name}
                  href={link.href}
                  fullLoad={isolatedPage}
                  className={`text-foreground/70 hover:text-foreground whitespace-nowrap transition-all duration-500 ${isScrolled ? "text-xs" : "text-sm"}`}
                >
                  {link.name}
                </SiteLink>
              ))}
              <Button
                asChild
                size="sm"
                className={`bg-foreground hover:bg-foreground/90 text-background rounded-full transition-all duration-500 ${isScrolled ? "px-4 h-8 text-xs" : "px-6"}`}
              >
                <SiteLink href={APP_PAGE_PATH} fullLoad={isolatedPage}>
                  Open the app
                </SiteLink>
              </Button>
            </div>

            {/* The Fiber node, on every width: on a phone it sits beside the menu button. */}
            {!isolatedPage && <FiberWalletButton onOpen={() => setIsMobileMenuOpen(false)} />}

            {/* Mobile Menu Button */}
            <button
              onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
              className="lg:hidden p-2"
              aria-label={isMobileMenuOpen ? "Close menu" : "Open menu"}
              aria-expanded={isMobileMenuOpen}
            >
              {isMobileMenuOpen ? (
                <X className="w-6 h-6" />
              ) : (
                <Menu className="w-6 h-6" />
              )}
            </button>
          </div>
        </div>

      </nav>

      {/* Mobile Menu - Full Screen Overlay */}
      <div
        className={`lg:hidden fixed inset-0 bg-background z-40 transition-all duration-500 ${
          isMobileMenuOpen
            ? "opacity-100 pointer-events-auto"
            : "opacity-0 pointer-events-none"
        }`}
        style={{ top: 0 }}
      >
        <div className="flex flex-col h-full px-8 pt-28 pb-8">
          {/* Navigation Links */}
          <div className="flex-1 flex flex-col justify-center gap-8">
            {navLinks.map((link, i) => (
              <SiteLink
                key={link.name}
                href={link.href}
                fullLoad={isolatedPage}
                onClick={() => setIsMobileMenuOpen(false)}
                className={`text-5xl font-display text-foreground hover:text-muted-foreground transition-all duration-500 ${
                  isMobileMenuOpen
                    ? "opacity-100 translate-y-0"
                    : "opacity-0 translate-y-4"
                }`}
                style={{ transitionDelay: isMobileMenuOpen ? `${i * 75}ms` : "0ms" }}
              >
                {link.name}
              </SiteLink>
            ))}
          </div>

          {/* Bottom CTAs: the guide and the architecture, then the app */}
          <div className={`grid grid-cols-2 gap-4 pt-8 border-t border-foreground/10 transition-all duration-500 ${
            isMobileMenuOpen
              ? "opacity-100 translate-y-0"
              : "opacity-0 translate-y-4"
          }`}
          style={{ transitionDelay: isMobileMenuOpen ? "300ms" : "0ms" }}
          >
            {demoLinks.map((link) => (
              <Button
                key={link.name}
                asChild
                variant="outline"
                className="rounded-full h-14 text-base"
                onClick={() => setIsMobileMenuOpen(false)}
              >
                <SiteLink href={link.href} fullLoad={isolatedPage}>
                  {link.name}
                </SiteLink>
              </Button>
            ))}
            <Button
              asChild
              variant="outline"
              className="rounded-full h-14 text-base"
              onClick={() => setIsMobileMenuOpen(false)}
            >
              <SiteLink href="/#architecture" fullLoad={isolatedPage}>
                Architecture
              </SiteLink>
            </Button>
            <Button
              asChild
              className="col-span-2 bg-foreground text-background rounded-full h-14 text-base"
              onClick={() => setIsMobileMenuOpen(false)}
            >
              <SiteLink href={APP_PAGE_PATH} fullLoad={isolatedPage}>
                Open the app
              </SiteLink>
            </Button>
          </div>
        </div>
      </div>
    </header>
  );
}
