"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHubClient } from "@/hooks/use-hub-client";
import { useSwapRunner } from "@/hooks/use-swap-runner";
import { REQUEST_LOG } from "@/lib/get-paid/constants";
import { lightningPart, shouldCancelSwap, type LightningPart, type OpenRequest } from "@/lib/get-paid/request";
import { toHubApiError } from "@/lib/hub/client";
import { QUOTE_PURPOSE, type HealthDto, type SwapDto } from "@/lib/hub/contract";
import { secondsUntil } from "@/lib/hub/format";
import { quoteError, type ShortError } from "@/lib/swap/errors";
import { hashKey, keepSwapRecord, recordOf } from "@/lib/swap/history";
import type { EntryRef } from "@/lib/wallets/fiber-browser/history";
import { webStore } from "@/lib/wallets/fiber-browser/storage";
import type { FiberWalletApi } from "../swap/contracts";

export interface LightningInvoice {
  part: LightningPart;
  /** Seconds the quote (and so the hold invoice) was valid for, for the countdown's ring. */
  totalSeconds: number;
  /** The last read of the swap failed; reading goes on. */
  pollError: boolean;
  /** Its swap in the node's History, once the hub created it. */
  entry: EntryRef | null;
  /**
   * A Lightning invoice for `request`: a request quote (`purpose: "request"`, so it lives the hub's request TTL), the
   * node's payout invoice, a new swap. Made when the visitor opens the Lightning tab, and again by "New invoice"; an
   * earlier one nobody paid is cancelled at the hub first.
   */
  renew: (request: OpenRequest) => void;
  /**
   * The request no longer needs a Lightning invoice (it was paid on Fiber): its swap is cancelled at the hub while
   * nobody paid it, now or as soon as the hub creates it. The page keeps following it, so a payer who paid both shows.
   */
  release: () => void;
  /** Forgets it on this page ("New request"), after cancelling its swap at the hub while nobody paid it. */
  reset: () => void;
}

/** A cancel token, and the symbol of its request for the swap's record in History. */
interface HeldToken {
  token: string;
  symbol: string;
}

/**
 * The Lightning invoice of a Get paid request (docs/pay-get-paid.md, part C): an ln_to_fiber swap exact out by the
 * request's amount (`side: "receive"`) on a request quote, run by the swap card's machinery (useSwapRunner): the
 * browser node makes the payout invoice over the bridge, the hub's hold invoice is what the payer pays, and the hub's
 * state says when it is paid. Like every swap the app starts, it goes to the node's History.
 *
 * Each swap's cancel token stays in this hook's memory only: never in React state, storage, History or a bridge
 * message, and never logged. With it the page cancels the swap (POST /v1/swaps/:id/cancel) once the request no longer
 * needs it and the hub last said nobody paid it: paid on Fiber, "New request", or "New invoice" in its place. A cancel
 * that fails is only logged; the node's pairing (it cancels the payout invoice once the request is paid) stays.
 */
export function useLightningInvoice({ fiber, health, nowMs }: { fiber: FiberWalletApi; health: HealthDto | null; nowMs: number }): LightningInvoice {
  const client = useHubClient();
  const network = health?.fiber.network ?? null;
  const store = useMemo(() => webStore("localStorage"), []);
  // The cancel tokens of this page's request swaps, by swap id, until each is used.
  const tokens = useRef(new Map<string, HeldToken>());
  // The request the current round makes an invoice for (its symbol for History), and whether it still wants one.
  const symbol = useRef("");
  const wanted = useRef(true);

  const cancel = useCallback(
    (swapId: string) => {
      const held = tokens.current.get(swapId);
      if (!held) return;
      tokens.current.delete(swapId);
      client.cancelSwap(swapId, held.token).then(
        // The node's History learns at once that the swap is over, so its payout invoice holds the node no more.
        (swap) => {
          if (network) keepSwapRecord(store, network, recordOf(swap, held.symbol, false));
        },
        (e) => console.warn(REQUEST_LOG.CANCEL_FAILED(swapId, toHubApiError(e).message)),
      );
    },
    [client, network, store],
  );

  // A swap created after its round ended (a reset came first) or after the request was paid is cancelled on arrival.
  const onCancelToken = useCallback(
    (swapId: string, token: string, current: boolean) => {
      tokens.current.set(swapId, { token, symbol: symbol.current });
      if (!current || !wanted.current) cancel(swapId);
    },
    [cancel],
  );

  const runner = useSwapRunner({ fiber, health, nowMs, onCancelToken });
  const { run, start, reset: resetRun } = runner;
  const [requested, setRequested] = useState(false);
  const [quoteFailure, setQuoteFailure] = useState<ShortError | null>(null);
  // Every renew or reset starts a new round; a quote that answers an older one is dropped.
  const round = useRef(0);
  // The swap as the hub last answered, for the controls (they may run from an older render's closure).
  const latest = useRef<SwapDto | null>(null);
  useEffect(() => {
    latest.current = run?.swap ?? null;
  });

  const cancelUnpaid = useCallback(() => {
    const swap = latest.current;
    if (swap && shouldCancelSwap(swap)) cancel(swap.id);
  }, [cancel]);

  const renew = useCallback(
    async (request: OpenRequest) => {
      cancelUnpaid();
      const mine = ++round.current;
      symbol.current = request.symbol;
      wanted.current = true;
      resetRun();
      setRequested(true);
      setQuoteFailure(null);
      try {
        const quote = await client.createQuote({
          direction: "ln_to_fiber",
          asset: request.asset,
          side: "receive",
          amount: request.units,
          purpose: QUOTE_PURPOSE.REQUEST,
        });
        if (mine === round.current && wanted.current) start({ quote, symbol: request.symbol, payoutInvoice: null, request: request.id });
      } catch (e) {
        if (mine === round.current) setQuoteFailure(quoteError(toHubApiError(e)));
      }
    },
    [client, start, resetRun, cancelUnpaid],
  );

  const release = useCallback(() => {
    wanted.current = false;
    cancelUnpaid();
  }, [cancelUnpaid]);

  const reset = useCallback(() => {
    release();
    round.current += 1;
    resetRun();
    setRequested(false);
    setQuoteFailure(null);
  }, [release, resetRun]);

  const quote = run?.plan.quote ?? null;
  return {
    part: lightningPart({ quoteError: quoteFailure, run, nowMs, requested }),
    totalSeconds: quote ? secondsUntil(quote.expiresAt, Date.parse(quote.createdAt)) : 0,
    pollError: run !== null && run.pollError && !run.final,
    entry: run?.swap ? { id: run.swap.id, hash: hashKey(run.swap.paymentHash) } : null,
    renew: (request) => void renew(request),
    release,
    reset,
  };
}
