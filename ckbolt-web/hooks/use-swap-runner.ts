"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ManualFiberStep, type FiberWalletApi } from "@/components/app/swap/contracts";
import type { HealthDto, QuoteDto, SwapDto } from "@/lib/hub/contract";
import { RUN_ERROR } from "@/lib/swap/copy";
import { keepSwapRecord, recordOf } from "@/lib/swap/history";
import { createSwapError, fiberPayFailure, fiberStepError, walletError, type ShortError } from "@/lib/swap/errors";
import {
  browserPayError,
  INVOICE_IDLE,
  isRunFinal,
  lightningPayStep,
  nextRunAction,
  PAY_IDLE,
  retryAction,
  runOutcome,
  runSteps,
  type InvoiceStep,
  type PayStep,
  type RetryAction,
  type RunAction,
  type RunInput,
  type RunOutcome,
  type StepView,
} from "@/lib/swap/run-model";
import { webStore } from "@/lib/wallets/fiber-browser/storage";
import { checkHoldInvoice } from "@/lib/wallets/lightning/invoice-check";
import { weblnPayStore, type WeblnPayStore } from "@/lib/wallets/lightning/pay-store";
import { useHubSwap, type CancelTokenSink } from "./use-hub-swap";
import { useWebln } from "./use-webln";

/** What one click on "Swap" runs: a quote the hub signed, and the payout invoice the visitor pasted when there is one. */
export interface SwapPlan {
  quote: QuoteDto;
  /** Display symbol of the quote's Fiber asset. */
  symbol: string;
  /**
   * The payout invoice the visitor pasted, already checked against the quote: their own Lightning invoice (CKB or a token
   * to BTC), or their own Fiber node's (BTC to CKB or a token). Null when the browser node makes it.
   */
  payoutInvoice: string | null;
  /** The Get paid request this swap's payout invoice is for (its id), so the node pairs it with the request's Fiber invoice. */
  request?: string;
}

export interface SwapRun {
  plan: SwapPlan;
  /** The hub's swap once created: the truth about where the run stands. */
  swap: SwapDto | null;
  steps: StepView[];
  outcome: RunOutcome;
  /** Nothing more will change. */
  final: boolean;
  /** What "Try again" does now, or null. `new-quote` is the card's to do: put the run away and quote again. */
  retry: RetryAction | null;
  /**
   * The hub's hold invoice the visitor pays by hand, while the hub waits for it: Lightning (any wallet, BTC to CKB or
   * a token) or Fiber (the own node, CKB or a token to BTC).
   */
  manualInvoice: string | null;
  /**
   * BTC to CKB or a token, while the hold invoice waits: a browser wallet (WebLN) on the page can pay it, and why its last
   * try did not (or null). Null without one, or once it was asked and did not refuse.
   */
  browserWallet: { error: ShortError | null } | null;
  /** The last read of the swap failed; reading goes on. */
  pollError: boolean;
}

export interface SwapRunner {
  run: SwapRun | null;
  /** Starts a run: every step after this happens by itself, except paying a hold invoice by hand. */
  start: (plan: SwapPlan) => void;
  /** Repeats the failed step, when `run.retry` is a step. Never pays twice. */
  retry: () => void;
  /** Asks the browser wallet to pay the hold invoice: once per swap, again only after it refused. */
  payInBrowser: () => void;
  /** Puts the run away. The hub keeps the swap and ends an unpaid one by itself. */
  reset: () => void;
}

export interface SwapRunnerDeps {
  fiber: FiberWalletApi;
  health: HealthDto | null;
  /** The page's clock, for the quote's expiry. */
  nowMs: number;
  webln?: WeblnPayStore;
  /**
   * Takes each swap's cancel token (useHubSwap's CancelTokenSink): only Get paid's Lightning invoice keeps it, to cancel
   * the swap once the request no longer needs it. Without it the token is dropped.
   */
  onCancelToken?: CancelTokenSink;
}

interface ActiveRun {
  id: number;
  plan: SwapPlan;
}

const made = (invoice: string, pasted: boolean): InvoiceStep => ({ status: "made", invoice, pasted });
const failedInvoice = (error: ShortError): InvoiceStep => ({ status: "failed", error });
const MAKING: InvoiceStep = { status: "making" };
const PAYING: PayStep = { status: "paying" };
const SENT: PayStep = { status: "sent" };
const MANUAL: PayStep = { status: "manual" };

/**
 * Runs a live swap from one click (docs/live-swap-ui.md, "The run" and "One wallet"): the payout invoice (pasted, or
 * made by the browser node), the swap with the hub (useHubSwap's start and polling), the payment of the hub's hold
 * invoice (by the browser node, or by the visitor: any Lightning wallet by QR code, a browser wallet, their own Fiber
 * node), then the hub's state until the swap is complete, refunded or cancelled. The steps and what comes next are
 * plain functions of what happened and what the hub says (lib/swap/run-model.ts); this hook only makes the calls they
 * ask for, once each. Every swap it creates is kept, as it moves, where the Fiber node's History reads it
 * (lib/swap/history.ts): the swap card's, Pay's and Get paid's alike.
 */
export function useSwapRunner({ fiber, health, nowMs, webln: weblnStore = weblnPayStore(), onCancelToken }: SwapRunnerDeps): SwapRunner {
  const hubSwap = useHubSwap({ onCancelToken });
  const { reset: resetHubSwap } = hubSwap;
  const webln = useWebln(weblnStore);
  const [active, setActive] = useState<ActiveRun | null>(null);
  const [invoice, setInvoice] = useState<InvoiceStep>(INVOICE_IDLE);
  const [fiberPay, setFiberPay] = useState<PayStep>(PAY_IDLE);
  // The current run's id: an answer for an older run is dropped. Bumped by every start and reset.
  const runId = useRef(0);
  // The calls the run already made by itself, so a re-render never repeats one.
  const issued = useRef(new Set<string>());

  const plan = active?.plan ?? null;
  const direction = plan?.quote.direction ?? null;
  const swap = plan ? hubSwap.swap : null;
  const lightningNetwork = health?.lightning.network ?? null;
  const fiberNetwork = health?.fiber.network ?? null;

  // The hub's Lightning hold invoice (ln_to_fiber), checked against the swap before the page shows it or a wallet pays it.
  const holdInvoice = swap?.pay.network === "lightning" ? swap.pay.invoice : null;
  const holdSats = swap?.pay.network === "lightning" ? swap.pay.amount : null;
  const paymentHash = swap?.paymentHash ?? null;
  const holdCheck = useMemo(
    () =>
      holdInvoice && holdSats && paymentHash
        ? checkHoldInvoice(holdInvoice, { amountSats: holdSats, paymentHash, hubNetwork: lightningNetwork })
        : null,
    [holdInvoice, holdSats, paymentHash, lightningNetwork],
  );

  const attempt = paymentHash ? webln.attempts[paymentHash.toLowerCase()] : undefined;
  const pay: PayStep = direction === "fiber_to_ln" ? fiberPay : swap ? lightningPayStep(attempt, holdCheck) : PAY_IDLE;

  const expiresAt = swap?.quoteExpiresAt ?? plan?.quote.expiresAt ?? null;
  const expired = expiresAt !== null && Date.parse(expiresAt) <= nowMs;
  const createError = useMemo(() => (hubSwap.error ? createSwapError(hubSwap.error) : null), [hubSwap.error]);

  // The swap goes to the node's History as soon as the hub created it, and follows the hub's state there.
  const store = useMemo(() => webStore("localStorage"), []);
  const symbol = plan?.symbol ?? "";
  const held = hubSwap.progress.funded;
  useEffect(() => {
    if (swap && fiberNetwork) keepSwapRecord(store, fiberNetwork, recordOf(swap, symbol, held));
  }, [swap, symbol, held, fiberNetwork, store]);

  const input: RunInput | null = direction
    ? { direction, invoice, creating: hubSwap.starting, createError, swap, progress: hubSwap.progress, pay, expired }
    : null;

  /* ------------------------------------------------------------------------------------------- the calls */

  async function makeInvoice(current: () => boolean) {
    if (!plan) return;
    const { quote, payoutInvoice } = plan;
    if (payoutInvoice) return setInvoice(made(payoutInvoice, true));
    if (quote.direction === "fiber_to_ln") return setInvoice(failedInvoice(walletError(RUN_ERROR.LN_PASTE_INVOICE)));
    setInvoice(MAKING);
    try {
      const text = await fiber.makeInvoice({
        asset: quote.asset,
        amount: quote.receive.amount,
        quoteExpiresAt: quote.expiresAt,
        network: fiberNetwork,
        ...(plan.request ? { request: plan.request } : {}),
      });
      if (current()) setInvoice(made(text, false));
    } catch (e) {
      if (current()) setInvoice(failedInvoice(e instanceof ManualFiberStep ? walletError(RUN_ERROR.FIBER_PASTE_INVOICE) : fiberStepError(e)));
    }
  }

  /** CKB or a token to BTC: the Fiber node pays the hub's Fiber hold invoice (the browser node; the own node by hand). */
  async function payHoldInvoice(current: () => boolean) {
    if (swap?.pay.network !== "fiber") return;
    setFiberPay(PAYING);
    try {
      await fiber.payInvoice({ swapId: swap.id, invoice: swap.pay.invoice });
      if (current()) setFiberPay(SENT);
    } catch (e) {
      if (current()) setFiberPay(e instanceof ManualFiberStep ? MANUAL : fiberPayFailure(e));
    }
  }

  function perform(action: RunAction, id: number) {
    const current = () => runId.current === id;
    switch (action) {
      case "make-invoice":
        void makeInvoice(current);
        return;
      case "create-swap":
        if (plan && invoice.status === "made") void hubSwap.start({ quoteId: plan.quote.id, payoutInvoice: invoice.invoice });
        return;
      case "pay":
        void payHoldInvoice(current);
        return;
    }
  }

  // Each step the run takes by itself, once: the model says what is next after every change.
  const next = input ? nextRunAction(input) : null;
  const activeId = active?.id ?? null;
  useEffect(() => {
    if (!next || activeId === null) return;
    const key = `${activeId}:${next}`;
    if (issued.current.has(key)) return;
    issued.current.add(key);
    perform(next, activeId);
  });

  /* ---------------------------------------------------------------------------------------- the controls */

  const start = useCallback(
    (nextPlan: SwapPlan) => {
      const id = ++runId.current;
      issued.current = new Set();
      resetHubSwap();
      setInvoice(INVOICE_IDLE);
      setFiberPay(PAY_IDLE);
      setActive({ id, plan: nextPlan });
    },
    [resetHubSwap],
  );

  const reset = useCallback(() => {
    runId.current += 1;
    issued.current = new Set();
    resetHubSwap();
    setActive(null);
    setInvoice(INVOICE_IDLE);
    setFiberPay(PAY_IDLE);
  }, [resetHubSwap]);

  // "Try again" acts once per render: a double click before the failure clears cannot repeat a call (a second
  // POST /v1/swaps would leave the first swap behind).
  const retried = useRef(false);
  useEffect(() => {
    retried.current = false;
  });
  const retryWith = input ? retryAction(input) : null;
  const retry = () => {
    if (!active || !retryWith || retryWith === "new-quote" || retried.current) return;
    retried.current = true;
    perform(retryWith, active.id);
  };

  const manualInvoice = pay.status === "manual" && swap?.state === "pending" && !expired ? swap.pay.invoice : null;

  // The page's store records the attempt before it asks the wallet and refuses a second one for this hash.
  const payInBrowser = () => {
    if (!swap || !manualInvoice || !holdCheck?.ok) return;
    void webln.pay(swap.paymentHash, holdCheck.invoice);
  };

  if (!plan || !input) return { run: null, start, retry, payInBrowser, reset };
  const outcome = runOutcome(swap, hubSwap.progress);
  const run: SwapRun = {
    plan,
    swap,
    steps: runSteps(input),
    outcome,
    final: isRunFinal(swap),
    retry: retryWith,
    manualInvoice,
    browserWallet: direction === "ln_to_fiber" && manualInvoice && webln.available ? { error: browserPayError(attempt) } : null,
    pollError: hubSwap.pollError !== null,
  };
  return { run, start, retry, payInBrowser, reset };
}
