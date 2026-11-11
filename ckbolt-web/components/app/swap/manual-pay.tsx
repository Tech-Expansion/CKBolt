"use client";

import type { ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import { ERROR_HELP_LABEL, NODE_COMMAND_COPY, PROGRESS_COPY, RUN_ERROR } from "@/lib/swap/copy";
import { FNN_DEFAULT_RPC_URL } from "@/lib/wallets/fiber-byo/constants";
import { formatAssetAmount } from "@/lib/wallets/fiber-byo/invoice-check";
import { sendPaymentRequest } from "@/lib/wallets/fiber-byo/rpc-commands";
import { maxFeeOf } from "@/lib/wallets/fiber-browser/payments";
import type { ShortError } from "@/lib/swap/errors";
import { lightningUri } from "@/lib/wallets/lightning/invoice-check";
import { GUIDE_HUB_HREF } from "../guide/constants";
import { QrCode } from "../qr-code";
import { CopyButton } from "../ui";
import { InfoTip } from "./info-tip";
import { NodeCommand } from "./node-command";
import { ErrorLine } from "./primary-button";
import { WALLET_ACTION } from "./wallets/copy";
import { inlineLink, pillButton } from "./wallets/styles";

/**
 * An invoice to pay by hand (a swap's hold invoice under the run's steps, or a Get paid request's invoices): the label
 * and its "?" on top, then the QR code, the invoice text and Copy under it, so nothing wraps beside the label on a
 * phone; then any ways to pay from this device.
 */
export function InvoiceToPay({
  invoice,
  label,
  tipLabel,
  tip,
  qrAlt,
  testIds,
  children,
}: {
  invoice: string;
  label: string;
  tipLabel: string;
  tip: string;
  qrAlt: string;
  testIds: { box: string; qr?: string; copy?: string; text?: string };
  children?: ReactNode;
}) {
  return (
    <div className="mt-4 space-y-3 border border-foreground/10 p-4" data-testid={testIds.box}>
      <p className="flex items-center gap-1 text-sm font-medium">
        {label}
        <InfoTip label={tipLabel}>{tip}</InfoTip>
      </p>
      <QrCode text={invoice} alt={qrAlt} testId={testIds.qr} />
      <p className="break-all font-mono text-xs text-muted-foreground" data-testid={testIds.text}>
        {invoice}
      </p>
      <CopyButton value={invoice} label={PROGRESS_COPY.COPY_INVOICE} testId={testIds.copy} />
      {children}
    </div>
  );
}

/**
 * Own node, Fiber to BTC: the hub's Fiber hold invoice to pay from the visitor's node, and the send_payment call that
 * pays it with fnn, its fee capped as the browser node caps it (maxFeeOf).
 */
export function ManualPay({ invoice, amount }: { invoice: string; amount: { units: string; decimals: number; symbol: string } }) {
  const maxFee = maxFeeOf(BigInt(amount.units));
  return (
    <InvoiceToPay
      invoice={invoice}
      label={PROGRESS_COPY.MANUAL_LABEL}
      tipLabel={PROGRESS_COPY.MANUAL_TIP_LABEL}
      tip={PROGRESS_COPY.MANUAL_TIP}
      qrAlt={PROGRESS_COPY.MANUAL_QR_ALT}
      testIds={{ box: "swap-manual-invoice" }}
    >
      <NodeCommand
        label={NODE_COMMAND_COPY.PAY_LABEL}
        tip={NODE_COMMAND_COPY.PAY_TIP(FNN_DEFAULT_RPC_URL, formatAssetAmount(maxFee, amount.decimals, amount.symbol))}
        request={sendPaymentRequest({ invoice, maxFeeAmount: maxFee })}
        testId="swap-manual-command"
      />
    </InvoiceToPay>
  );
}

/**
 * BTC to CKB or a token: the hub's Lightning hold invoice, paid from any Lightning wallet: scan the QR code, copy it, open
 * it in a wallet on this device (`lightning:`), or, with a WebLN extension, "Pay with browser wallet". The browser
 * wallet is asked once; again only after it refused, with its reason beside the button.
 */
export function HoldInvoicePay({
  invoice,
  browserWallet,
  onPayInBrowser,
}: {
  invoice: string;
  /** A WebLN wallet is on the page, and why its last try did not pay; null without one. */
  browserWallet: { error: ShortError | null } | null;
  onPayInBrowser: () => void;
}) {
  const error = browserWallet?.error ?? null;
  return (
    <InvoiceToPay
      invoice={invoice}
      label={PROGRESS_COPY.HOLD_LABEL}
      tipLabel={PROGRESS_COPY.HOLD_TIP_LABEL}
      tip={PROGRESS_COPY.HOLD_TIP}
      qrAlt={PROGRESS_COPY.HOLD_QR_ALT}
      testIds={{ box: "swap-hold-invoice", qr: "swap-hold-qr", copy: "swap-hold-copy" }}
    >
      <div className="flex flex-wrap gap-3">
        <a href={lightningUri(invoice)} className={pillButton} data-testid="swap-hold-open">
          {PROGRESS_COPY.OPEN_IN_WALLET}
        </a>
        {browserWallet && (
          <button type="button" className={pillButton} onClick={onPayInBrowser} data-testid="swap-webln">
            {PROGRESS_COPY.PAY_IN_BROWSER}
          </button>
        )}
      </div>
      <div aria-live="polite">
        {error && <ErrorLine error={error} label={RUN_ERROR.DETAIL_LABEL} testId="swap-webln-error" />}
        {error?.help && (
          <a
            href={GUIDE_HUB_HREF}
            target="_blank"
            rel="noopener"
            className={`inline-flex min-h-10 items-center gap-1 text-sm font-medium ${inlineLink}`}
            data-testid="swap-step-help"
          >
            {ERROR_HELP_LABEL[error.help]}
            <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="sr-only"> {WALLET_ACTION.NEW_TAB}</span>
          </a>
        )}
      </div>
    </InvoiceToPay>
  );
}
