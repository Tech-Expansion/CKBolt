"use client";

import { useSharedHubStatus } from "@/hooks/use-hub-status";
import { LIVE_TAG } from "@/lib/hub/constants";
import { PageIntro } from "./page-intro";

/** "CKB, RUSD, or cWBTC": the hub's assets as one phrase. */
const assetList = new Intl.ListFormat("en-US", { type: "disjunction" });

/** The intro's copy: an eyebrow, the heading and one line, per mode. The swap card's "How it works" explains the rest. */
const INTRO_COPY = {
  heading: "Pay, get paid, swap.",
  /** No live hub (none set up, unreachable, degraded, or the first check pending): nothing here runs without one. */
  idle: {
    eyebrow: "Live testnet demo",
    lead: "Real swaps with test money, through the CKBolt testnet hub.",
  },
  live: {
    eyebrow: `${LIVE_TAG}: real swaps with test money`,
    lead: (assets: string) => `Swap BTC on Lightning for ${assets} on Fiber, and back.`,
  },
} as const;

/**
 * The /app page's eyebrow, heading and lead: what the page does by default (no hub, an unreachable or degraded one, or
 * while the first check is pending; the tabs then say the hub is not available) and the hub's assets once it is live.
 */
export function AppIntro() {
  const hub = useSharedHubStatus();
  const assets = assetList.format(hub.assets.map((a) => a.symbol));
  return (
    <PageIntro
      eyebrow={hub.live ? INTRO_COPY.live.eyebrow : INTRO_COPY.idle.eyebrow}
      heading={INTRO_COPY.heading}
      lead={hub.live ? INTRO_COPY.live.lead(assets) : INTRO_COPY.idle.lead}
    />
  );
}
