"use client";

import { useId, useState, type FormEvent } from "react";
import type { ConfirmOutcome, PendingConfirmation } from "@/lib/wallets/fiber-browser/confirmations";
import { CKB_ASSET } from "@/lib/wallets/fiber-browser/channels";
import type { StatusTone } from "@/lib/status-tone";
import { StatusNotice } from "../status";
import { InfoTip } from "../swap/info-tip";
import { primaryButton, Row, secondaryButton, shorten } from "../ui";
import { CONFIRM_COPY } from "./copy";
import type { HistoryNames } from "./history-list";
import { useSecretReset } from "./secret-reset";
import { textInput } from "./styles";
import type { Confirmations } from "./use-confirmations";

const OUTCOME_TONE: Readonly<Record<ConfirmOutcome["status"], StatusTone>> = { sent: "ok", declined: "off", expired: "off", failed: "error" };

const when = (ms: number): string => new Date(ms).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

/**
 * What the app asked the node for, put up for the visitor (docs/pay-get-paid.md, part B): a Fiber payment (amount and
 * token, payee, its route, max fee) or an on-chain send (amount, address, fee, and the node's password, which never leaves this
 * page). Confirm runs it; Decline refuses it. Without a request, how the last one ended, or "Nothing to confirm."
 */
export function ConfirmRequest({ confirmations, names }: { confirmations: Confirmations; names: HistoryNames }) {
  const { pending, last } = confirmations;
  return (
    <div className="space-y-4" data-testid="fiber-wallet-confirm">
      {pending ? (
        // A new request gets a fresh form: nothing typed for the last one carries over.
        <PendingRequest key={pending.id} pending={pending} confirmations={confirmations} names={names} />
      ) : last ? (
        <StatusNotice tone={OUTCOME_TONE[last.status]} role="status" data-testid="fiber-wallet-confirm-outcome" data-status={last.status}>
          <p>{CONFIRM_COPY.OUTCOME[last.status]}</p>
          {last.message && <p className="mt-1 font-mono text-xs [overflow-wrap:anywhere]">{last.message}</p>}
        </StatusNotice>
      ) : (
        <StatusNotice tone="off" role="status" data-testid="fiber-wallet-confirm-empty">
          {CONFIRM_COPY.EMPTY}
        </StatusNotice>
      )}
    </div>
  );
}

function PendingRequest({ pending, confirmations, names }: { pending: PendingConfirmation; confirmations: Confirmations; names: HistoryNames }) {
  const { view } = pending;
  const onChain = view.kind === "on-chain";
  const [password, setPassword] = useState("");
  const passwordId = useId();
  const errorId = useId();
  useSecretReset(() => setPassword(""));

  const asset = view.kind === "fiber-payment" ? view.asset : CKB_ASSET;
  const amount = names.amount(asset, view.amount);
  const canConfirm = !pending.running && (!onChain || password.length > 0);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canConfirm) return;
    const typed = onChain ? password : null;
    // The password is typed again for any next try: it never stays in the form.
    setPassword("");
    void confirmations.confirm(pending.id, typed);
  };

  return (
    <form onSubmit={submit} className="space-y-4" data-testid="fiber-wallet-confirm-request" data-kind={view.kind} noValidate>
      <p className="flex items-center gap-1 text-sm">
        {onChain ? CONFIRM_COPY.LEAD_ON_CHAIN : CONFIRM_COPY.LEAD_PAYMENT}
        <InfoTip label={CONFIRM_COPY.TIP_LABEL} align="start">
          {CONFIRM_COPY.TIP}
        </InfoTip>
      </p>
      <dl className="border-y border-foreground/10">
        <Row label={CONFIRM_COPY.AMOUNT} value={amount} />
        {view.kind === "fiber-payment" ? (
          <>
            <Row label={CONFIRM_COPY.TO} value={view.payee ? shorten(view.payee, 8) : CONFIRM_COPY.UNKNOWN_PAYEE} />
            <div
              className="flex items-center justify-between gap-3 border-b border-foreground/5 py-3"
              data-testid="fiber-wallet-confirm-route"
              data-route={view.route}
            >
              <dt className="flex items-center gap-1 text-sm text-muted-foreground">
                {CONFIRM_COPY.ROUTE}
                <InfoTip label={CONFIRM_COPY.ROUTE_TIP_LABEL} align="start">
                  {CONFIRM_COPY.ROUTE_TIP}
                </InfoTip>
              </dt>
              <dd className="min-w-0 text-right font-mono text-sm [overflow-wrap:anywhere]">{CONFIRM_COPY.ROUTE_KIND[view.route]}</dd>
            </div>
            <Row label={CONFIRM_COPY.MAX_FEE} value={names.amount(view.asset, view.maxFee)} />
            {view.note && <Row label={CONFIRM_COPY.NOTE} value={view.note} />}
            {view.expiresAt !== null && <Row label={CONFIRM_COPY.EXPIRES} value={when(view.expiresAt)} />}
          </>
        ) : (
          <>
            <Row label={CONFIRM_COPY.TO} value={shorten(view.address, 12)} />
            <Row label={CONFIRM_COPY.FEE} value={names.amount(CKB_ASSET, view.fee)} />
          </>
        )}
      </dl>
      {onChain && (
        <div className="space-y-2">
          <label htmlFor={passwordId} className="block text-sm text-muted-foreground">
            {CONFIRM_COPY.PASSWORD_LABEL}
          </label>
          <input
            id={passwordId}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={pending.running}
            aria-invalid={pending.error !== null}
            aria-describedby={pending.error ? errorId : undefined}
            className={textInput}
            data-testid="fiber-wallet-confirm-password"
          />
        </div>
      )}
      <div aria-live="polite">
        {pending.error && (
          <StatusNotice tone="error" role="alert">
            <p id={errorId} data-testid="fiber-wallet-confirm-error">
              {pending.error}
            </p>
          </StatusNotice>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={!canConfirm}
          title={onChain && !password ? CONFIRM_COPY.NEEDS_PASSWORD : undefined}
          className={primaryButton}
          data-testid="fiber-wallet-confirm-accept"
        >
          {pending.running ? CONFIRM_COPY.SENDING : onChain ? CONFIRM_COPY.SEND(amount) : CONFIRM_COPY.PAY(amount)}
        </button>
        <button
          type="button"
          onClick={() => confirmations.decline(pending.id)}
          disabled={pending.running}
          className={secondaryButton}
          data-testid="fiber-wallet-confirm-decline"
        >
          {CONFIRM_COPY.DECLINE}
        </button>
      </div>
    </form>
  );
}
