"use client";

import { useId, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { FiberAssetId } from "@/lib/hub/contract";
import type { WalletToken } from "@/lib/wallets/fiber-browser/tokens";
import { onRadioGroupKeyDown } from "../ui";
import { choiceChip, textArea, textInput } from "./styles";

interface TextFieldProps {
  label: string;
  value: string;
  onChange: (text: string) => void;
  /** Shown under the field, and the field is marked invalid. */
  error?: string | null;
  /** A short line under the field (what the node can move). */
  hint?: ReactNode;
  /** A "?" after the label. */
  tip?: ReactNode;
  placeholder?: string;
  inputMode?: "text" | "decimal" | "numeric";
  multiline?: boolean;
  maxLength?: number;
  testId?: string;
}

/** A labelled square input with its hint, its error (aria-describedby) and an optional "?" (style guide: Inputs). */
export function TextField({ label, value, onChange, error, hint, tip, placeholder, inputMode, multiline, maxLength, testId }: TextFieldProps) {
  const id = useId();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(" ") || undefined;
  const shared = {
    id,
    value,
    onChange: (e: { target: { value: string } }) => onChange(e.target.value),
    placeholder,
    spellCheck: false,
    autoComplete: "off",
    maxLength,
    "aria-invalid": !!error,
    "aria-describedby": describedBy,
    "data-testid": testId,
  };
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1">
        <label htmlFor={id} className="block text-sm text-muted-foreground">
          {label}
        </label>
        {tip}
      </div>
      {multiline ? <textarea {...shared} className={cn(textArea, "min-h-24")} /> : <input {...shared} inputMode={inputMode} className={textInput} />}
      {hint && (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** Which token: a radio group of square chips, one per token the wallet knows (style guide: Radio groups). */
export function TokenPicker({
  label,
  tokens,
  value,
  onChange,
}: {
  label: string;
  tokens: readonly WalletToken[];
  value: FiberAssetId;
  onChange: (id: FiberAssetId) => void;
}) {
  const id = useId();
  return (
    <div className="space-y-2">
      <p id={id} className="text-sm text-muted-foreground">
        {label}
      </p>
      <div role="radiogroup" aria-labelledby={id} onKeyDown={onRadioGroupKeyDown} className="flex flex-wrap gap-2">
        {tokens.map((token) => (
          <button
            key={token.id}
            type="button"
            role="radio"
            aria-checked={value === token.id}
            tabIndex={value === token.id ? 0 : -1}
            onClick={() => onChange(token.id)}
            className={cn(choiceChip, "min-w-16 text-center font-mono")}
          >
            {token.symbol}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Options of a small radio group of words (Invoice / Node id), as square chips. `fill`: one row of equal cells in small
 * type, for more options than wrap well in a narrow panel (History's five filters in the 380 px popup).
 */
export function ChoiceGroup<T extends string>({
  label,
  options,
  value,
  onChange,
  fill = false,
  disabled = false,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  fill?: boolean;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="space-y-2">
      <p id={id} className="sr-only">
        {label}
      </p>
      <div
        role="radiogroup"
        aria-labelledby={id}
        onKeyDown={onRadioGroupKeyDown}
        className={fill ? "grid grid-flow-col auto-cols-fr gap-1" : "flex flex-wrap gap-2"}
      >
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={value === option.value}
            tabIndex={value === option.value ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={cn(fill ? cn(choiceChip, "px-1 text-center text-xs") : choiceChip, "disabled:cursor-not-allowed disabled:opacity-60")}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
