import type { HowItWorksStep } from "./copy";

/**
 * The swap's steps as a small vertical diagram drawn in CSS: square numbered markers on a hairline rail. It is an
 * ordered list, so screen readers get the order; the drawn numbers and the rail are decorative.
 */
export function StepsDiagram({ steps }: { steps: readonly HowItWorksStep[] }) {
  return (
    <ol className="space-y-0" data-testid="how-it-works-steps">
      {steps.map((step, i) => (
        <li key={step.title} className="relative flex gap-3 pb-4 last:pb-0">
          {i < steps.length - 1 && <span aria-hidden="true" className="absolute left-3.5 top-7 bottom-0 w-px bg-foreground/15" />}
          <span
            aria-hidden="true"
            className="relative flex h-7 w-7 shrink-0 items-center justify-center border border-foreground/15 bg-background font-mono text-xs tabular-nums"
          >
            {String(i + 1).padStart(2, "0")}
          </span>
          <div className="min-w-0 pt-0.5">
            <p className="text-sm font-medium leading-tight">{step.title}</p>
            <p className="mt-1 text-sm text-muted-foreground leading-snug">{step.text}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
