"use client";

import { useEffect, useState, type ReactNode } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { REQUEST_COPY } from "@/lib/get-paid/copy";
import {
  canRenew,
  fiberPart,
  requestPayments,
  type FiberPart,
  type LightningPart,
  type OpenRequest,
  type PaidNetwork,
  type RequestPartStatus,
  type RequestPayment,
} from "@/lib/get-paid/request";
import { formatUnits, secondsUntil } from "@/lib/hub/format";
import { requestPartTone } from "@/lib/status-tone";
import { PROGRESS_COPY } from "@/lib/swap/copy";
import { formatSats } from "@/lib/swap/format";
import type { EntryRef } from "@/lib/wallets/fiber-browser/history";
import { lightningUri } from "@/lib/wallets/lightning/invoice-check";
import { ViewInHistory } from "../fiber-wallet/host/view-in-history";
import { StatusDot, StatusNotice } from "../status";
import { InfoTip } from "../swap/info-tip";
import { InvoiceToPay } from "../swap/manual-pay";
import { ErrorLine } from "../swap/primary-button";
import { QuoteTimer } from "../swap/quote-timer";
import { pillButton } from "../swap/wallets/styles";
import { Row, secondaryButton } from "../ui";
import type { FiberInvoice } from "./use-fiber-invoice";
import type { LightningInvoice } from "./use-lightning-invoice";

type TabId = PaidNetwork;

const when = (ms: number): string => new Date(ms).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
const clock = (ms: number): string => new Date(ms).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });

/**
 * An open request (docs/pay-get-paid.md, part C): what it asks for, then its two invoices as tabs, each with its live
 * status, until either is paid; then a receipt replaces them (both payments, in the rare case a payer paid both). Fiber
 * comes first and opens first: its invoice is made with the request, straight to the node, with no swap. The Lightning
 * invoice is made when its tab opens. "New invoice" makes a fresh one where an invoice ended unpaid; "New request" goes
 * back to the form.
 */
export function RequestView({
  request,
  lightning,
  fiber,
  nowMs,
  onMakeLightning,
  onNewFiber,
  onNewRequest,
}: {
  request: OpenRequest;
  lightning: LightningInvoice;
  fiber: FiberInvoice;
  nowMs: number;
  /** Makes the Lightning invoice: the first time its tab opens, and for "New invoice". */
  onMakeLightning: () => void;
  onNewFiber: () => void;
  onNewRequest: () => void;
}) {
  const [tab, setTab] = useState<TabId>("fiber");
  const ln = lightning.part;
  const select = (value: string) => {
    if (value !== "lightning" && value !== "fiber") return;
    setTab(value);
    if (value === "lightning" && ln.status === "idle") onMakeLightning();
  };
  const fb = fiberPart(fiber.ask, nowMs);
  const amount = `${formatUnits(request.units, request.decimals)} ${request.symbol}`;

  // When each invoice was first seen paid, for the receipt.
  const [paidAt, setPaidAt] = useState<Record<PaidNetwork, number | null>>({ lightning: null, fiber: null });
  const lnPaid = ln.status === "paid";
  const fbPaid = fb.status === "paid";
  useEffect(() => {
    if (lnPaid) setPaidAt((p) => (p.lightning === null ? { ...p, lightning: Date.now() } : p));
  }, [lnPaid]);
  useEffect(() => {
    if (fbPaid) setPaidAt((p) => (p.fiber === null ? { ...p, fiber: Date.now() } : p));
  }, [fbPaid]);
  const payments = requestPayments(ln, fb, paidAt);
  // Each payment's entry in the node's History: the Lightning invoice's swap, the Fiber invoice's payment hash.
  const entries: Record<PaidNetwork, EntryRef | null> = {
    lightning: lightning.entry,
    fiber: fiber.ask?.status === "made" ? { id: null, hash: fiber.ask.paymentHash } : null,
  };
  // One payment: its "View in History" sits with New request; two (paid twice): one under each.
  const soleEntry = payments.length === 1 ? entries[payments[0].network] : null;

  return (
    <section aria-label={REQUEST_COPY.RESULT_LABEL} className="space-y-4" data-testid="request-view">
      <div data-testid="request-summary">
        <p className="font-display text-3xl tabular-nums [overflow-wrap:anywhere]">{amount}</p>
        {request.note && <p className="mt-1 text-sm text-muted-foreground [overflow-wrap:anywhere]">{request.note}</p>}
      </div>
      {payments.length > 0 ? (
        <Receipt payments={payments} amount={amount} entries={entries} />
      ) : (
        <Tabs.Root value={tab} onValueChange={select} data-testid="request-tabs">
          <Tabs.List aria-label={REQUEST_COPY.TABS_LABEL} className="grid grid-cols-2 gap-px border border-foreground/10 bg-foreground/10">
            <PartTab value="fiber" title={REQUEST_COPY.FIBER} status={fb.status} />
            <PartTab value="lightning" title={REQUEST_COPY.LIGHTNING} status={ln.status} />
          </Tabs.List>
          <Tabs.Content value="fiber" forceMount className="data-[state=inactive]:hidden focus-visible:outline-2 focus-visible:outline-offset-4">
            <FiberPanel part={fb} onNew={onNewFiber} />
          </Tabs.Content>
          <Tabs.Content value="lightning" forceMount className="data-[state=inactive]:hidden focus-visible:outline-2 focus-visible:outline-offset-4">
            <LightningPanel
              part={ln}
              symbol={request.symbol}
              totalSeconds={lightning.totalSeconds}
              pollError={lightning.pollError}
              nowMs={nowMs}
              onNew={onMakeLightning}
            />
          </Tabs.Content>
        </Tabs.Root>
      )}
      <div className="flex flex-wrap items-center justify-end gap-3">
        {soleEntry && <ViewInHistory entry={soleEntry} className="mr-auto" />}
        <button type="button" onClick={onNewRequest} className={secondaryButton} data-testid="request-reset">
          {REQUEST_COPY.NEW_REQUEST}
        </button>
      </div>
    </section>
  );
}

/** A tab with its invoice's status in words under the title, and the status's dot. */
function PartTab({ value, title, status }: { value: TabId; title: string; status: RequestPartStatus }) {
  return (
    <Tabs.Trigger
      value={value}
      className="flex flex-col items-start gap-0.5 bg-background px-4 py-2 text-left hover:bg-foreground/[0.03] data-[state=active]:bg-foreground data-[state=active]:text-background focus-visible:outline-2 focus-visible:-outline-offset-4"
      data-testid={`request-tab-${value}`}
      data-status={status}
    >
      <span className="font-display text-xl">{title}</span>
      <span className="inline-flex items-center gap-1.5 font-mono text-xs">
        <StatusDot tone={requestPartTone(status)} />
        {REQUEST_COPY.STATUS[status]}
      </span>
    </Tabs.Trigger>
  );
}

/** The panel of one invoice: its status line or its QR code, and "New invoice" once it ended unpaid. */
function PartPanel({ testId, status, children, onNew }: { testId: string; status: RequestPartStatus; children: ReactNode; onNew: () => void }) {
  return (
    <div className="space-y-3 pt-1" data-testid={testId} data-status={status}>
      {/* Its notices are status regions; the countdown is a timer, so it is not read out every second. */}
      <div>{children}</div>
      {canRenew(status) && (
        <button type="button" onClick={onNew} className={pillButton} data-testid="request-new">
          {REQUEST_COPY.NEW_INVOICE}
        </button>
      )}
    </div>
  );
}

const Making = ({ line = REQUEST_COPY.MAKING }: { line?: string }) => (
  <p className="mt-4 text-sm text-muted-foreground" role="status">
    {line}
  </p>
);

/** What the Lightning invoice is, before it is shown: the payer pays BTC, the node receives the request's asset. */
function LightningLine({ symbol }: { symbol: string }) {
  return (
    <p className="mt-4 flex items-center gap-1 text-sm font-medium" data-testid="request-lightning-line">
      {REQUEST_COPY.LIGHTNING_LABEL(symbol)}
      <InfoTip label={REQUEST_COPY.LIGHTNING_TIP_LABEL}>{REQUEST_COPY.LIGHTNING_TIP}</InfoTip>
    </p>
  );
}

function LightningPanel({
  part,
  symbol,
  totalSeconds,
  pollError,
  nowMs,
  onNew,
}: {
  part: LightningPart;
  /** The asset the request receives. */
  symbol: string;
  totalSeconds: number;
  pollError: boolean;
  nowMs: number;
  onNew: () => void;
}) {
  const body = (() => {
    switch (part.status) {
      case "idle":
        return <LightningLine symbol={symbol} />;
      case "making":
        return (
          <>
            <LightningLine symbol={symbol} />
            <Making line={REQUEST_COPY.LIGHTNING_MAKING} />
          </>
        );
      case "waiting":
        return part.invoice ? (
          <InvoiceToPay
            invoice={part.invoice}
            label={REQUEST_COPY.LIGHTNING_LABEL(symbol)}
            tipLabel={REQUEST_COPY.LIGHTNING_TIP_LABEL}
            tip={REQUEST_COPY.LIGHTNING_TIP}
            qrAlt={REQUEST_COPY.LIGHTNING_QR_ALT}
            testIds={{ box: "request-lightning-invoice", qr: "request-lightning-qr", copy: "request-lightning-copy", text: "request-lightning-text" }}
          >
            <dl>
              {part.sats && <Row label={REQUEST_COPY.THEY_PAY} value={REQUEST_COPY.SATS(formatSats(part.sats))} />}
              {part.expiresAt && (
                <div className="flex items-center justify-between gap-3 py-3">
                  <dt className="text-sm text-muted-foreground">{REQUEST_COPY.EXPIRES_IN}</dt>
                  <dd className="font-mono text-sm">
                    <QuoteTimer secondsLeft={secondsUntil(part.expiresAt, nowMs)} totalSeconds={totalSeconds} testId="request-countdown" />
                  </dd>
                </div>
              )}
            </dl>
            <a href={lightningUri(part.invoice)} className={pillButton} data-testid="request-lightning-open">
              {PROGRESS_COPY.OPEN_IN_WALLET}
            </a>
          </InvoiceToPay>
        ) : null;
      case "arriving":
      case "paid":
        return (
          <StatusNotice tone="pending" role="status" className="mt-4">
            {REQUEST_COPY.ARRIVING}
          </StatusNotice>
        );
      case "expired":
        return (
          <StatusNotice tone="off" role="status" className="mt-4">
            {REQUEST_COPY.EXPIRED}
          </StatusNotice>
        );
      case "returned":
        return (
          <StatusNotice tone="error" role="status" className="mt-4">
            {REQUEST_COPY.RETURNED}
          </StatusNotice>
        );
      case "cancelled":
      case "failed":
        return part.error ? <ErrorLine error={part.error} label={REQUEST_COPY.DETAIL_LABEL} testId="request-lightning-error" className="mt-4" /> : null;
    }
  })();
  return (
    <PartPanel testId="request-lightning" status={part.status} onNew={onNew}>
      {body}
      {pollError && <p className="mt-2 text-xs text-muted-foreground">{PROGRESS_COPY.POLL_ERROR}</p>}
    </PartPanel>
  );
}

function FiberPanel({ part, onNew }: { part: FiberPart; onNew: () => void }) {
  const body = (() => {
    switch (part.status) {
      case "idle":
      case "making":
        return <Making />;
      case "waiting":
        return part.invoice ? (
          <InvoiceToPay
            invoice={part.invoice}
            label={REQUEST_COPY.FIBER_LABEL}
            tipLabel={REQUEST_COPY.FIBER_TIP_LABEL}
            tip={REQUEST_COPY.FIBER_TIP}
            qrAlt={REQUEST_COPY.FIBER_QR_ALT}
            testIds={{ box: "request-fiber-invoice", qr: "request-fiber-qr", copy: "request-fiber-copy", text: "request-fiber-text" }}
          >
            {part.expiresAt !== null && (
              <dl>
                <Row label={REQUEST_COPY.VALID_UNTIL} value={clock(part.expiresAt)} />
              </dl>
            )}
          </InvoiceToPay>
        ) : null;
      case "arriving":
      case "paid":
        return (
          <StatusNotice tone="pending" role="status" className="mt-4">
            {REQUEST_COPY.FIBER_ARRIVING}
          </StatusNotice>
        );
      case "expired":
      case "cancelled":
        return (
          <StatusNotice tone="off" role="status" className="mt-4">
            {REQUEST_COPY.EXPIRED}
          </StatusNotice>
        );
      case "returned":
      case "failed":
        return part.error ? <ErrorLine error={part.error} label={REQUEST_COPY.DETAIL_LABEL} testId="request-fiber-error" className="mt-4" /> : null;
    }
  })();
  return (
    <PartPanel testId="request-fiber" status={part.status} onNew={onNew}>
      {body}
    </PartPanel>
  );
}

/**
 * "Paid": what was received, on which network, when; both payments when a payer paid both invoices, each with "View in
 * History". The request's amount and note stay above it.
 */
function Receipt({ payments, amount, entries }: { payments: RequestPayment[]; amount: string; entries: Record<PaidNetwork, EntryRef | null> }) {
  const twice = payments.length > 1;
  return (
    <div className="space-y-3" data-testid="request-paid" data-count={payments.length}>
      <StatusNotice tone="ok" role="status">
        <p className="flex items-center gap-1 font-medium">
          {twice ? REQUEST_COPY.PAID_TWICE : REQUEST_COPY.PAID}
          {twice && (
            <InfoTip label={REQUEST_COPY.PAID_TWICE_TIP_LABEL} align="start">
              {REQUEST_COPY.PAID_TWICE_TIP}
            </InfoTip>
          )}
        </p>
      </StatusNotice>
      {payments.map((p) => {
        const entry = entries[p.network];
        return (
          <div key={p.network} data-testid="request-payment" data-network={p.network}>
            <dl className="border-y border-foreground/10">
              <Row label={REQUEST_COPY.RECEIVED} value={amount} />
              <Row label={REQUEST_COPY.PAID_WITH} value={p.network === "lightning" ? REQUEST_COPY.VIA_LIGHTNING(formatSats(p.sats ?? "0")) : REQUEST_COPY.VIA_FIBER} />
              <Row label={REQUEST_COPY.AT} value={when(p.at)} />
            </dl>
            {twice && entry && <ViewInHistory entry={entry} />}
          </div>
        );
      })}
    </div>
  );
}
