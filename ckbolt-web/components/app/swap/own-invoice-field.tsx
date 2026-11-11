"use client";

import { useId, type Ref } from "react";
import { OWN_INVOICE_COPY } from "@/lib/swap/copy";
import { invoicePrefix, fiberNetworkOf } from "@/lib/wallets/fiber-byo/network";
import { InfoTip } from "./info-tip";

/** Own node, BTC to Fiber: the one field where the user pastes the payout invoice their node made. */
export function OwnInvoiceField({
  value,
  onChange,
  tip,
  network,
  invalid,
  locked,
  describedBy,
  inputRef,
}: {
  value: string;
  onChange: (text: string) => void;
  /** What the invoice must ask for, behind the "?". */
  tip: string;
  /** The hub's CKB network, for the invoice prefix (fibt on testnet). */
  network: string | null;
  invalid: boolean;
  locked: boolean;
  describedBy?: string;
  inputRef?: Ref<HTMLInputElement>;
}) {
  const id = useId();
  return (
    <div className="mt-3 border-t border-foreground/10 pt-3">
      <div className="flex items-center gap-1">
        <label htmlFor={id} className="font-mono text-xs text-foreground/70">
          {OWN_INVOICE_COPY.LABEL}
        </label>
        <InfoTip label={OWN_INVOICE_COPY.TIP_LABEL}>{tip}</InfoTip>
      </div>
      <input
        ref={inputRef}
        id={id}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        readOnly={locked}
        spellCheck={false}
        autoComplete="off"
        placeholder={OWN_INVOICE_COPY.PLACEHOLDER(invoicePrefix(fiberNetworkOf(network)))}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        className="mt-1 h-11 w-full border border-foreground/15 bg-background px-3 font-mono text-xs focus:border-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/25"
        data-testid="swap-own-invoice"
      />
    </div>
  );
}
