import { useState } from "react";
import { Check, Copy } from "lucide-react";
import type { StatusTone } from "@/lib/status-tone";
import { StatusDot } from "./status";

/** Main and secondary actions of a panel (style guide: App UI patterns, buttons). */
export const primaryButton =
  "bg-foreground text-background rounded-full h-12 px-6 text-sm font-medium hover:bg-foreground/90 disabled:opacity-40 disabled:cursor-not-allowed";
export const secondaryButton =
  "border border-foreground/20 rounded-full h-12 px-6 text-sm hover:bg-foreground/5 disabled:opacity-40 disabled:cursor-not-allowed";

/** How long "Copied" shows after a copy. */
const COPIED_NOTICE_MS = 1_500;

export function Panel({
  title,
  step,
  aside,
  children,
}: {
  title: string;
  step: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="border border-foreground/10 bg-background">
      <header className="px-6 py-4 border-b border-foreground/10 flex items-center justify-between gap-4">
        <h2 className="flex items-baseline gap-3">
          <span className="font-mono text-xs text-muted-foreground">{step}</span>
          <span className="font-display text-2xl">{title}</span>
        </h2>
        {aside}
      </header>
      <div className="p-6">{children}</div>
    </section>
  );
}

export function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-xs px-2 py-0.5 border border-foreground/15 text-muted-foreground whitespace-nowrap">
      {children}
    </span>
  );
}

/**
 * A label and its value; `tone` puts a state's dot before the value (the value says the state in words). `compact`:
 * side by side at any width in small type, for a narrow detail (the node's History).
 */
export function Row({ label, value, note, tone, compact = false }: { label: string; value: string; note?: string; tone?: StatusTone; compact?: boolean }) {
  if (compact) {
    return (
      <div className="flex items-baseline justify-between gap-3 py-2 border-b border-foreground/5 last:border-b-0">
        <dt className="shrink-0 text-xs text-muted-foreground">{label}</dt>
        <dd className="min-w-0 font-mono text-xs text-right tabular-nums [overflow-wrap:anywhere]">{value}</dd>
      </div>
    );
  }
  return (
    // Label above value on phones, side by side from sm up; long values wrap at spaces first.
    <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4 py-3 border-b border-foreground/5 last:border-b-0">
      <dt className="text-sm text-muted-foreground sm:max-w-[50%]">
        {label}
        {note && <span className="block font-mono text-xs">{note}</span>}
      </dt>
      <dd className="min-w-0 font-mono text-sm sm:text-right tabular-nums [overflow-wrap:anywhere]">
        {tone ? (
          <span className="inline-flex items-center gap-2">
            <StatusDot tone={tone} />
            {value}
          </span>
        ) : (
          value
        )}
      </dd>
    </div>
  );
}

/** Copies a value, says so for a moment, and tells the user to select the text when the browser refuses. */
export function CopyButton({ value, label, testId }: { value: string; label: string; testId?: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setFailed(false);
          setCopied(true);
          setTimeout(() => setCopied(false), COPIED_NOTICE_MS);
        } catch {
          setCopied(false);
          setFailed(true);
        }
      }}
      className="inline-flex items-center gap-1.5 min-h-10 px-1 -mx-1 text-xs text-muted-foreground hover:text-foreground"
      data-testid={testId}
    >
      {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
      {copied ? "Copied" : failed ? "Copy blocked: select the text instead" : label}
    </button>
  );
}

export const shorten = (s: string, n = 10) => (s.length > n * 2 + 3 ? `${s.slice(0, n)}…${s.slice(-n)}` : s);

/** Arrow keys move between the options of a button-based radio group, like native radios. */
export function onRadioGroupKeyDown(e: React.KeyboardEvent<HTMLElement>) {
  const forward = e.key === "ArrowRight" || e.key === "ArrowDown";
  if (!forward && e.key !== "ArrowLeft" && e.key !== "ArrowUp") return;
  const radios = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)'));
  const i = radios.indexOf(document.activeElement as HTMLButtonElement);
  if (i < 0 || radios.length < 2) return;
  e.preventDefault();
  const next = radios[(i + (forward ? 1 : radios.length - 1)) % radios.length];
  next.focus();
  next.click();
}
