"use client";

import { Check, Circle } from "lucide-react";

/**
 * A deliverable. `live` marks one of a planned stage that already runs on testnet in an early version, and names where;
 * the stage keeps its status (docs/roadmap.md).
 */
type Item = string | { text: string; live: string };

type Stage = {
  name: string;
  phase: string;
  status: "Done" | "Now" | "Next" | "Planned";
  summary: string;
  items: Item[];
  /** What the stage delivers: the demo or result that shows it is done. */
  outcome: string;
};

const stages: Stage[] = [
  {
    name: "Research and design",
    phase: "Stage 1",
    status: "Done",
    summary: "The design, and every part that can be checked without a hub.",
    items: [
      "Research on Fiber, its Cross-Chain Hub, hold invoices and Perun",
      "Shared-hash design: both legs of a payment locked to one SHA-256 hash",
      "Lightning invoice (BOLT11) codec, checked against the spec's test vectors",
      "Quote maths, product concept and this site",
    ],
    outcome: "A design the next stages build on.",
  },
  {
    name: "Simulated prototype",
    phase: "Stage 2",
    status: "Done",
    summary: "A simulation of the product: the interface for every flow is built, and most functions are demos.",
    items: [
      "Interface for the three flows: get paid, pay and swap",
      "Demo merchant checkout with a QR code, and demo scan to pay",
      "Demo swap quotes both ways for CKB, RUSD and ccBTC, from reference prices",
      "Simulated settlement: each step of a hash-locked payment is shown, no funds move",
      "Testnet wallets connect through CCC, including JoyID, to sign quotes",
    ],
    outcome: "Every user step can be tried as a simulation; no payment is executed.",
  },
  {
    name: "Live testnet swaps",
    phase: "Stage 3",
    status: "Now",
    summary: "Real swaps on testnet between BTC on Lightning and CKB tokens on Fiber, in both directions.",
    items: [
      "CKBolt hub running a Lightning node (LND) and a Fiber node, with channels on both networks",
      "Swap CKB and RUSD to BTC on Lightning, and BTC back to CKB tokens",
      "Both legs held on one SHA-256 hash with hold invoices, refunded if the payout fails",
      "Firm quotes signed by the hub, from a median of exchange prices plus its spread, paid from its own liquidity",
      "Public live demo on testnet",
    ],
    outcome: "Anyone can swap test tokens both ways on the live demo, and a failed payout is refunded.",
  },
  {
    name: "Invoices and merchant payments",
    phase: "Stage 4",
    status: "Planned",
    summary: "CKBolt creates and pays invoices: merchants get paid, and CKB holders pay Lightning.",
    items: [
      {
        text: "Merchant checkout: CKBolt issues a Lightning invoice for the merchant's Fiber invoice; the merchant settles in CKB or a stablecoin",
        live: "Live on testnet, early version: Get paid",
      },
      {
        text: "The reverse: a CKB holder scans a Lightning invoice and pays it with CKB tokens",
        live: "Live on testnet, early version: Pay",
      },
      "Checkout and payment API with webhooks for wallets and POS terminals",
      "Hosted Fiber node option for merchants who do not run one",
      "On-chain BTC into Lightning through submarine swaps",
      "Pilots with merchants, POS providers and wallets",
    ],
    outcome: "A merchant takes a Lightning payment on testnet and receives CKB; a CKB holder pays a Lightning invoice.",
  },
  {
    name: "Ethereum via Perun",
    phase: "Stage 5",
    status: "Planned",
    summary: "ETH as a third network, through Perun state channels.",
    items: [
      "CKB to ETH swaps in a Perun multi-ledger channel, all or nothing for both sides",
      "Builds on Perun's CKB cross-chain support, in development upstream",
      "ETH in the same quote engine, API and app",
    ],
    outcome: "A CKB to ETH swap works on testnet through a Perun channel.",
  },
  {
    name: "Mainnet",
    phase: "Stage 6",
    status: "Planned",
    summary: "Real value, with an audit, limits and monitoring.",
    items: [
      "Independent security audit",
      "Liquidity partners and Cross-Chain Hub operators as sources",
      "Payment limits, monitoring and rebalancing",
      "Multi-hub routing and best-quote selection",
      "SDK for wallets, POS terminals and dApps",
    ],
    outcome: "Audit findings fixed; capped mainnet payments running with monitoring.",
  },
];

export function PricingSection() {
  return (
    <section id="roadmap" className="relative py-32 lg:py-40 border-t border-foreground/10">
      <div className="max-w-[1400px] mx-auto px-6 lg:px-12">
        {/* Header */}
        <div className="max-w-3xl mb-20">
          <span className="font-mono text-xs tracking-widest text-muted-foreground uppercase block mb-6">
            Roadmap
          </span>
          <h2 className="font-display text-5xl md:text-6xl lg:text-7xl tracking-tight text-foreground mb-6">
            From prototype
            <br />
            <span className="text-stroke">to payment network</span>
          </h2>
          <p className="text-lg text-muted-foreground max-w-xl">
            Six stages, each with a concrete result. Stage 3 is where the project is today: a live testnet demo, open to testers.
            Early versions of stage 4&apos;s Get paid and Pay run there too.
          </p>
        </div>

        {/* Stages */}
        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-px bg-foreground/10">
          {stages.map((stage) => {
            const current = stage.status === "Now";
            const done = stage.status === "Done" || current;
            return (
              <div
                key={stage.name}
                className={`relative p-8 lg:p-10 bg-background ${current ? "border-2 border-foreground" : ""}`}
              >
                {current && (
                  <span className="absolute -top-3 left-8 px-3 py-1 bg-foreground text-primary-foreground text-xs font-mono uppercase tracking-widest">
                    We are here
                  </span>
                )}

                {/* Stage header */}
                <div className="mb-6">
                  <span className="font-mono text-xs text-muted-foreground">{stage.phase}</span>
                  <h3 className="font-display text-3xl text-foreground mt-2">{stage.name}</h3>
                  <p className="mt-2 text-sm text-muted-foreground">{stage.summary}</p>
                </div>

                {/* Status */}
                <div className="mb-6 pb-6 border-b border-foreground/10">
                  <span className={`font-display text-4xl ${done || stage.status === "Next" ? "text-foreground" : "text-muted-foreground"}`}>
                    {stage.status}
                  </span>
                </div>

                {/* Deliverables: ticked when delivered or live on testnet early, open circles for what is still to do */}
                <ul className="space-y-3">
                  {stage.items.map((entry) => {
                    const item = typeof entry === "string" ? { text: entry, live: null } : entry;
                    return (
                      <li key={item.text} className="flex items-start gap-3">
                        {done ? (
                          <Check className="w-4 h-4 text-foreground mt-0.5 shrink-0" aria-label="Delivered" />
                        ) : item.live ? (
                          <Check className="w-4 h-4 text-foreground mt-0.5 shrink-0" aria-label="Live on testnet" />
                        ) : (
                          <Circle className="w-3.5 h-3.5 text-muted-foreground mt-1 shrink-0" aria-label="Planned" />
                        )}
                        <span className="text-sm text-muted-foreground">
                          {item.text}
                          {item.live && <span className="block mt-1 font-mono text-xs text-foreground">{item.live}</span>}
                        </span>
                      </li>
                    );
                  })}
                </ul>
                <p className="mt-6 pt-4 border-t border-foreground/10 text-sm">
                  <span className="font-mono text-xs text-muted-foreground block mb-1">Outcome</span>
                  {stage.outcome}
                </p>
              </div>
            );
          })}
        </div>

      </div>
    </section>
  );
}
