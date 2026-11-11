"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import * as Tabs from "@radix-ui/react-tabs";
import { ArrowLeftRight, QrCode, Store } from "lucide-react";
import { useSharedHubStatus } from "@/hooks/use-hub-status";
import { RequestPanel } from "./get-paid/request-panel";
import { HubUnavailable } from "./hub-unavailable";
import { PayPanel } from "./pay/pay-panel";
import { SwapCard } from "./swap/swap-card";
import { FiberWalletProvider } from "./swap/wallets";

type Direction = "receive" | "pay" | "swap";

interface ModeTab {
  id: Direction;
  title: string;
  icon: typeof Store;
}

const DIRECTIONS: readonly ModeTab[] = [
  { id: "receive", title: "Get paid", icon: Store },
  { id: "pay", title: "Pay", icon: QrCode },
  { id: "swap", title: "Swap", icon: ArrowLeftRight },
];

/** The deep-link parameter: /app?mode=receive | pay | swap. */
const MODE_PARAM = "mode";
/** The tab the page opens on without a deep link: Get paid until the hub answers, Swap once it runs live swaps. */
const DEFAULT_MODE: Direction = "receive";
const LIVE_DEFAULT_MODE: Direction = "swap";

const isDirection = (v: string | null): v is Direction => v === "receive" || v === "pay" || v === "swap";

/** A one-line state, as wide as the swap card and centred like it. */
const notice = "mx-auto w-full max-w-[480px]";

/**
 * The /app page's tabs. Everything on them runs through the CKBolt hub with the visitor's Fiber node (the only wallet):
 * Swap is the live swap card, Pay pays a Lightning or Fiber invoice or a CKB address, Get paid makes a request with a
 * Lightning and a Fiber invoice. Without a live hub each tab says so in one line. What they did is in the Fiber node's
 * History (the header's popup), which keeps the swaps they start (lib/swap/history.ts).
 */
export function AppModes() {
  const hub = useSharedHubStatus();
  const live = hub.live;
  const [direction, setDirection] = useState<Direction>(DEFAULT_MODE);
  /** The visitor picked a tab, or the URL named one: the page no longer moves to Swap by itself. */
  const chosen = useRef(false);

  // Deep links: /app?mode=receive | pay | swap (also when a link of the site moves to it client-side).
  const query = useSearchParams().toString();
  useEffect(() => {
    const mode = new URLSearchParams(query).get(MODE_PARAM);
    if (!isDirection(mode)) return;
    chosen.current = true;
    setDirection(mode);
  }, [query]);

  // A live hub makes Swap the page's purpose: open on it, unless the visitor already chose a tab.
  useEffect(() => {
    if (live && !chosen.current) setDirection(LIVE_DEFAULT_MODE);
  }, [live]);

  // A click on the tab already shown is a choice too, although Radix reports no change for it.
  const markChosen = () => {
    chosen.current = true;
  };
  const choose = (d: Direction) => {
    markChosen();
    setDirection(d);
    const url = new URL(window.location.href);
    url.searchParams.set(MODE_PARAM, d);
    window.history.replaceState(null, "", url);
  };

  // Every tab stays mounted, so switching tabs keeps what was typed or quoted.
  const panel = "focus-visible:outline-2 focus-visible:outline-offset-4 data-[state=inactive]:hidden";
  const unavailable = (
    <div className={notice}>
      <HubUnavailable hub={hub} />
    </div>
  );

  return (
    <Tabs.Root value={direction} onValueChange={(v) => isDirection(v) && choose(v)}>
      <Tabs.List aria-label="Mode" className="grid grid-cols-3 gap-px bg-foreground/10 border border-foreground/10 mb-8 lg:mb-10">
        {DIRECTIONS.map((d) => (
          <Tabs.Trigger
            key={d.id}
            value={d.id}
            onClick={markChosen}
            className="group flex flex-col md:flex-row items-center md:items-center gap-2 md:gap-4 p-3 md:p-5 text-center md:text-left motion-safe:transition-colors bg-background hover:bg-foreground/[0.03] data-[state=active]:bg-foreground data-[state=active]:text-background focus-visible:outline-2 focus-visible:-outline-offset-4"
          >
            <d.icon className="w-5 h-5 md:w-7 md:h-7 shrink-0" aria-hidden="true" />
            <span className="block font-display text-lg md:text-2xl">{d.title}</span>
          </Tabs.Trigger>
        ))}
      </Tabs.List>
      <Tabs.Content value="receive" forceMount className={panel} data-testid="mode-receive">
        {live ? <RequestPanel active={direction === "receive"} /> : unavailable}
      </Tabs.Content>
      <Tabs.Content value="pay" forceMount className={panel} data-testid="mode-pay">
        {live ? <PayPanel active={direction === "pay"} /> : unavailable}
      </Tabs.Content>
      <Tabs.Content value="swap" forceMount className={panel} data-testid="mode-swap">
        {live ? (
          <FiberWalletProvider>
            <SwapCard />
          </FiberWalletProvider>
        ) : (
          unavailable
        )}
      </Tabs.Content>
    </Tabs.Root>
  );
}
