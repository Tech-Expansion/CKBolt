"use client";

import { useId, useRef, useState } from "react";
import { useSharedHubStatus } from "@/hooks/use-hub-status";
import { useSwapRunner } from "@/hooks/use-swap-runner";
import { CARD_COPY, CARD_ERROR } from "@/lib/swap/copy";
import type { RunPresence } from "@/lib/swap/primary-button";
import { isRunSettled } from "@/lib/swap/run-model";
import { useWalletHost } from "../fiber-wallet/host/wallet-host";
import { StatusBadge } from "../status";
import { FlipButton } from "./flip-button";
import { HowItWorksButton } from "./help";
import { LnInvoiceField } from "./ln-invoice-field";
import { OwnInvoiceCommand } from "./own-invoice-command";
import { OwnInvoiceField } from "./own-invoice-field";
import { ErrorLine, PrimaryButton } from "./primary-button";
import { ProgressBanner } from "./progress-banner";
import { ProgressDialog } from "./progress-dialog";
import { QuoteDetails } from "./quote-details";
import { QuoteTimer, useClock } from "./quote-timer";
import { AmountInput, ReceiveFigure, SwapBox } from "./swap-box";
import { LightningToken, TokenButton } from "./token-button";
import { useSwapForm } from "./use-swap-form";
import { useFiberWallet, useWalletDialogs, WalletButton } from "./wallets";

/**
 * The live swap (docs/live-swap-ui.md): a DEX-style card whose one wallet is the visitor's Fiber node. The Lightning
 * side is any wallet: BTC to CKB or a token shows the hub's invoice to pay by QR code; CKB or a token to BTC takes the
 * visitor's own invoice, pasted or scanned, whose amount fixes the swap. "Swap" runs every step it can by itself;
 * explanations sit behind a "?" or How it works.
 */
export function SwapCard() {
  const [runHeld, setRunHeld] = useState(false);
  // A run keeps the hub status it started with, so the card cannot fall back under it.
  const hub = useSharedHubStatus(true, runHeld);
  const fiber = useFiberWallet();
  const { openWalletDialog } = useWalletDialogs();
  const nodeHost = useWalletHost();
  const nowMs = useClock();
  const runner = useSwapRunner({ fiber, health: hub.health, nowMs });
  const { run } = runner;
  const presence: RunPresence = !run ? "none" : isRunSettled(run) ? "settled" : "running";
  const form = useSwapForm({ hub, fiber, nowMs, run: presence });
  const [dialogOpen, setDialogOpen] = useState(false);

  const titleId = useId();
  const amountId = useId();
  const errorId = useId();
  const ownInvoiceInput = useRef<HTMLInputElement>(null);
  const lnInvoiceInput = useRef<HTMLInputElement>(null);

  const health = hub.health;
  const locked = presence !== "none";
  const lightningPays = form.direction === "ln_to_fiber";

  const startSwap = () => {
    if (!form.plan) return;
    runner.start(form.plan);
    setRunHeld(true);
    setDialogOpen(true);
  };
  const putAway = () => {
    runner.reset();
    setRunHeld(false);
    setDialogOpen(false);
    form.renew();
  };

  const press = () => {
    switch (form.primary.action) {
      case "view-progress":
        return setDialogOpen(true);
      case "connect-fiber":
        // The browser node is fixed in the header's Fiber node, on the page that does it; anything else in the dialog.
        return form.nodePage && nodeHost ? nodeHost.show(form.nodePage) : openWalletDialog();
      case "focus-ln-invoice":
        return lnInvoiceInput.current?.focus();
      case "focus-own-invoice":
        return ownInvoiceInput.current?.focus();
      case "refresh-quote":
        return form.quoteState.refresh();
      case "swap":
        return startSwap();
      case "none":
        return;
    }
  };

  // The Fiber node's chip sits on the Fiber side; the Lightning side needs no wallet here.
  const fiberWallet = (
    <div className="min-w-0 shrink">
      <WalletButton disabled={locked} attention={form.nodePage !== null} />
    </div>
  );
  const fiberToken = (side: string, testId: string) => (
    <TokenButton side={side} options={form.assets} value={form.asset} onChange={form.setAsset} disabled={locked} testId={testId} />
  );
  const describedBy = form.error ? errorId : undefined;
  // The quote's countdown sits under the amount it holds.
  const quoteTimer = form.quote ? <QuoteTimer secondsLeft={form.secondsLeft} totalSeconds={form.quoteSeconds} /> : null;

  return (
    <section aria-labelledby={titleId} className="mx-auto w-full max-w-[480px] border border-foreground/10 bg-background" data-testid="swap-card">
      {/* One gutter (px-4, sm:px-5) for the header, the boxes, the details and the button, so their edges line up. */}
      <header className="flex items-center justify-between gap-3 border-b border-foreground/10 px-4 py-3 sm:px-5">
        <div className="flex items-center gap-3">
          <h2 id={titleId} className="font-display text-2xl">
            {CARD_COPY.TITLE}
          </h2>
          <StatusBadge tone="pending">{CARD_COPY.NETWORK_TAG}</StatusBadge>
        </div>
        <HowItWorksButton assets={hub.assets.map((a) => a.symbol)} />
      </header>

      <div className="space-y-3 p-4 sm:p-5">
        <div>
          <SwapBox
            label={CARD_COPY.PAY_LABEL}
            labelFor={amountId}
            wallet={lightningPays ? null : fiberWallet}
            hint={form.payUsd}
            aside={form.payHint}
            testId="swap-pay-box"
          >
            <AmountInput
              id={amountId}
              value={form.amountText}
              onChange={form.setAmountText}
              locked={locked || form.amountFixed}
              invalid={!form.amountFixed && form.amount.status === "invalid"}
              describedBy={describedBy}
              sats={lightningPays}
            />
            {lightningPays ? <LightningToken testId="swap-token-pay" /> : fiberToken(CARD_COPY.PAY_LABEL, "swap-token-pay")}
          </SwapBox>

          <FlipButton onClick={form.flip} disabled={!form.canFlip} blocked={!locked && !form.canFlip} />

          <SwapBox
            label={CARD_COPY.RECEIVE_LABEL}
            wallet={lightningPays ? fiberWallet : null}
            hint={form.receiveUsd}
            aside={quoteTimer}
            testId="swap-receive-box"
            footer={
              form.ownInvoiceNeeded ? (
                <>
                  <OwnInvoiceField
                    value={form.ownInvoiceText}
                    onChange={form.setOwnInvoiceText}
                    tip={form.ownInvoiceTip}
                    network={health?.fiber.network ?? null}
                    invalid={form.ownInvoiceInvalid}
                    locked={locked}
                    describedBy={describedBy}
                    inputRef={ownInvoiceInput}
                  />
                  {form.quote && !locked && <OwnInvoiceCommand quote={form.quote} network={health?.fiber.network ?? null} />}
                </>
              ) : form.lnInvoiceNeeded ? (
                <LnInvoiceField
                  value={form.lnInvoiceText}
                  onChange={form.setLnInvoiceText}
                  tip={form.lnInvoiceTip}
                  placeholder={form.lnInvoicePlaceholder}
                  ask={form.lnInvoiceAsk}
                  invalid={form.lnInvoiceInvalid}
                  locked={locked}
                  describedBy={describedBy}
                  inputRef={lnInvoiceInput}
                />
              ) : null
            }
          >
            <ReceiveFigure text={form.receiveFigure} sats={!lightningPays} />
            {lightningPays ? fiberToken(CARD_COPY.RECEIVE_LABEL, "swap-token-receive") : <LightningToken testId="swap-token-receive" />}
          </SwapBox>
        </div>

        <QuoteDetails direction={form.direction} quote={form.quote} asset={form.asset?.dto ?? null} />

        <div>
          {/* With the progress dialog hidden, its banner takes the button's place: one way back, no second swap. */}
          {run && !dialogOpen ? (
            <ProgressBanner outcome={run.outcome} onView={() => setDialogOpen(true)} />
          ) : (
            <PrimaryButton state={form.primary} onPress={press} describedBy={describedBy} />
          )}
          {/* Always in the page, so the error line is announced when it appears; empty, it takes no room. */}
          <div id={errorId} aria-live="polite">
            {form.error && <ErrorLine error={form.error} label={CARD_ERROR.DETAIL_LABEL} testId="swap-error" className="mt-3" />}
          </div>
        </div>
      </div>

      {run && (
        <ProgressDialog
          open={dialogOpen}
          run={run}
          onHide={() => setDialogOpen(false)}
          onRetry={runner.retry}
          onDone={putAway}
          onPayInBrowser={runner.payInBrowser}
        />
      )}
    </section>
  );
}
