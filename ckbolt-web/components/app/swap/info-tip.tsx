"use client";

import type { ReactNode } from "react";
import { CircleHelp } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * The "?" next to a label: one or two short sentences in a popover, so the screen itself stays as terse as a DEX.
 * `label` names what it explains ("About the hub fee") for screen readers and tests.
 */
export function InfoTip({ label, children, align = "center" }: { label: string; children: ReactNode; align?: "start" | "center" | "end" }) {
  return (
    <Popover>
      <PopoverTrigger
        type="button"
        aria-label={label}
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 align-middle"
        data-testid="info-tip"
      >
        <CircleHelp className="h-4 w-4" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent
        align={align}
        aria-label={label}
        className="w-72 rounded-none border-foreground/15 bg-background p-4 text-sm leading-relaxed text-foreground/80"
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}
