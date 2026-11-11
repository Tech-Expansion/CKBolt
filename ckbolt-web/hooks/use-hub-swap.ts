"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toHubApiError, type HubApiError } from "@/lib/hub/client";
import type { CreateSwapBody, SwapDto, SwapEventDto } from "@/lib/hub/contract";
import { HUB_CLIENT_TIMING } from "@/lib/hub/constants";
import { accumulateProgress, isSwapFinal, NO_PROGRESS, type SwapProgress } from "@/lib/hub/lifecycle";
import { useHubClient } from "./use-hub-client";

export interface HubSwapState {
  swap: SwapDto | null;
  /** The hub's event log for the swap, read again whenever the swap changes. */
  events: SwapEventDto[];
  progress: SwapProgress;
  starting: boolean;
  /** Why the swap could not be started. */
  error: HubApiError | null;
  /** Why the last poll failed; polling goes on. */
  pollError: HubApiError | null;
  /** POST /v1/swaps, then GET /v1/swaps/:id every 2 s until the swap is final. `swap` never holds its cancel token. */
  start: (body: CreateSwapBody) => Promise<void>;
  /** Forgets the swap on this page. The hub keeps it and ends it by itself if it is never paid. */
  reset: () => void;
}

/**
 * Takes the cancel token of each swap this hook creates (POST /v1/swaps hands it out once), with whether that swap is
 * still the one the hook follows: false when a reset came first, so nobody will show or follow it. The receiver keeps
 * the token in memory only; without one it is dropped.
 */
export type CancelTokenSink = (swapId: string, cancelToken: string, current: boolean) => void;

export interface HubSwapOptions {
  onCancelToken?: CancelTokenSink;
}

/** Fingerprint of what the user can see change; the event log is read again when it does. */
const changeKey = (swap: SwapDto | null): string | null => (swap ? `${swap.id}|${swap.state}|${swap.refunded}|${swap.updatedAt}` : null);

export function useHubSwap({ onCancelToken }: HubSwapOptions = {}): HubSwapState {
  const client = useHubClient();
  // The latest receiver, read when a swap is created, so `start` stays the same function.
  const sink = useRef(onCancelToken);
  useEffect(() => {
    sink.current = onCancelToken;
  });
  const [swap, setSwap] = useState<SwapDto | null>(null);
  const [events, setEvents] = useState<SwapEventDto[]>([]);
  const [progress, setProgress] = useState<SwapProgress>(NO_PROGRESS);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<HubApiError | null>(null);
  const [pollError, setPollError] = useState<HubApiError | null>(null);
  // Every start or reset begins a new run; answers that belong to an older run are dropped.
  const run = useRef(0);
  // Bumped after a failed poll, so the next one is scheduled although the swap did not change.
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!swap || isSwapFinal(swap)) return;
    const mine = run.current;
    let current = true;
    const timer = setTimeout(async () => {
      try {
        const next = await client.getSwap(swap.id);
        if (!current || mine !== run.current) return;
        setSwap(next);
        setPollError(null);
      } catch (e) {
        if (!current || mine !== run.current) return;
        setPollError(toHubApiError(e));
        setRetry((n) => n + 1);
      }
    }, HUB_CLIENT_TIMING.swapPollMs);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [client, swap, retry]);

  const key = changeKey(swap);
  useEffect(() => {
    if (!swap) return;
    const mine = run.current;
    let current = true;
    client.listSwapEvents(swap.id).then(
      (list) => {
        if (current && mine === run.current) setEvents(list);
      },
      // The log is extra detail; the swap's own state is what the page relies on.
      () => undefined,
    );
    return () => {
      current = false;
    };
    // The log is read again only when the swap visibly changes, not on every poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key]);

  useEffect(() => {
    if (swap) setProgress((p) => accumulateProgress(p, swap, events));
  }, [swap, events]);

  const start = useCallback(
    async (body: CreateSwapBody) => {
      const mine = ++run.current;
      setStarting(true);
      setError(null);
      try {
        // The token goes to the receiver only: the swap the page keeps, shows and stores never carries it.
        const { cancelToken, ...created } = await client.createSwap(body);
        if (typeof cancelToken === "string" && cancelToken) sink.current?.(created.id, cancelToken, mine === run.current);
        if (mine !== run.current) return;
        setSwap(created);
        setEvents([]);
        setProgress(NO_PROGRESS);
        setPollError(null);
      } catch (e) {
        if (mine === run.current) setError(toHubApiError(e));
      } finally {
        if (mine === run.current) setStarting(false);
      }
    },
    [client],
  );

  const reset = useCallback(() => {
    run.current += 1;
    setSwap(null);
    setEvents([]);
    setProgress(NO_PROGRESS);
    setStarting(false);
    setError(null);
    setPollError(null);
  }, []);

  return { swap, events, progress, starting, error, pollError, start, reset };
}
