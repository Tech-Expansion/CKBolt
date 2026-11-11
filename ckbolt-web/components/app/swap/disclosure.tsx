"use client";

import { useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/** A collapsed section ("Details ▾"): the toggle says whether it is open, and its content is hidden until it is. */
export function Disclosure({
  label,
  children,
  className,
  toggleClassName,
  testId,
}: {
  label: string;
  children: ReactNode;
  className?: string;
  toggleClassName?: string;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className={className} data-testid={testId}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "inline-flex min-h-10 items-center gap-1 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2",
          toggleClassName,
        )}
      >
        {label}
        <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} aria-hidden="true" />
      </button>
      <div id={id} hidden={!open}>
        {children}
      </div>
    </div>
  );
}
