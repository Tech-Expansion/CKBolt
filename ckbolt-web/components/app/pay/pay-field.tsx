"use client";

import { useId, useState, type Ref } from "react";
import { ScanLine, X } from "lucide-react";
import { PAY_COPY } from "@/lib/pay/copy";
import { QrScanner } from "../qr-scanner";
import { InfoTip } from "../swap/info-tip";

/**
 * Pay's one field: a Lightning invoice, a Fiber invoice or a CKB address, pasted or scanned (camera or image). Read-only
 * while a payment runs.
 */
export function PayField({
  value,
  onChange,
  invalid,
  locked,
  describedBy,
  inputRef,
}: {
  value: string;
  onChange: (text: string) => void;
  invalid: boolean;
  locked: boolean;
  describedBy?: string;
  inputRef?: Ref<HTMLInputElement>;
}) {
  const id = useId();
  const scannerId = `${id}-scanner`;
  const [scanning, setScanning] = useState(false);
  return (
    <div>
      <div className="flex items-center gap-1">
        <label htmlFor={id} className="font-mono text-xs text-foreground/70">
          {PAY_COPY.INPUT_LABEL}
        </label>
        <InfoTip label={PAY_COPY.INPUT_TIP_LABEL} align="start">
          {PAY_COPY.INPUT_TIP}
        </InfoTip>
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
          placeholder={PAY_COPY.INPUT_PLACEHOLDER}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          className="h-11 min-w-0 flex-1 border border-foreground/15 bg-background px-3 font-mono text-xs focus:border-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/25"
          data-testid="pay-input"
        />
        <button
          type="button"
          onClick={() => setScanning((open) => !open)}
          disabled={locked}
          aria-label={scanning ? PAY_COPY.SCAN_CLOSE : PAY_COPY.SCAN}
          aria-expanded={scanning}
          aria-controls={scanning ? scannerId : undefined}
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center border border-foreground/15 hover:bg-foreground/5 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-40"
          data-testid="pay-scan"
        >
          {scanning ? <X className="h-4 w-4" aria-hidden="true" /> : <ScanLine className="h-4 w-4" aria-hidden="true" />}
        </button>
      </div>
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
