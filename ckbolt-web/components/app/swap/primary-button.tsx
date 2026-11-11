"use client";

import type { ShortError } from "@/lib/swap/errors";
import type { PrimaryButtonState } from "@/lib/swap/primary-button";
import { cn } from "@/lib/utils";
import { InfoTip } from "./info-tip";

/** The card's one full-width button; its label is also why it is disabled (lib/swap/primary-button.ts). */
export function PrimaryButton({ state, onPress, describedBy }: { state: PrimaryButtonState; onPress: () => void; describedBy?: string }) {
  return (
    <button
      type="button"
      onClick={onPress}
      disabled={state.disabled}
      aria-describedby={describedBy}
      className="h-14 w-full rounded-full bg-foreground px-6 text-base font-medium text-background hover:bg-foreground/90 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2"
      data-testid="swap-primary"
    >
      {state.label}
    </button>
  );
}

/** One short error line, with the full reason behind a "?" when there is one. */
export function ErrorLine({ error, label, testId, className }: { error: ShortError; label: string; testId?: string; className?: string }) {
  return (
    <p className={cn("flex items-start gap-1 text-sm text-destructive", className)} data-testid={testId}>
      <span className="min-w-0 pt-0.5 [overflow-wrap:anywhere]">{error.line}</span>
      {error.detail && (
        <InfoTip label={label} align="end">
          {error.detail}
        </InfoTip>
      )}
    </p>
  );
}
