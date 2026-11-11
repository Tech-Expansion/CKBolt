"use client";

import { useEffect, useMemo, useState } from "react";
import { useHubQuote } from "@/hooks/use-hub-quote";
import type { HubStatus } from "@/hooks/use-hub-status";
import { useSwapRunner } from "@/hooks/use-swap-runner";
import { assetsServing, toLiveAssets } from "@/lib/hub/assets";
import { API_ERROR_CODE, type CreateQuoteBody, type FiberAssetId, type QuoteDto } from "@/lib/hub/contract";
import { feePercent, formatUnits, secondsUntil } from "@/lib/hub/format";
import { PAY_COPY, PAY_ERROR } from "@/lib/pay/copy";
import { CARD_ERROR } from "@/lib/swap/copy";
import { quoteError, type ShortError } from "@/lib/swap/errors";
import { fiberShortfall, nodeCan } from "@/lib/swap/fiber-liquidity";
import { formatSats, legText } from "@/lib/swap/format";
import { hashKey } from "@/lib/swap/history";
import { checkLimits, quotable } from "@/lib/swap/limits";
import { isRunSettled } from "@/lib/swap/run-model";
import { PAY_TOKENS } from "@/lib/tokens";
import { CKB_ASSET } from "@/lib/wallets/fiber-browser/channels";
import { nodeFixPage } from "@/lib/wallets/fiber-wallet/node-page";
import { outlivesQuote, type PayoutInvoice } from "@/lib/wallets/lightning/invoice-check";
import { LN_WALLET_MESSAGE } from "@/lib/wallets/lightning/messages";
import { ViewInHistory } from "../fiber-wallet/host/view-in-history";
import { InfoTip } from "../swap/info-tip";
import { QuoteTimer } from "../swap/quote-timer";
import { RunView } from "../swap/run-view";
import { TokenButton } from "../swap/token-button";
import { primaryButton, Row } from "../ui";
import { NewPaymentButton, NodeNeeded, nodeRunning, OpenNodeButton, PayButton, PayError, type PayFlowProps } from "./pay-parts";

/** The quote answers this request (a newer request drops it at once, but only after the render that made it). */
const answers = (quote: QuoteDto | null, request: CreateQuoteBody | null): QuoteDto | null =>
  quote && request && quote.direction === request.direction && quote.asset === request.asset && quote.receive.amount === request.amount ? quote : null;

/**
 * Pay a Lightning invoice (docs/pay-get-paid.md, part B): a CKB or a token to BTC swap, exact out by the invoice's amount
 * (`side: "receive"`), run by the swap card's machinery (useSwapRunner) with the invoice as the swap's payout invoice;
 * the browser node pays the hub's hold invoice over the bridge, as for a swap. The swap goes to the node's History.
 */
export function LightningPay({ invoice, hub, fiber, presence, nowMs, onLock, onDone }: PayFlowProps & { invoice: PayoutInvoice; hub: HubStatus }) {
  const runner = useSwapRunner({ fiber, health: hub.health, nowMs });
  const { run } = runner;
  const [assetId, setAssetId] = useState<FiberAssetId | null>(null);

  const liveAssets = useMemo(() => toLiveAssets(hub.assets, PAY_TOKENS), [hub.assets]);
  const assets = useMemo(() => assetsServing(liveAssets, "fiber_to_ln"), [liveAssets]);
  const asset = assets.find((a) => a.dto.id === assetId) ?? assets[0] ?? null;
  const symbol = asset?.token.symbol ?? "";

  const paused = hub.health?.swaps?.paused === true;
  const request = useMemo((): CreateQuoteBody | null => {
    if (!hub.live || paused || !asset) return null;
    if (!quotable({ asset: asset.dto, sats: invoice.sats, fiberUnits: null, knownPrices: null })) return null;
    return { direction: "fiber_to_ln", asset: asset.dto.id, side: "receive", amount: invoice.sats };
  }, [hub.live, paused, asset, invoice.sats]);
  const quoteState = useHubQuote(request);
  const quote = answers(quoteState.quote, request);
  const secondsLeft = quote ? secondsUntil(quote.expiresAt, nowMs) : 0;
  const quoteSeconds = quote ? secondsUntil(quote.expiresAt, Date.parse(quote.createdAt)) : 0;
  const expired = quote !== null && secondsLeft === 0;

  const running = run !== null;
  useEffect(() => {
    onLock(running);
  }, [running, onLock]);

  const limit = asset ? checkLimits({ asset: asset.dto, sats: invoice.sats, fiberUnits: null, quoteErrorCode: quoteState.error?.code ?? null, knownPrices: null }) : null;
  const shortfall = asset
    ? fiberShortfall({ direction: "fiber_to_ln", liquidity: fiber.liquidity, asset: asset.dto.id, payUnits: quote?.pay.amount ?? null, receiveUnits: null })
    : null;
  const tooShort = quote !== null && !outlivesQuote(invoice, quote.expiresAt);
  const nodePage = !fiber.ready || shortfall ? nodeFixPage({ problem: fiber.problem, shortfall, funds: fiber.funds, asset: asset?.dto.id ?? CKB_ASSET }) : null;

  const error = ((): ShortError | null => {
    if (running) return null;
    if (paused || quoteState.error?.code === API_ERROR_CODE.MAINTENANCE) return { line: CARD_ERROR.MAINTENANCE, detail: quoteState.error?.message ?? null };
    if (!asset) return { line: CARD_ERROR.ASSET_UNAVAILABLE, detail: null };
    if (limit?.kind === "min" || limit?.kind === "max" || limit?.kind === "range") {
      return { line: CARD_ERROR.RANGE(formatSats(asset.dto.minSats), formatSats(asset.dto.maxSats)), detail: null };
    }
    if (quoteState.error) return quoteError(quoteState.error);
    if (tooShort) return { line: LN_WALLET_MESSAGE.INVOICE_EXPIRES_TOO_SOON, detail: null };
    if (nodeRunning(presence) && fiber.problem) return { line: fiber.problem, detail: null };
    if (shortfall && asset) {
      const can = nodeCan(fiber.liquidity ?? {}, asset.dto.id, "send");
      return { line: PAY_ERROR.CANNOT_SEND(`${formatUnits(can.toString(), asset.dto.decimals)} ${symbol}`), detail: null };
    }
    return null;
  })();

  const ready = quote !== null && !expired && error === null && fiber.ready && !shortfall;
  const label = quote ? (expired ? PAY_COPY.REFRESH_QUOTE : PAY_COPY.CONFIRM_PAY(legText(quote.pay, symbol))) : PAY_COPY.GETTING_QUOTE;
  const press = () => {
    if (expired) return quoteState.refresh();
    if (!quote || !ready) return;
    runner.start({ quote, symbol, payoutInvoice: invoice.invoice });
  };
  const putAway = () => {
    runner.reset();
    onDone();
  };

  if (run) {
    const settled = isRunSettled(run);
    const retryLabel = run.retry === "new-quote" && !run.swap ? PAY_COPY.NEW_QUOTE : PAY_COPY.RETRY;
    const onRetry = () => {
      if (run.retry !== "new-quote") return runner.retry();
      runner.reset();
      quoteState.refresh();
    };
    return (
      <section aria-label={PAY_COPY.RESULT_LABEL} className="space-y-3" data-testid="pay-result" data-outcome={run.outcome}>
        <RunView run={run} onPayInBrowser={runner.payInBrowser} />
        <div className="flex flex-wrap items-center justify-end gap-3">
          {settled && run.swap && <ViewInHistory entry={{ id: run.swap.id, hash: hashKey(run.swap.paymentHash) }} className="mr-auto" />}
          {run.retry && (
            <button type="button" onClick={onRetry} className={primaryButton}>
              {retryLabel}
            </button>
          )}
          {settled && <NewPaymentButton onPress={putAway} />}
        </div>
      </section>
    );
  }

  return (
    <div className="space-y-4">
      <dl className="border-y border-foreground/10" data-testid="pay-preview" data-kind="lightning">
        <Row label={PAY_COPY.MERCHANT_GETS} value={`${formatSats(invoice.sats)} sats`} />
        <div className="flex items-center justify-between gap-3 border-b border-foreground/5 py-2">
          <dt className="text-sm text-muted-foreground">{PAY_COPY.YOU_PAY}</dt>
          <dd className="flex min-w-0 items-center gap-2">
            <span className="font-mono text-sm tabular-nums [overflow-wrap:anywhere]" data-testid="pay-amount-due">
              {quote ? legText(quote.pay, symbol) : quoteState.loading ? "…" : "—"}
            </span>
            <TokenButton side={PAY_COPY.TOKEN_SIDE} options={assets} value={asset} onChange={setAssetId} testId="pay-token" />
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3 border-b border-foreground/5 py-3">
          <dt className="flex items-center gap-1 text-sm text-muted-foreground">
            {PAY_COPY.FEE}
            <InfoTip label={PAY_COPY.FEE_TIP_LABEL} align="start">
              {PAY_COPY.FEE_TIP}
            </InfoTip>
          </dt>
          <dd className="font-mono text-sm">{quote ? feePercent(quote.feeBps) : "—"}</dd>
        </div>
        <div className="flex items-center justify-between gap-3 py-3">
          <dt className="text-sm text-muted-foreground">{PAY_COPY.QUOTE}</dt>
          <dd className="font-mono text-sm">{quote ? <QuoteTimer secondsLeft={secondsLeft} totalSeconds={quoteSeconds} /> : "—"}</dd>
        </div>
      </dl>
      {!nodeRunning(presence) && <NodeNeeded page={nodePage ?? "home"} />}
      <PayButton label={label} disabled={expired ? false : !ready} onPress={press} />
      <PayError error={error} />
      {nodeRunning(presence) && nodePage && (
        <OpenNodeButton page={nodePage} testId="pay-open-node">
          {PAY_COPY.OPEN_NODE}
        </OpenNodeButton>
      )}
    </div>
  );
}
