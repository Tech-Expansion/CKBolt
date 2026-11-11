"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { LiveAsset } from "@/lib/hub/assets";
import type { FiberAssetId } from "@/lib/hub/contract";
import { CARD_COPY } from "@/lib/swap/copy";
import { tokenIcons } from "@/lib/token-display";
import { RECEIVE_TOKENS } from "@/lib/tokens";
import { TokenIcon } from "../token-icon";

const chip = "inline-flex h-11 shrink-0 items-center gap-2 rounded-full border pl-1.5 pr-3 text-base font-medium";

/** The Lightning side's token: always BTC, not a picker. */
export function LightningToken({ testId }: { testId: string }) {
  const btc = RECEIVE_TOKENS.BTC;
  return (
    <span className={`${chip} border-foreground/10`} data-testid={testId}>
      <TokenIcon symbol={btc.symbol} icon={btc.icon} size={28} lightning />
      {btc.symbol}
    </span>
  );
}

/** The Fiber side's token picker: the assets the hub serves in this direction (CKB, RUSD, cWBTC). */
export function TokenButton({
  side,
  options,
  value,
  onChange,
  disabled = false,
  testId,
}: {
  /** "You pay" or "You receive", for the accessible names. */
  side: string;
  options: readonly LiveAsset[];
  value: LiveAsset | null;
  onChange: (id: FiberAssetId) => void;
  disabled?: boolean;
  testId: string;
}) {
  const [open, setOpen] = useState(false);
  const symbol = value?.token.symbol ?? CARD_COPY.NO_TOKEN;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled || options.length === 0}
          aria-label={CARD_COPY.TOKEN_BUTTON(side, symbol)}
          className={`${chip} border-foreground/15 hover:bg-foreground/5 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2`}
          data-testid={testId}
        >
          {value ? <TokenIcon symbol={value.token.symbol} icon={tokenIcons(value.token)} size={28} /> : null}
          {symbol}
          <ChevronDown className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" aria-label={CARD_COPY.TOKEN_LIST(side)} className="w-64 rounded-none border-foreground/15 p-0">
        <p className="border-b border-foreground/10 px-4 py-3 font-mono text-xs text-muted-foreground">{side}</p>
        <ul data-testid="swap-token-list">
          {options.map((option) => {
            const chosen = option.dto.id === value?.dto.id;
            return (
              <li key={option.dto.id}>
                <button
                  type="button"
                  aria-pressed={chosen}
                  onClick={() => {
                    onChange(option.dto.id);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-foreground/5 ${chosen ? "bg-foreground/[0.04]" : ""}`}
                >
                  <TokenIcon symbol={option.token.symbol} icon={tokenIcons(option.token)} size={28} />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{option.token.symbol}</span>
                    {/* The hub's display name when it sets one, else the app's name for a token it knows, else the hub's name. */}
                    <span className="block truncate text-xs text-muted-foreground">{option.token.name}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
