"use client";

import { useId, useState, type Ref } from "react";
import { ScanLine, X } from "lucide-react";
import { LN_INVOICE_COPY } from "@/lib/swap/copy";
import { QrScanner } from "../qr-scanner";
import { InfoTip } from "./info-tip";

/**
 * CKB or a token to BTC: the one field where the visitor pastes, or scans with the camera or from an image, their own
 * Lightning invoice. Its amount fixes the swap; the card checks it and says in one line why it cannot be used.
 */
export function LnInvoiceField({
  value,
  onChange,
  tip,
  placeholder,
  ask,
  invalid,
  locked,
  describedBy,
  inputRef,
}: {
  value: string;
  onChange: (text: string) => void;
  /** What the invoice must be, behind the "?". */
  tip: string;
  placeholder: string;
  /** Under the field, once a typed amount was quoted: the invoice to make ("For exactly 2,475 sats"). */
  ask: string | null;
  invalid: boolean;
  locked: boolean;
  /** The card's error line. */
  describedBy?: string;
  inputRef?: Ref<HTMLInputElement>;
}) {
  const id = useId();
  const askId = `${id}-ask`;
  const scannerId = `${id}-scanner`;
  const [scanning, setScanning] = useState(false);
  const described = [ask ? askId : null, describedBy ?? null].filter(Boolean).join(" ") || undefined;

  return (
    <div className="mt-3 border-t border-foreground/10 pt-3">
      <div className="flex items-center gap-1">
        <label htmlFor={id} className="font-mono text-xs text-foreground/70">
          {LN_INVOICE_COPY.LABEL}
        </label>
        <InfoTip label={LN_INVOICE_COPY.TIP_LABEL}>{tip}</InfoTip>
      </div>
      <div className="mt-1 flex gap-2">
        <input
          ref={inputRef}
          id={id}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          readOnly={locked}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          placeholder={placeholder}
          aria-invalid={invalid}
          aria-describedby={described}
          className="h-11 min-w-0 flex-1 border border-foreground/15 bg-background px-3 font-mono text-xs focus:border-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/25"
          data-testid="swap-ln-invoice"
        />
        <button
          type="button"
          onClick={() => setScanning((open) => !open)}
          disabled={locked}
          aria-label={scanning ? LN_INVOICE_COPY.SCAN_CLOSE : LN_INVOICE_COPY.SCAN}
          aria-expanded={scanning}
          aria-controls={scanning ? scannerId : undefined}
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center border border-foreground/15 hover:bg-foreground/5 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-40"
          data-testid="swap-ln-invoice-scan"
        >
          {scanning ? <X className="h-4 w-4" aria-hidden="true" /> : <ScanLine className="h-4 w-4" aria-hidden="true" />}
        </button>
      </div>
      {ask && (
        <p id={askId} className="mt-1 font-mono text-xs text-foreground/70" data-testid="swap-ln-invoice-ask">
          {ask}
        </p>
      )}
      {scanning && !locked && (
        <div id={scannerId} className="mt-3">
          <QrScanner
            onResult={(text) => {
              onChange(text);
              setScanning(false);
            }}
          />
        </div>
      )}
    </div>
  );
}
