"use client";

import { ArrowUpDown } from "lucide-react";
import { CARD_COPY } from "@/lib/swap/copy";

/** The flip on the divider between the two boxes: it swaps the direction, as on a DEX. */
export function FlipButton({ onClick, disabled, blocked }: { onClick: () => void; disabled: boolean; blocked: boolean }) {
  const label = blocked ? CARD_COPY.FLIP_BLOCKED : CARD_COPY.FLIP;
  return (
    <div className="relative z-10 h-1">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        title={label}
        className="absolute left-1/2 top-1/2 inline-flex h-10 w-10 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-foreground/15 bg-background hover:bg-foreground/5 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2"
        data-testid="swap-flip"
      >
        <ArrowUpDown className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
