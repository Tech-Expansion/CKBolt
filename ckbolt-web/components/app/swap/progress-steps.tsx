"use client";

import { Check, X } from "lucide-react";
import { PROGRESS_COPY, RUN_ERROR } from "@/lib/swap/copy";
import type { StepView } from "@/lib/swap/run-model";
import { stepTone, type StatusTone } from "@/lib/status-tone";
import { cn } from "@/lib/utils";
import { InfoTip } from "./info-tip";

/** Each step in the status colours (lib/status-tone.ts stepTone): done green, the current one amber, failed red. */
const MARK: Record<StatusTone, string> = {
  off: "border border-foreground/15 text-muted-foreground",
  pending: "border-2 border-pending-bright text-pending",
  ok: "bg-fiber text-background",
  error: "border border-destructive text-destructive",
};

/**
 * The step's number in a square marker (as in the How it works diagram; corners are square in this design); a check
 * when done, a cross when it failed. Decorative: the status is also text.
 */
function StepMark({ step }: { step: StepView }) {
  return (
    <span className={cn("inline-flex h-7 w-7 shrink-0 items-center justify-center font-mono text-xs tabular-nums", MARK[stepTone(step.status)])} aria-hidden="true">
      {step.status === "done" ? <Check className="h-4 w-4" /> : step.status === "failed" ? <X className="h-4 w-4" /> : step.number}
    </span>
  );
}

/** The five steps of the run, each pending, active, done or failed, with one short line (its full reason behind a "?"). */
export function ProgressSteps({ steps }: { steps: readonly StepView[] }) {
  const current = steps.find((s) => s.status === "active" || s.status === "failed");
  return (
    <>
      <ol aria-label={PROGRESS_COPY.STEPS_LABEL}>
        {steps.map((step) => (
          <li
            key={step.id}
            aria-current={step.status === "active" ? "step" : undefined}
            className="flex items-start gap-3 border-b border-foreground/5 py-3 last:border-b-0"
            data-status={step.status}
            data-testid={`swap-step-${step.number}`}
          >
            <StepMark step={step} />
            <div className="min-w-0 flex-1">
              <p className={cn("text-sm", step.status === "pending" ? "text-muted-foreground" : "font-medium")}>
                {step.title}
                <span className="sr-only">: {PROGRESS_COPY.STEP_STATUS[step.status]}</span>
              </p>
              {step.line && (
                <p className={cn("flex items-start gap-1 text-xs", step.status === "failed" ? "text-destructive" : "text-muted-foreground")}>
                  <span className="pt-0.5 [overflow-wrap:anywhere]">{step.line}</span>
                  {step.detail && (
                    <InfoTip label={RUN_ERROR.DETAIL_LABEL} align="end">
                      {step.detail}
                    </InfoTip>
                  )}
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>
      {/* One polite announcement of where the run stands, instead of every row. */}
      <p className="sr-only" role="status">
        {current ? `${current.title}: ${current.line ?? PROGRESS_COPY.STEP_STATUS[current.status]}` : ""}
      </p>
    </>
  );
}
