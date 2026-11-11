"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useHubQuote, type HubQuoteState } from "@/hooks/use-hub-quote";
import type { HubStatus } from "@/hooks/use-hub-status";
import { localeDecimalMark } from "@/lib/amount";
import { REQUEST_COPY, REQUEST_ERROR } from "@/lib/get-paid/copy";
import { checkRequestForm, rangeError, requestLimit, type OpenRequest, type RequestFormCheck } from "@/lib/get-paid/request";
import { assetsServing, toLiveAssets, type LiveAsset } from "@/lib/hub/assets";
import { API_ERROR_CODE, QUOTE_PURPOSE, type CreateQuoteBody, type FiberAssetId, type QuoteDto } from "@/lib/hub/contract";
import { formatUnits } from "@/lib/hub/format";
import { sanitizeAmountText } from "@/lib/swap/amount";
import { CARD_ERROR } from "@/lib/swap/copy";
import { quoteError, type ShortError } from "@/lib/swap/errors";
import { fiberShortfall, nodeCan } from "@/lib/swap/fiber-liquidity";
import { formatSats, usdHint } from "@/lib/swap/format";
import { PAY_TOKENS } from "@/lib/tokens";
import { CKB_ASSET } from "@/lib/wallets/fiber-browser/channels";
import { nodeFixPage, type NodeFixPage } from "@/lib/wallets/fiber-wallet/node-page";
import type { FiberWalletApi } from "../swap/contracts";

export interface RequestFormDeps {
  hub: HubStatus;
  fiber: FiberWalletApi;
  /** The node tab runs the node now. */
  running: boolean;
  /** A request is open: the form asks the hub for nothing. */
  open: boolean;
}

export interface RequestForm {
  assets: LiveAsset[];
  asset: LiveAsset | null;
  amountText: string;
  note: string;
  check: RequestFormCheck;
  /** "≈ $2.00 · 2,526 sats on Lightning" from the hub's request quote, "…" while it is asked, or null. */
  conversion: string | null;
  /** The form's one error line. */
  error: ShortError | null;
  /** The popup's page that fixes the node for this request, or null. */
  nodePage: NodeFixPage | null;
  /** What "Create request" opens now, or null when it cannot. */
  /** The request the form makes, without its id (drawn at Create). */
  request: Omit<OpenRequest, "id"> | null;
  setAmountText: (text: string) => void;
  setNote: (text: string) => void;
  setAsset: (id: FiberAssetId) => void;
  /** After a request: a blank form, the asset kept. */
  clear: () => void;
}

/** The quote answers this request (a newer request drops it at once, but only after the render that made it). */
const answers = (quote: QuoteDto | null, request: CreateQuoteBody | null): QuoteDto | null =>
  quote && request && quote.direction === request.direction && quote.asset === request.asset && quote.receive.amount === request.amount ? quote : null;

/**
 * Get paid's form (docs/pay-get-paid.md, part C): an amount in the asset received, the asset (CKB or a token), an optional
 * note. The hub quotes the amount (ln_to_fiber, `side: "receive"`, `purpose: "request"`, so with the request's own fee,
 * the price the Lightning invoice would ask) for the conversion line and the per-swap limits, which apply to the
 * request's Lightning invoice; the node must run, reach the hub and be able to receive the amount over its channels with
 * the hub.
 */
export function useRequestForm({ hub, fiber, running, open }: RequestFormDeps): RequestForm {
  const [assetId, setAssetId] = useState<FiberAssetId | null>(null);
  const [amountText, setAmountTextRaw] = useState("");
  const [note, setNote] = useState("");
  /** Prices the hub quoted each asset with, to size a refused amount against the per-swap limits. */
  const [knownPrices, setKnownPrices] = useState<Partial<Record<FiberAssetId, QuoteDto["prices"]>>>({});
  // Read once in the browser; only parsing uses it.
  const decimalMark = useMemo(() => localeDecimalMark(), []);

  const liveAssets = useMemo(() => toLiveAssets(hub.assets, PAY_TOKENS), [hub.assets]);
  const assets = useMemo(() => assetsServing(liveAssets, "ln_to_fiber"), [liveAssets]);
  const asset = assets.find((a) => a.dto.id === assetId) ?? assets[0] ?? null;
  const symbol = asset?.token.symbol ?? "";
  const decimals = asset?.dto.decimals ?? 0;

  const check = useMemo(() => checkRequestForm({ amountText, note, decimals, symbol, decimalMark }), [amountText, note, decimals, symbol, decimalMark]);
  const units = check.ok ? check.units : null;

  const paused = hub.health?.swaps?.paused === true;
  const quoteBody = useMemo(
    (): CreateQuoteBody | null =>
      hub.live && !paused && !open && asset && units
        ? { direction: "ln_to_fiber", asset: asset.dto.id, side: "receive", amount: units, purpose: QUOTE_PURPOSE.REQUEST }
        : null,
    [hub.live, paused, open, asset, units],
  );
  const quoteState: HubQuoteState = useHubQuote(quoteBody);
  const quote = answers(quoteState.quote, quoteBody);
  useEffect(() => {
    if (quote) setKnownPrices((known) => ({ ...known, [quote.asset]: quote.prices }));
  }, [quote]);

  const limit =
    asset && units
      ? requestLimit({ asset: asset.dto, units, quote, quoteErrorCode: quoteState.error?.code ?? null, knownPrices: knownPrices[asset.dto.id] ?? null })
      : null;
  const shortfall = asset && units ? fiberShortfall({ direction: "ln_to_fiber", liquidity: fiber.liquidity, asset: asset.dto.id, payUnits: null, receiveUnits: units }) : null;
  const nodePage = running && (!fiber.ready || shortfall) ? nodeFixPage({ problem: fiber.problem, shortfall, funds: fiber.funds, asset: asset?.dto.id ?? CKB_ASSET }) : null;

  const error = ((): ShortError | null => {
    if (paused || quoteState.error?.code === API_ERROR_CODE.MAINTENANCE) return { line: CARD_ERROR.MAINTENANCE, detail: quoteState.error?.message ?? null };
    if (!asset) return { line: CARD_ERROR.ASSET_UNAVAILABLE, detail: null };
    if (!check.ok) return check.error ? { line: check.error, detail: null } : null;
    const range = rangeError(limit, asset.dto);
    if (range) return range;
    if (quoteState.error) return quoteError(quoteState.error);
    if (running && fiber.problem) return { line: fiber.problem, detail: null };
    if (shortfall) return { line: REQUEST_ERROR.CANNOT_RECEIVE(`${formatUnits(nodeCan(fiber.liquidity ?? {}, asset.dto.id, "receive").toString(), decimals)} ${symbol}`), detail: null };
    return null;
  })();

  const ready = check.ok && quote !== null && error === null && running && fiber.ready && !shortfall && asset !== null;
  const request: Omit<OpenRequest, "id"> | null = ready && asset && check.ok ? { asset: asset.dto.id, units: check.units, symbol, decimals, note: check.note } : null;

  const setAmountText = useCallback((text: string) => setAmountTextRaw(sanitizeAmountText(text)), []);
  const setAsset = useCallback((id: FiberAssetId) => setAssetId(id), []);
  const clear = useCallback(() => {
    setAmountTextRaw("");
    setNote("");
  }, []);

  return {
    assets,
    asset,
    amountText,
    note,
    check,
    conversion: quote ? REQUEST_COPY.CONVERSION(usdHint(quote.receive, quote.prices), formatSats(quote.pay.amount)) : quoteState.loading ? "…" : null,
    error,
    nodePage,
    request,
    setAmountText,
    setNote,
    setAsset,
    clear,
  };
}
