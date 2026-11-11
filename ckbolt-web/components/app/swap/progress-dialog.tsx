"use client";

import { Dialog, DialogContent } from "@/components/ui/dialog";
import type { SwapRun } from "@/hooks/use-swap-runner";
import { PROGRESS_COPY } from "@/lib/swap/copy";
import { pairLine } from "@/lib/swap/format";
import { hashKey } from "@/lib/swap/history";
import { isRunSettled } from "@/lib/swap/run-model";
import { ViewInHistory } from "../fiber-wallet/host/view-in-history";
import { primaryButton, secondaryButton } from "../ui";
import { RunView } from "./run-view";

const keepOpen = (e: Event) => e.preventDefault();

/**
 * The run of one swap, from "Swap" to complete, refunded or cancelled. While it runs it cannot be dismissed (no close
 * button, Escape and outside clicks are ignored) but offers "Hide"; the card then shows a banner to come back. Once
 * settled, closing it puts the run away, and "View in History" hides it and opens the header's Fiber node on the swap.
 */
export function ProgressDialog({
  open,
  run,
  onHide,
  onRetry,
  onDone,
  onPayInBrowser,
}: {
  open: boolean;
  run: SwapRun;
  onHide: () => void;
  /** Repeats the failed step. */
  onRetry: () => void;
  /** The run is over, or needs a new quote: put it away and quote again. */
  onDone: () => void;
  /** Asks the browser wallet (WebLN) to pay the hub's Lightning hold invoice. */
  onPayInBrowser: () => void;
}) {
  const { plan, swap, outcome } = run;
  const ended = outcome !== "running";
  const settled = isRunSettled(run);
  // Before a swap exists, starting over means a new quote; after a cancelled one, it is simply trying again.
  const retryLabel = run.retry === "new-quote" && !swap ? PROGRESS_COPY.NEW_QUOTE : PROGRESS_COPY.RETRY;
  const onRetryPress = run.retry === "new-quote" ? onDone : onRetry;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && (settled ? onDone() : onHide())}>
      <DialogContent
        title={ended ? PROGRESS_COPY.TITLE_ENDED : PROGRESS_COPY.TITLE_RUNNING}
        description={pairLine(plan.quote, plan.symbol)}
        hideClose={!settled}
        onEscapeKeyDown={settled ? undefined : keepOpen}
        onInteractOutside={settled ? undefined : keepOpen}
        data-testid="swap-progress"
      >
        <RunView run={run} onPayInBrowser={onPayInBrowser} />
        <div className="mt-5 flex flex-wrap items-center justify-end gap-3">
          {settled && swap && <ViewInHistory entry={{ id: swap.id, hash: hashKey(swap.paymentHash) }} onOpen={onHide} className="mr-auto" />}
          {!settled && (
            <button type="button" onClick={onHide} className={secondaryButton}>
              {PROGRESS_COPY.HIDE}
            </button>
          )}
          {run.retry ? (
            <button type="button" onClick={onRetryPress} className={primaryButton}>
              {retryLabel}
            </button>
          ) : (
            settled && (
              <button type="button" onClick={onDone} className={primaryButton}>
                {PROGRESS_COPY.NEW_SWAP}
              </button>
            )
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
