"use client";

import type { ReactNode, Ref } from "react";
import { SATS_UNIT } from "@/lib/hub/format";
import { CARD_COPY } from "@/lib/swap/copy";
import { isLongFigure } from "@/lib/swap/format";
import { cn } from "@/lib/utils";

/** Small captions inside a box; the box is translucent, so they use foreground/70 for contrast (style guide). */
const caption = "font-mono text-xs text-foreground/70";
/** The big amount's type, shared by the input and the copy of its text that places the unit after it. */
const figureType = "font-display text-3xl tabular-nums leading-none";

/**
 * One side of the swap: its label and wallet on top, the amount and token in the middle, the USD value and a limit (or
 * the quote's timer) underneath. `labelFor` names the input the label belongs to (the pay side).
 */
export function SwapBox({
  label,
  labelFor,
  wallet,
  children,
  hint,
  aside,
  footer,
  testId,
}: {
  label: string;
  labelFor?: string;
  wallet: ReactNode;
  children: ReactNode;
  hint: ReactNode;
  aside?: ReactNode;
  footer?: ReactNode;
  testId: string;
}) {
  return (
    <section
      aria-label={label}
      className="border border-foreground/10 bg-foreground/[0.02] px-4 py-3 has-[input:focus-visible]:border-foreground/40"
      data-testid={testId}
    >
      <div className="flex min-h-10 items-center justify-between gap-3">
        {labelFor ? (
          <label htmlFor={labelFor} className={caption}>
            {label}
          </label>
        ) : (
          <p className={caption}>{label}</p>
        )}
        {wallet}
      </div>
      <div className="flex items-center gap-3">{children}</div>
      <div className={cn("mt-1 flex min-h-5 items-center justify-between gap-3", caption)}>
        <span>{hint}</span>
        {aside ? <span className="text-right">{aside}</span> : null}
      </div>
      {footer}
    </section>
  );
}

/** "sats" right after a Lightning amount, since the token chip says BTC. */
const SatsUnit = () => <span className={cn(caption, "shrink-0")}>{SATS_UNIT}</span>;

/**
 * The amount the user pays: whole sats or token units, typed freely and read in lib/swap/amount.ts. The input spans
 * the whole row, so a tap anywhere left of the token focuses it; with sats, the unit follows the typed figure, placed
 * by an invisible copy of the text (pointer events pass through to the input).
 */
export function AmountInput({
  id,
  value,
  onChange,
  locked,
  invalid,
  describedBy,
  sats,
  inputRef,
  testId = "swap-amount",
}: {
  id: string;
  value: string;
  onChange: (text: string) => void;
  locked: boolean;
  invalid: boolean;
  describedBy?: string;
  /** The amount is in whole sats (BTC paid): a numeric keyboard without decimals. */
  sats: boolean;
  inputRef?: Ref<HTMLInputElement>;
  testId?: string;
}) {
  return (
    <div className="relative min-w-0 flex-1">
      <input
        ref={inputRef}
        id={id}
        type="text"
        inputMode={sats ? "numeric" : "decimal"}
        autoComplete="off"
        spellCheck={false}
        placeholder={CARD_COPY.AMOUNT_PLACEHOLDER}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        readOnly={locked}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        className={cn(figureType, "h-14 w-full bg-transparent placeholder:text-muted-foreground focus:outline-none")}
        data-testid={testId}
      />
      {sats && (
        <span className="pointer-events-none absolute inset-0 flex items-center overflow-hidden">
          <span className="flex min-w-0 items-baseline gap-2">
            <span aria-hidden="true" className={cn(figureType, "invisible whitespace-pre")}>
              {value || CARD_COPY.AMOUNT_PLACEHOLDER}
            </span>
            <SatsUnit />
          </span>
        </span>
      )}
    </div>
  );
}

/**
 * The amount the user receives, from the hub's quote; read-only (an output: its changes are announced politely). With
 * sats, the unit follows the figure.
 */
export function ReceiveFigure({ text, sats }: { text: string; sats: boolean }) {
  // The unit takes room on the line too, so it counts toward the step down to the smaller size.
  const long = isLongFigure(sats ? `${text} ${SATS_UNIT}` : text);
  return (
    <div className="flex h-14 min-w-0 flex-1 items-center">
      <p className="flex min-w-0 items-baseline gap-2">
        <output
          className={cn(figureType, "min-w-0 [overflow-wrap:anywhere]", long && "text-2xl")}
          data-testid="swap-receive-amount"
        >
          {text}
        </output>
        {sats && <SatsUnit />}
      </p>
    </div>
  );
}
