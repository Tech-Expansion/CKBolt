"use client";

import { BANNER_COPY, RESULT_COPY } from "@/lib/swap/copy";
import type { RunOutcome } from "@/lib/swap/run-model";

const OUTCOME_TEXT: Record<RunOutcome, string> = {
  running: BANNER_COPY.RUNNING,
  complete: RESULT_COPY.COMPLETE,
  refunded: RESULT_COPY.REFUNDED_SHORT,
  "refund-pending": RESULT_COPY.REFUND_PENDING,
  cancelled: RESULT_COPY.CANCELLED,
  cancelling: RESULT_COPY.CANCELLING,
};

/** "Swap in progress · View": the hidden progress dialog's way back. */
export function ProgressBanner({ outcome, onView }: { outcome: RunOutcome; onView: () => void }) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-3 border border-foreground/10 px-4 text-sm" data-testid="swap-banner">
      <p role="status">{OUTCOME_TEXT[outcome]}</p>
      <button
        type="button"
        onClick={onView}
        className="min-h-10 px-3 -mr-3 font-medium underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        {BANNER_COPY.VIEW}
      </button>
    </div>
  );
}
