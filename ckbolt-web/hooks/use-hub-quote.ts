"use client";

import { useCallback, useEffect, useState } from "react";
import { toHubApiError, type HubApiError } from "@/lib/hub/client";
import type { CreateQuoteBody, QuoteDto } from "@/lib/hub/contract";
import { HUB_CLIENT_TIMING } from "@/lib/hub/constants";
import { useHubClient } from "./use-hub-client";

export interface HubQuoteState {
  quote: QuoteDto | null;
  error: HubApiError | null;
  loading: boolean;
  /** Asks the hub for a new quote for the same request. */
  refresh: () => void;
}

interface Answer {
  quote: QuoteDto | null;
  error: HubApiError | null;
  loading: boolean;
}

const IDLE: Answer = { quote: null, error: null, loading: false };
const ASKING: Answer = { quote: null, error: null, loading: true };

/**
 * A firm quote from the hub (POST /v1/quotes) for `request`, in the shape of useRate. A new request drops the old
 * quote at once and asks again after a short pause in typing; null asks for nothing. Expiry is the caller's to show
 * from `quote.expiresAt`: an expired quote is not renewed by itself, because every quote is a promise the hub keeps.
 */
export function useHubQuote(request: CreateQuoteBody | null): HubQuoteState {
  const client = useHubClient();
  const key = request ? JSON.stringify(request) : null;
  const [answer, setAnswer] = useState<Answer>(IDLE);
  const [round, setRound] = useState(0);

  useEffect(() => {
    if (key === null) {
      setAnswer(IDLE);
      return;
    }
    setAnswer(ASKING);
    let current = true;
    const timer = setTimeout(async () => {
      try {
        const quote = await client.createQuote(JSON.parse(key) as CreateQuoteBody);
        if (current) setAnswer({ quote, error: null, loading: false });
      } catch (e) {
        if (current) setAnswer({ quote: null, error: toHubApiError(e), loading: false });
      }
    }, HUB_CLIENT_TIMING.quoteDebounceMs);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [client, key, round]);

  const refresh = useCallback(() => setRound((r) => r + 1), []);
  return { ...answer, refresh };
}
