"use client";

import { useState } from "react";

const faqs: { q: string; a: string }[] = [
  {
    q: "What works today?",
    a: "A live testnet demo, with test money only. Swap BTC on Lightning for CKB or RUSD on Fiber, and back. Pay a Lightning invoice, a Fiber invoice or a CKB address. Get paid from a Lightning or a Fiber wallet. Your Fiber node runs in the browser, and a failed payout is refunded. If the hub is down, the app says so. Not built yet: the payment API, a hosted node, mainnet and a security audit.",
  },
  {
    q: "Is it custodial?",
    a: "Not for people who pay or swap. Each payment is hash-locked, so the hub cannot keep it without paying out, and an unfinished payment goes back to the payer. Hub operators hold their own liquidity.",
  },
  {
    q: "What if a payment fails?",
    a: "The hub cancels the held payment and the payer is refunded. If the payout gets stuck, the funds return when the hold expires: at least 160 minutes on Fiber, and longer on Lightning, whose hold must outlast it.",
  },
  {
    q: "How is this different from Fiber's Cross-Chain Hub?",
    a: "The Cross-Chain Hub links Lightning and Fiber for wrapped BTC at a fixed 1:1 rate. CKBolt adds a price for each route, so native CKB and stablecoins work too. Cross-Chain Hub operators as a liquidity source are planned for stage 6.",
  },
  {
    q: "What if the price moves while a payment is held?",
    a: "The hub carries that risk. Its spread includes a price-risk premium, and each swap has a size limit. Both run on the testnet hub. Neither is audited or tested with real money yet.",
  },
  {
    q: "Does a merchant need to run a node?",
    a: "A Fiber node, yes. On this site it runs in your browser, with nothing to install; a hosted option is planned for stage 4. Merchants never need a Lightning node or BTC.",
  },
  {
    q: "Where do prices come from, and how does CKBolt earn?",
    a: "The examples on this page use CoinGecko, Binance and KuCoin reference prices. A live hub quotes from the median of those exchange prices, with its spread on top, and RUSD at its $1 peg. No CKB DEX or oracle gives a usable price today: UTXOSwap shut down in October 2026. CKBolt earns the spread on each route.",
  },
];

export function FaqSection() {
  const [open, setOpen] = useState(0);

  return (
    <section id="faq" className="relative py-32 lg:py-40 border-t border-foreground/10 lg:pb-14">
      <div className="max-w-[1400px] mx-auto px-6 lg:px-12">
        {/* Section Label */}
        <div className="flex items-center gap-4 mb-16">
          <span className="font-mono text-xs tracking-widest text-muted-foreground uppercase">
            FAQ
          </span>
          <div className="flex-1 h-px bg-foreground/10" />
          <span className="font-mono text-xs text-muted-foreground">
            {String(faqs.length).padStart(2, "0")} questions
          </span>
        </div>

        <div className="grid lg:grid-cols-12 gap-12 lg:gap-20">
          <div className="lg:col-span-5">
            <h2 className="font-display text-4xl md:text-5xl lg:text-6xl leading-[1.1] tracking-tight text-foreground">
              Answered as far as we can.
            </h2>
            <p className="mt-6 text-lg text-muted-foreground">
              Where something is still undecided, the answer says so.
            </p>
          </div>

          <div className="lg:col-span-7">
            {faqs.map((item, idx) => {
              const isOpen = open === idx;
              return (
                <div key={item.q} className="border-b border-foreground/10">
                  <h3>
                    <button
                      type="button"
                      onClick={() => setOpen(isOpen ? -1 : idx)}
                      aria-expanded={isOpen}
                      aria-controls={`faq-panel-${idx}`}
                      className="w-full flex items-center justify-between gap-6 py-6 text-left font-display text-2xl text-foreground"
                    >
                      {item.q}
                      <span className="font-mono text-xl text-muted-foreground" aria-hidden="true">
                        {isOpen ? "–" : "+"}
                      </span>
                    </button>
                  </h3>
                  <div
                    id={`faq-panel-${idx}`}
                    hidden={!isOpen}
                    className="pb-6 text-lg text-muted-foreground leading-relaxed"
                  >
                    {item.a}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
