"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useHubQuote, type HubQuoteState } from "@/hooks/use-hub-quote";
import type { HubStatus } from "@/hooks/use-hub-status";
import type { SwapPlan } from "@/hooks/use-swap-runner";
import { localeDecimalMark } from "@/lib/amount";
import { assetsServing, toLiveAssets, type LiveAsset } from "@/lib/hub/assets";
import { API_ERROR_CODE, type CreateQuoteBody, type Direction, type FiberAssetId, type QuoteDto } from "@/lib/hub/contract";
import { formatUnits, secondsUntil } from "@/lib/hub/format";
import { readPayAmount, sanitizeAmountText, unitsToInputText, type PayAmount, type PayUnit } from "@/lib/swap/amount";
import { FLIPPED, SWAP_CARD } from "@/lib/swap/constants";
import { CARD_COPY, CARD_ERROR, LN_INVOICE_COPY, OWN_INVOICE_COPY } from "@/lib/swap/copy";
import { quoteError, type ShortError } from "@/lib/swap/errors";
import { fiberShortfall, nodeCan } from "@/lib/swap/fiber-liquidity";
import { formatSats, legFigure, legText, usdHint } from "@/lib/swap/format";
import { checkLimits, quotable, type LimitIssue } from "@/lib/swap/limits";
import {
  primaryButtonState,
  type LnInvoiceStatus,
  type OwnInvoiceStatus,
  type PrimaryButtonState,
  type QuoteStatus,
  type RunPresence,
} from "@/lib/swap/primary-button";
import { PAY_TOKENS } from "@/lib/tokens";
import { checkByoInvoice, type ByoInvoiceCheck } from "@/lib/wallets/fiber-byo/invoice-check";
import { fiberNetworkOf } from "@/lib/wallets/fiber-byo/network";
import { CKB_ASSET } from "@/lib/wallets/fiber-browser/channels";
import { nodeFixPage, type NodeFixPage } from "@/lib/wallets/fiber-wallet/node-page";
import { bolt11Prefix, checkPayoutInvoice, outlivesQuote, type PayoutInvoiceCheck } from "@/lib/wallets/lightning/invoice-check";
import { LN_WALLET_MESSAGE } from "@/lib/wallets/lightning/messages";
import type { FiberWalletApi } from "./contracts";
import { hubLightningNetworkName } from "./wallets/copy";

/**
 * The swap card's state: direction, Fiber asset, typed amount, the pasted invoices (the visitor's own Lightning invoice
 * for CKB or a token to BTC, the own Fiber node's for BTC to CKB or a token), and everything that follows from them and the
 * Fiber node (the quote, limits, the primary button). Logic lives in lib/swap; this wires it.
 */

export interface SwapFormDeps {
  hub: HubStatus;
  fiber: FiberWalletApi;
  nowMs: number;
  /** The card's run: while there is one, the form is locked to its quote. */
  run: RunPresence;
}

export interface SwapForm {
  direction: Direction;
  /** The Fiber assets the hub serves in this direction, and the chosen one. */
  assets: LiveAsset[];
  asset: LiveAsset | null;
  /** What the pay box's input shows: the typed text, or what the visitor's Lightning invoice needs (read-only). */
  amountText: string;
  /** CKB or a token to BTC: the visitor's invoice fixes the amount, so the pay amount is the quote's and cannot be typed. */
  amountFixed: boolean;
  /** The typed pay amount. */
  amount: PayAmount;
  quote: QuoteDto | null;
  quoteState: HubQuoteState;
  secondsLeft: number;
  /** Seconds the current quote was valid for, for the timer's ring. */
  quoteSeconds: number;
  /** The figure in the receive box: the invoice's or the quote's amount, "…" while asking, "—" without one. */
  receiveFigure: string;
  payUsd: string | null;
  receiveUsd: string | null;
  /** Under the pay amount: the per-swap maximum in sats, or what the browser node can send. */
  payHint: string | null;
  canFlip: boolean;
  /** Own node, BTC to Fiber: the payout invoice field. */
  ownInvoiceNeeded: boolean;
  ownInvoiceText: string;
  /** The pasted invoice does not fit the quote. */
  ownInvoiceInvalid: boolean;
  ownInvoiceTip: string;
  /** CKB or a token to BTC: the visitor's own Lightning invoice field. */
  lnInvoiceNeeded: boolean;
  lnInvoiceText: string;
  /** The page refuses the pasted invoice (the error line says why). */
  lnInvoiceInvalid: boolean;
  lnInvoiceTip: string;
  lnInvoicePlaceholder: string;
  /** Under the field, while no invoice fixes the amount but a typed one was quoted: the invoice to make. */
  lnInvoiceAsk: string | null;
  /** The card's one error line. */
  error: ShortError | null;
  primary: PrimaryButtonState;
  /** The Fiber node popup's page that fixes the browser node when the primary button asks for it, or null (the dialog then). */
  nodePage: NodeFixPage | null;
  /** What "Swap" runs now, or null when it cannot. */
  plan: SwapPlan | null;
  setAmountText: (text: string) => void;
  setAsset: (id: FiberAssetId) => void;
  setOwnInvoiceText: (text: string) => void;
  setLnInvoiceText: (text: string) => void;
  flip: () => void;
  /** A run ended: quote again for the same amount, and forget the spent invoices. */
  renew: () => void;
}

const LIGHTNING_UNIT: PayUnit = { network: "lightning", decimals: 0 };

/** The pasted own-node invoice against the quote; null when there is no field or no quote to check it against. */
function ownInvoiceCheck(needed: boolean, text: string, quote: QuoteDto | null, asset: LiveAsset | null, network: string | null): ByoInvoiceCheck | null {
  if (!needed || !quote || !asset) return null;
  return checkByoInvoice(text, {
    network: fiberNetworkOf(network),
    amount: quote.receive.amount,
    decimals: quote.receive.decimals,
    symbol: asset.token.symbol,
  });
}

const ownInvoiceStatus = (needed: boolean, check: ByoInvoiceCheck | null): OwnInvoiceStatus =>
  !needed ? "not-needed" : !check ? "unchecked" : check.status === "ok" ? "ok" : "missing";

function quoteStatus(state: HubQuoteState, quote: QuoteDto | null, expired: boolean): QuoteStatus {
  if (state.error) return "failed";
  if (state.loading || !quote) return "loading";
  return expired ? "expired" : "ready";
}

/** The quote answers this request (a newer request drops it at once, but only after the render that made it). */
const answers = (quote: QuoteDto | null, request: CreateQuoteBody | null): QuoteDto | null =>
  quote &&
  request &&
  quote.direction === request.direction &&
  quote.asset === request.asset &&
  (request.side === "pay" ? quote.pay.amount : quote.receive.amount) === request.amount
    ? quote
    : null;

/**
 * The card's error line: the hub's maintenance, a refused Lightning invoice, the range or liquidity behind a refused
 * amount, a refused quote, or a pasted Fiber invoice that does not fit.
 */
function formError(
  paused: boolean,
  lnError: ShortError | null,
  limit: LimitIssue | null,
  state: HubQuoteState,
  asset: LiveAsset | null,
  own: ByoInvoiceCheck | null,
): ShortError | null {
  if (paused) return { line: CARD_ERROR.MAINTENANCE, detail: state.error?.message ?? null };
  if (lnError) return lnError;
  if (limit?.kind === "range" && asset) {
    return { line: CARD_ERROR.RANGE(formatSats(asset.dto.minSats), formatSats(asset.dto.maxSats)), detail: state.error?.message ?? null };
  }
  if (limit?.kind === "liquidity" && state.error) return quoteError(state.error);
  if (limit) return null;
  if (state.error) return quoteError(state.error);
  if (own?.status === "invalid") return { line: OWN_INVOICE_COPY.INVALID, detail: own.error };
  return null;
}

/** The pasted Lightning invoice's refusal, or one that expires before the quote does. */
function lnInvoiceError(read: PayoutInvoiceCheck | null, tooShort: boolean): ShortError | null {
  if (read && !read.ok) return { line: read.line, detail: read.detail };
  return tooShort ? { line: LN_WALLET_MESSAGE.INVOICE_EXPIRES_TOO_SOON, detail: null } : null;
}

export function useSwapForm({ hub, fiber, nowMs, run }: SwapFormDeps): SwapForm {
  const running = run !== "none";
  const [direction, setDirection] = useState<Direction>(SWAP_CARD.defaultDirection);
  const [assetId, setAssetId] = useState<FiberAssetId | null>(null);
  const [amountText, setAmountTextRaw] = useState("");
  const [ownInvoiceText, setOwnInvoiceText] = useState("");
  const [lnInvoiceText, setLnInvoiceText] = useState("");
  /** Prices the hub quoted each asset with, to size a refused Fiber amount against the per-swap limits. */
  const [knownPrices, setKnownPrices] = useState<Partial<Record<FiberAssetId, QuoteDto["prices"]>>>({});
  // Read once in the browser; only parsing uses it, so the server's answer never shows.
  const decimalMark = useMemo(() => localeDecimalMark(), []);

  const liveAssets = useMemo(() => toLiveAssets(hub.assets, PAY_TOKENS), [hub.assets]);
  const assets = useMemo(() => assetsServing(liveAssets, direction), [liveAssets, direction]);
  const asset = assets.find((a) => a.dto.id === assetId) ?? assets[0] ?? null;
  const flippedAssets = useMemo(() => assetsServing(liveAssets, FLIPPED[direction]), [liveAssets, direction]);

  const assetDecimals = asset?.dto.decimals ?? 0;
  const payUnit: PayUnit = useMemo(
    () => (direction === "ln_to_fiber" ? LIGHTNING_UNIT : { network: "fiber", decimals: assetDecimals }),
    [direction, assetDecimals],
  );
  const amount = useMemo(() => readPayAmount(amountText, payUnit, decimalMark), [amountText, payUnit, decimalMark]);
  const units = amount.status === "ok" ? amount.units : null;
  const assetPrices = asset ? (knownPrices[asset.dto.id] ?? null) : null;

  // CKB or a token to BTC: the visitor's own invoice, read in the page; a valid one fixes the swap's amount (exact out).
  const lnInvoiceNeeded = direction === "fiber_to_ln";
  const lightningNetwork = hub.health?.lightning.network ?? null;
  const lnRead = useMemo(
    () => (lnInvoiceNeeded && lnInvoiceText.trim() ? checkPayoutInvoice(lnInvoiceText, { hubNetwork: lightningNetwork, nowMs }) : null),
    [lnInvoiceNeeded, lnInvoiceText, lightningNetwork, nowMs],
  );
  const lnInvoice = lnRead?.ok ? lnRead.value : null;
  const invoiceSats = lnInvoice?.sats ?? null;
  // The Lightning leg when the page knows it exactly; otherwise the typed Fiber amount, which the hub sizes.
  const sats = direction === "ln_to_fiber" ? units : invoiceSats;
  const fiberUnits = direction === "fiber_to_ln" && invoiceSats === null ? units : null;

  // The hub's maintenance switch (GET /v1/health `swaps.paused`): no quote is asked for until its health says otherwise.
  const pausedByHealth = hub.health?.swaps?.paused === true;
  const request = useMemo((): CreateQuoteBody | null => {
    if (!hub.live || pausedByHealth || !asset) return null;
    if (!quotable({ asset: asset.dto, sats, fiberUnits, knownPrices: null })) return null;
    if (invoiceSats !== null) return { direction, asset: asset.dto.id, side: "receive", amount: invoiceSats };
    return units !== null ? { direction, asset: asset.dto.id, side: "pay", amount: units } : null;
  }, [hub.live, pausedByHealth, asset, direction, sats, fiberUnits, invoiceSats, units]);
  const quoteState = useHubQuote(request);
  const quote = answers(quoteState.quote, request);
  const paused = pausedByHealth || quoteState.error?.code === API_ERROR_CODE.MAINTENANCE;

  useEffect(() => {
    if (quote) setKnownPrices((known) => ({ ...known, [quote.asset]: quote.prices }));
  }, [quote]);

  const secondsLeft = quote ? secondsUntil(quote.expiresAt, nowMs) : 0;
  const quoteSeconds = quote ? secondsUntil(quote.expiresAt, Date.parse(quote.createdAt)) : 0;
  const expired = quote !== null && secondsLeft === 0;

  const limit = asset ? checkLimits({ asset: asset.dto, sats, fiberUnits, quoteErrorCode: quoteState.error?.code ?? null, knownPrices: assetPrices }) : null;
  const payUnits = direction === "fiber_to_ln" ? (invoiceSats !== null ? (quote?.pay.amount ?? null) : units) : null;
  const shortfall =
    asset && fiber.kind === "browser-node"
      ? fiberShortfall({
          direction,
          liquidity: fiber.liquidity,
          asset: asset.dto.id,
          payUnits,
          receiveUnits: direction === "ln_to_fiber" ? (quote?.receive.amount ?? null) : null,
        })
      : null;

  const ownInvoiceNeeded = fiber.kind === "own-node" && direction === "ln_to_fiber";
  const own = ownInvoiceCheck(ownInvoiceNeeded, ownInvoiceText, quote, asset, hub.health?.fiber.network ?? null);
  const symbol = asset?.token.symbol ?? "";

  // The hub refuses an invoice that expires before the quote (assertInvoiceOutlivesQuote): checked once there is one.
  const lnTooShort = lnInvoice !== null && quote !== null && !outlivesQuote(lnInvoice, quote.expiresAt);
  const lnStatus: LnInvoiceStatus = !lnInvoiceNeeded ? "not-needed" : !lnInvoiceText.trim() ? "missing" : !lnInvoice || lnTooShort ? "invalid" : "ok";
  const lnError = lnInvoiceNeeded ? lnInvoiceError(lnRead, lnTooShort) : null;

  const primary = primaryButtonState({
    run,
    hubLive: hub.live && asset !== null,
    paused,
    amount: invoiceSats !== null ? "ok" : amount.status,
    limit,
    fiber: { chosen: fiber.kind !== null, ready: fiber.ready, problem: fiber.problem },
    shortfall,
    symbol,
    lnInvoice: lnStatus,
    ownInvoice: ownInvoiceStatus(ownInvoiceNeeded, own),
    quote: quoteStatus(quoteState, quote, expired),
  });

  const canSend = asset && direction === "fiber_to_ln" && fiber.kind === "browser-node" && fiber.liquidity ? nodeCan(fiber.liquidity, asset.dto.id, "send") : null;
  const payHint =
    direction === "ln_to_fiber"
      ? asset
        ? CARD_COPY.MAX_SATS(formatSats(asset.dto.maxSats))
        : null
      : canSend !== null
        ? CARD_COPY.CAN_SEND(formatUnits(canSend.toString(), assetDecimals), symbol)
        : null;

  const setAmountText = useCallback((text: string) => setAmountTextRaw(sanitizeAmountText(text)), []);
  const setAsset = useCallback((id: FiberAssetId) => setAssetId(id), []);

  const canFlip = !running && flippedAssets.length > 0;
  const flip = () => {
    if (!canFlip) return;
    const nextDirection = FLIPPED[direction];
    const keep = asset && flippedAssets.some((a) => a.dto.id === asset.dto.id) ? asset.dto.id : (flippedAssets[0]?.dto.id ?? null);
    // As on a DEX, what was received becomes what is paid; without a quote there is nothing to carry.
    const carried = quote ? unitsToInputText(quote.receive.amount, { network: quote.receive.network, decimals: quote.receive.decimals }, decimalMark) : "";
    setDirection(nextDirection);
    setAssetId(keep);
    setAmountTextRaw(carried);
  };

  const { refresh } = quoteState;
  const renew = useCallback(() => {
    setOwnInvoiceText("");
    setLnInvoiceText("");
    refresh();
  }, [refresh]);

  const nodePage =
    fiber.kind === "browser-node" && primary.action === "connect-fiber"
      ? nodeFixPage({ problem: fiber.problem, shortfall, funds: fiber.funds, asset: asset?.dto.id ?? CKB_ASSET })
      : null;

  const payoutInvoice = lnInvoiceNeeded ? (lnStatus === "ok" ? (lnInvoice?.invoice ?? null) : null) : own?.status === "ok" ? own.invoice : null;
  const plan: SwapPlan | null =
    primary.action === "swap" && quote && asset && (!lnInvoiceNeeded || payoutInvoice !== null) ? { quote, symbol, payoutInvoice } : null;

  const loadingFigure = quoteState.loading ? CARD_COPY.LOADING_AMOUNT : CARD_COPY.EMPTY_AMOUNT;
  const amountFixed = invoiceSats !== null;

  return {
    direction,
    assets,
    asset,
    amountText: amountFixed ? (quote ? legFigure(quote.pay) : loadingFigure) : amountText,
    amountFixed,
    amount,
    quote,
    quoteState,
    secondsLeft,
    quoteSeconds,
    receiveFigure: invoiceSats !== null ? formatSats(invoiceSats) : quote ? legFigure(quote.receive) : loadingFigure,
    payUsd: quote ? usdHint(quote.pay, quote.prices) : null,
    receiveUsd: quote ? usdHint(quote.receive, quote.prices) : null,
    payHint,
    canFlip,
    ownInvoiceNeeded,
    ownInvoiceText,
    ownInvoiceInvalid: own?.status === "invalid",
    ownInvoiceTip: quote ? OWN_INVOICE_COPY.TIP(legText(quote.receive, symbol)) : OWN_INVOICE_COPY.TIP_NO_QUOTE,
    lnInvoiceNeeded,
    lnInvoiceText,
    lnInvoiceInvalid: lnStatus === "invalid",
    lnInvoiceTip: LN_INVOICE_COPY.TIP(hubLightningNetworkName(lightningNetwork)),
    lnInvoicePlaceholder: LN_INVOICE_COPY.PLACEHOLDER(bolt11Prefix(lightningNetwork)),
    lnInvoiceAsk: lnInvoiceNeeded && invoiceSats === null && quote ? LN_INVOICE_COPY.ASK(formatSats(quote.receive.amount)) : null,
    error: running ? null : formError(paused, lnError, limit, quoteState, asset, own),
    primary,
    nodePage,
    plan,
    setAmountText,
    setAsset,
    setOwnInvoiceText,
    setLnInvoiceText,
    flip,
    renew,
  };
}
