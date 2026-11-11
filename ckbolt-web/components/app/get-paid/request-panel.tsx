"use client";

import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { useSharedHubStatus } from "@/hooks/use-hub-status";
import { REQUEST_COPY } from "@/lib/get-paid/copy";
import { fiberPart, type OpenRequest } from "@/lib/get-paid/request";
import { INVOICE_NOTE_MAX_LENGTH } from "@/lib/wallets/fiber-browser/constants";
import { NodeNeeded, nodeRunning, OpenNodeButton } from "../pay/pay-parts";
import { StatusBadge } from "../status";
import { InfoTip } from "../swap/info-tip";
import { ErrorLine } from "../swap/primary-button";
import { useClock } from "../swap/quote-timer";
import { AmountInput, SwapBox } from "../swap/swap-box";
import { TokenButton } from "../swap/token-button";
import { useFiberWalletController } from "../swap/wallets/use-fiber-wallet-controller";
import { RequestView } from "./request-view";
import { useFiberInvoice } from "./use-fiber-invoice";
import { useLightningInvoice } from "./use-lightning-invoice";
import { useRequestForm, type RequestForm } from "./use-request-form";

/**
 * Get paid (docs/pay-get-paid.md, part C), with a live hub: an amount in CKB or a token and an optional note make a request
 * paying the visitor's browser Fiber node. "Create request" makes its Fiber invoice (the node's own; a Fiber payer pays
 * it directly). Its Lightning invoice (the hub's hold invoice of a swap whose payout invoice the node made; any Lightning
 * wallet pays it in BTC, the node receives CKB or a token) is made only when the visitor opens its tab, so a request paid
 * on Fiber leaves no swap at the hub. Two tabs show them with their status, then a receipt once either is paid.
 */
export function RequestPanel({ active }: { active: boolean }) {
  const [open, setOpen] = useState<OpenRequest | null>(null);
  const opened = open !== null;
  // A request keeps the hub status it started with, as a swap does.
  const hub = useSharedHubStatus(true, opened);
  const nowMs = useClock();
  const titleId = useId();
  const controller = useFiberWalletController(hub.health?.fiber.network ?? null, false, { fixedKind: "browser-node", active: active || opened });
  const { presence, checking } = controller.node.view;
  const running = nodeRunning(presence);
  const form = useRequestForm({ hub, fiber: controller.api, running, open: opened });
  const lightning = useLightningInvoice({ fiber: controller.api, health: hub.health, nowMs });
  const fiber = useFiberInvoice(controller.client);

  const create = () => {
    if (!form.request) return;
    const request: OpenRequest = { ...form.request, id: crypto.randomUUID() };
    setOpen(request);
    fiber.make(request);
  };
  // Paid on Fiber: the request no longer needs its Lightning invoice, so an unpaid one is cancelled at the hub.
  const { release: releaseLightning, reset: resetLightning } = lightning;
  const paidOnFiber = opened && fiberPart(fiber.ask, nowMs).status === "paid";
  useEffect(() => {
    if (paidOnFiber) releaseLightning();
  }, [paidOnFiber, releaseLightning]);
  const { reset: resetFiber } = fiber;
  const { clear } = form;
  const newRequest = useCallback(() => {
    resetLightning();
    resetFiber();
    setOpen(null);
    clear();
  }, [resetLightning, resetFiber, clear]);

  return (
    <section aria-labelledby={titleId} className="mx-auto w-full max-w-[480px] border border-foreground/10 bg-background" data-testid="request-card">
      <header className="flex items-center justify-between gap-3 border-b border-foreground/10 px-4 py-3 sm:px-5">
        <h2 id={titleId} className="font-display text-2xl">
          {REQUEST_COPY.TITLE}
        </h2>
        <StatusBadge tone="pending">{REQUEST_COPY.NETWORK_TAG}</StatusBadge>
      </header>
      <div className="p-4 sm:p-5">
        {open ? (
          <RequestView
            request={open}
            lightning={lightning}
            fiber={fiber}
            nowMs={nowMs}
            onMakeLightning={() => lightning.renew(open)}
            onNewFiber={() => fiber.make(open)}
            onNewRequest={newRequest}
          />
        ) : (
          <RequestFormView form={form} running={running} checking={checking} onCreate={create} />
        )}
      </div>
    </section>
  );
}

/** The form: amount and asset (with the hub's conversion under it), an optional note, "Create request". */
function RequestFormView({ form, running, checking, onCreate }: { form: RequestForm; running: boolean; checking: boolean; onCreate: () => void }) {
  const amountId = useId();
  const noteId = useId();
  const errorId = useId();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onCreate();
  };
  const invalidAmount = !form.check.ok && form.check.field === "amount" && form.check.error !== null;
  const invalidNote = !form.check.ok && form.check.field === "note";
  const describedBy = form.error ? errorId : undefined;
  return (
    <form onSubmit={submit} className="space-y-4" noValidate data-testid="request-form">
      <SwapBox
        label={REQUEST_COPY.AMOUNT_LABEL}
        labelFor={amountId}
        wallet={null}
        hint={form.conversion ? <span data-testid="request-conversion">{form.conversion}</span> : null}
        aside={
          <InfoTip label={REQUEST_COPY.CONVERSION_TIP_LABEL} align="end">
            {REQUEST_COPY.CONVERSION_TIP}
          </InfoTip>
        }
        testId="request-amount-box"
      >
        <AmountInput
          id={amountId}
          value={form.amountText}
          onChange={form.setAmountText}
          locked={false}
          invalid={invalidAmount}
          describedBy={describedBy}
          sats={false}
          testId="request-amount"
        />
        <TokenButton side={REQUEST_COPY.TOKEN_SIDE} options={form.assets} value={form.asset} onChange={form.setAsset} testId="request-asset" />
      </SwapBox>
      <div>
        <div className="flex items-center gap-1">
          <label htmlFor={noteId} className="font-mono text-xs text-foreground/70">
            {REQUEST_COPY.NOTE_LABEL}
          </label>
          <InfoTip label={REQUEST_COPY.NOTE_TIP_LABEL} align="start">
            {REQUEST_COPY.NOTE_TIP}
          </InfoTip>
        </div>
        <input
          id={noteId}
          type="text"
          value={form.note}
          onChange={(e) => form.setNote(e.target.value)}
          maxLength={INVOICE_NOTE_MAX_LENGTH}
          autoComplete="off"
          placeholder={REQUEST_COPY.NOTE_PLACEHOLDER}
          aria-invalid={invalidNote}
          aria-describedby={invalidNote ? errorId : undefined}
          className="mt-1 h-11 w-full border border-foreground/15 bg-background px-3 text-sm focus:border-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/25"
          data-testid="request-note"
        />
      </div>
      {!running && !checking && (
        <NodeNeeded page={form.nodePage ?? "home"} line={REQUEST_COPY.NEEDS_NODE} testIds={{ notice: "request-needs-node", button: "request-open-node" }} />
      )}
      <button
        type="submit"
        disabled={form.request === null}
        title={form.request === null && form.error ? form.error.line : undefined}
        className="h-14 w-full rounded-full bg-foreground px-6 text-base font-medium text-background hover:bg-foreground/90 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2"
        data-testid="request-create"
      >
        {REQUEST_COPY.CREATE}
      </button>
      {/* Always in the page, so the error line is announced when it appears; empty, it takes no room. */}
      <div id={errorId} aria-live="polite">
        {form.error && <ErrorLine error={form.error} label={REQUEST_COPY.DETAIL_LABEL} testId="request-error" />}
      </div>
      {running && form.nodePage && (
        <OpenNodeButton page={form.nodePage} testId="request-open-node">
          {REQUEST_COPY.OPEN_NODE}
        </OpenNodeButton>
      )}
    </form>
  );
}
