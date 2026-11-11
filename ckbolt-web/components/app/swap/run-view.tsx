"use client";

import type { SwapRun } from "@/hooks/use-swap-runner";
import { PROGRESS_COPY } from "@/lib/swap/copy";
import { HoldInvoicePay, ManualPay } from "./manual-pay";
import { ProgressSteps } from "./progress-steps";
import { SwapResult } from "./swap-result";

/**
 * The run of one swap as the swap card's progress dialog and Pay show it: the five steps while it runs, its result once
 * it ended, the hub's hold invoice to pay by hand while the run waits for it, and a line while the hub cannot be read.
 */
export function RunView({ run, onPayInBrowser }: { run: SwapRun; onPayInBrowser: () => void }) {
  const { plan, swap, outcome } = run;
  const ended = outcome !== "running";
  return (
    <>
      {/* Once the run has ended, its result replaces the steps. */}
      {ended && swap ? <SwapResult outcome={outcome} swap={swap} symbol={plan.symbol} /> : <ProgressSteps steps={run.steps} />}
      {run.manualInvoice &&
        (plan.quote.direction === "ln_to_fiber" ? (
          <HoldInvoicePay invoice={run.manualInvoice} browserWallet={run.browserWallet} onPayInBrowser={onPayInBrowser} />
        ) : (
          <ManualPay
            invoice={run.manualInvoice}
            amount={{ units: plan.quote.pay.amount, decimals: plan.quote.pay.decimals, symbol: plan.symbol }}
          />
        ))}
      <div aria-live="polite">
        {run.pollError && !run.final && <p className="mt-2 text-xs text-muted-foreground">{PROGRESS_COPY.POLL_ERROR}</p>}
      </div>
    </>
  );
}
