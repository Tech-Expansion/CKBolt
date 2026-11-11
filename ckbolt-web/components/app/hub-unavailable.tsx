"use client";

import type { HubStatus } from "@/hooks/use-hub-status";
import { hubStateTone } from "@/lib/status-tone";
import { StatusNotice } from "./status";
import { InfoTip } from "./swap/info-tip";

/** What a tab of /app shows when it cannot run: one line, the reason behind a "?". */
export const HUB_UNAVAILABLE_COPY = {
  CHECKING: "Checking the CKBolt testnet hub…",
  OFFLINE: "The CKBolt testnet hub is not available right now. Try again later.",
  DEGRADED: "The CKBolt testnet hub is reachable but not taking swaps right now.",
  DEGRADED_TIP_LABEL: "Why the hub is not taking swaps",
} as const;

/**
 * Without a live hub, what Get paid, Pay and Swap show instead of their forms: the hub's state in one honest line, in
 * its status colour (lib/status-tone.ts `hubStateTone`). Nothing on /app runs without the hub.
 */
export function HubUnavailable({ hub }: { hub: Pick<HubStatus, "state" | "health"> }) {
  const tone = hubStateTone(hub.state, false);
  if (hub.state === "checking") {
    return (
      <StatusNotice tone={tone} role="status" data-testid="hub-checking">
        {HUB_UNAVAILABLE_COPY.CHECKING}
      </StatusNotice>
    );
  }
  if (hub.state === "degraded") {
    const reason = hub.health?.reason?.trim() || null;
    return (
      <StatusNotice tone={tone} role="status" data-testid="hub-degraded">
        <span className="inline-flex flex-wrap items-center gap-1">
          {HUB_UNAVAILABLE_COPY.DEGRADED}
          {reason && (
            <InfoTip label={HUB_UNAVAILABLE_COPY.DEGRADED_TIP_LABEL} align="start">
              {reason}
            </InfoTip>
          )}
        </span>
      </StatusNotice>
    );
  }
  return (
    <StatusNotice tone={tone} role="status" data-testid="hub-unavailable">
      {HUB_UNAVAILABLE_COPY.OFFLINE}
    </StatusNotice>
  );
}
