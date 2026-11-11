"use client";

import { useEffect, useState } from "react";
import { Check, Clock, RotateCcw, X, type LucideIcon } from "lucide-react";
import type { SwapDto } from "@/lib/hub/contract";
import { RESULT_COPY } from "@/lib/swap/copy";
import { legText, shortHash } from "@/lib/swap/format";
import { checkPreimage, type PreimageCheck } from "@/lib/swap/preimage";
import type { RunOutcome } from "@/lib/swap/run-model";
import { outcomeTone } from "@/lib/status-tone";
import { cn } from "@/lib/utils";
import { FeedbackLink } from "../feedback-link";
import { statusTint } from "../status";
import { Row } from "../ui";
import { Disclosure } from "./disclosure";

type EndedOutcome = Exclude<RunOutcome, "running">;

const HEADLINE: Record<EndedOutcome, string> = {
  complete: RESULT_COPY.COMPLETE,
  refunded: RESULT_COPY.REFUNDED,
  "refund-pending": RESULT_COPY.REFUND_PENDING,
  cancelled: RESULT_COPY.CANCELLED,
  cancelling: RESULT_COPY.CANCELLING,
};

/** A mark beside the headline, in the outcome's status colour (outcomeTone): green for success. Decorative. */
const MARK: Record<EndedOutcome, LucideIcon> = {
  complete: Check,
  refunded: RotateCcw,
  "refund-pending": Clock,
  cancelled: X,
  cancelling: Clock,
};

const LINE: Partial<Record<EndedOutcome, string>> = {
  "refund-pending": RESULT_COPY.REFUND_PENDING_LINE,
  cancelled: RESULT_COPY.CANCELLED_LINE,
};

const HASH_CHECK_TEXT: Record<PreimageCheck | "checking", string> = {
  match: RESULT_COPY.HASH_MATCH,
  mismatch: RESULT_COPY.HASH_MISMATCH,
  unavailable: RESULT_COPY.HASH_UNCHECKED,
  checking: RESULT_COPY.HASH_CHECKING,
};

/** sha256(preimage) against the payment hash, computed in this page once the hub shows the preimage. */
function usePreimageCheck(preimage: string | null, paymentHash: string): PreimageCheck | "checking" | null {
  const [result, setResult] = useState<{ key: string; check: PreimageCheck } | null>(null);
  const key = preimage ? `${preimage}:${paymentHash}` : null;
  useEffect(() => {
    if (!preimage) return;
    let current = true;
    const mine = `${preimage}:${paymentHash}`;
    checkPreimage(preimage, paymentHash).then(
      (check) => {
        if (current) setResult({ key: mine, check });
      },
      () => {
        if (current) setResult({ key: mine, check: "unavailable" });
      },
    );
    return () => {
      current = false;
    };
  }, [preimage, paymentHash]);
  if (!key) return null;
  return result?.key === key ? result.check : "checking";
}

/** How the run ended: the headline, the amounts on success, the swap's details on request, and a way to report it. */
export function SwapResult({ outcome, swap, symbol }: { outcome: EndedOutcome; swap: SwapDto; symbol: string }) {
  const hashCheck = usePreimageCheck(swap.preimage, swap.paymentHash);
  const line = LINE[outcome];
  const Icon = MARK[outcome];
  const markClass = statusTint(outcomeTone(outcome));
  return (
    <div className="space-y-3" data-testid="swap-result">
      {/* A status block under the dialog's title, not a second title: body type, with a mark. */}
      <div role="status" className="flex items-start gap-3">
        <span className={cn("inline-flex h-8 w-8 shrink-0 items-center justify-center", markClass)} aria-hidden="true">
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 pt-1">
          <p className="text-base font-medium leading-snug">{HEADLINE[outcome]}</p>
          {line && <p className="mt-1 text-sm text-muted-foreground">{line}</p>}
        </div>
      </div>
      {outcome === "complete" && (
        <dl>
          <Row label={RESULT_COPY.PAID} value={legText(swap.pay, symbol)} />
          <Row label={RESULT_COPY.RECEIVED} value={legText(swap.receive, symbol)} />
        </dl>
      )}
      <Disclosure label={RESULT_COPY.DETAILS} toggleClassName="text-sm">
        <dl className="border-t border-foreground/10">
          <Row label={RESULT_COPY.SWAP_ID} value={swap.id} />
          <Row label={RESULT_COPY.PAYMENT_HASH} value={shortHash(swap.paymentHash)} />
          {swap.preimage && <Row label={RESULT_COPY.PREIMAGE} value={shortHash(swap.preimage)} />}
          {hashCheck && <Row label={RESULT_COPY.HASH_CHECK} value={HASH_CHECK_TEXT[hashCheck]} />}
          {swap.failureReason && (
            // The hub's reason is a sentence: read as prose, under its label, not as a mono value.
            <div className="py-3">
              <dt className="text-sm text-muted-foreground">{RESULT_COPY.REASON}</dt>
              <dd className="mt-1 text-sm [overflow-wrap:anywhere]">{swap.failureReason}</dd>
            </div>
          )}
        </dl>
      </Disclosure>
      <FeedbackLink swapId={swap.id} className="-mt-2" testId="swap-report" />
    </div>
  );
}
