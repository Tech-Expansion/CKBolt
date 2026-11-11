"use client";

import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { HOW_IT_WORKS_LABEL, HOW_IT_WORKS_SUMMARY } from "./copy";
import { HowItWorksGuide } from "./guide";

/** Text button of the style guide (App UI patterns), sized for a card header. */
const triggerClass =
  "inline-flex min-h-10 items-center px-3 text-sm text-muted-foreground hover:text-foreground underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2";

/**
 * "How it works": a small text button in the swap card's header that opens the guide, so the card itself carries no
 * explanation. `className` adjusts its placement in the header; `assets` are the symbols the hub serves.
 */
export function HowItWorksButton({ className, assets }: { className?: string; assets?: readonly string[] } = {}) {
  return (
    <Dialog>
      <DialogTrigger type="button" className={cn(triggerClass, className)} data-testid="how-it-works">
        {HOW_IT_WORKS_LABEL}
      </DialogTrigger>
      <DialogContent title={HOW_IT_WORKS_LABEL} description={HOW_IT_WORKS_SUMMARY}>
        <HowItWorksGuide assets={assets} />
      </DialogContent>
    </Dialog>
  );
}
