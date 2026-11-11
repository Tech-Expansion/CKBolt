"use client";

import { useState } from "react";
import { useHubClient } from "@/hooks/use-hub-client";
import type { SwapDto } from "@/lib/hub/contract";
import { HUB_CLIENT_TIMING } from "@/lib/hub/constants";
import { isSwapFinal } from "@/lib/hub/lifecycle";
import { readSwapRecord, unknownToHub, type SwapRecord } from "@/lib/swap/history";
import { usePolling } from "./use-polling";

/** The swap History's detail shows: its id, the symbol it is kept with, and whether the hub ever held the payment. */
export type SwapToRead = Pick<SwapRecord, "id" | "symbol" | "funded">;

/**
 * A swap of History, read from the hub (GET /v1/swaps/:id through the same-origin proxy) while its detail is open:
 * once, then again every few seconds until it is final. Each read is kept (`onRecord`), so the list and whether the
 * swap still needs the node follow it. `failed`, until a read answers: the hub could not be reached, or has no such
 * swap (another hub, or its data was reset).
 */
export function useSwapRead(
  swap: SwapToRead | null,
  open: boolean,
  onRecord: (record: SwapRecord) => void,
): { read: SwapDto | null; failed: "unreachable" | "unknown" | null } {
  const client = useHubClient();
  const id = swap?.id ?? null;
  const [read, setRead] = useState<SwapDto | null>(null);
  const [failure, setFailure] = useState<{ id: string; unknown: boolean } | null>(null);
  const mine = read && read.id === id ? read : null;
  const unknown = failure?.id === id && failure.unknown;
  usePolling(
    async () => {
      if (!swap) return;
      try {
        const answer = await readSwapRecord(client, swap);
        setRead(answer.swap);
        setFailure(null);
        onRecord(answer.record);
      } catch (e) {
        setFailure({ id: swap.id, unknown: unknownToHub(e) });
      }
    },
    HUB_CLIENT_TIMING.swapPollMs,
    // Until it is final; a swap the hub does not know is not asked again.
    open && id !== null && !(mine && isSwapFinal(mine)) && !unknown,
  );
  return { read: mine, failed: failure?.id === id && !mine ? (failure.unknown ? "unknown" : "unreachable") : null };
}
