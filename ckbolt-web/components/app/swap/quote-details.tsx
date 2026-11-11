"use client";

import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { AssetDto, Direction, QuoteDto } from "@/lib/hub/contract";
import { feePercent, formatTime } from "@/lib/hub/format";
import { CARD_COPY, DETAILS_COPY } from "@/lib/swap/copy";
import { compactRateLine, formatSats, routeLine } from "@/lib/swap/format";
import { cn } from "@/lib/utils";
import { Row } from "../ui";
import { InfoTip } from "./info-tip";

const Dot = () => (
  <span aria-hidden="true" className="text-foreground/30">
    ·
  </span>
);

/**
 * Under the boxes: the rate and the fee with its "?" on the left, and "Details" on the right, which opens the route, the
 * per-swap limits and where the price came from. The toggle keeps its place at the end of the first line, so on a phone
 * the rate and fee wrap under each other rather than pushing it onto a line of its own. The quote's countdown sits in
 * the receive box, under the amount it holds.
 */
export function QuoteDetails({ direction, quote, asset }: { direction: Direction; quote: QuoteDto | null; asset: AssetDto | null }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const symbol = asset?.symbol ?? quote?.asset ?? "";
  return (
    <div className="font-mono text-xs text-muted-foreground" data-testid="swap-details">
      <div className="flex min-h-10 items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {quote && (
            <>
              <span className="text-foreground">{compactRateLine(quote, symbol)}</span>
              <Dot />
              <span className="inline-flex items-center gap-1">
                {DETAILS_COPY.FEE} {feePercent(quote.feeBps)}
                <InfoTip label={DETAILS_COPY.FEE_TIP_LABEL}>{DETAILS_COPY.FEE_TIP}</InfoTip>
              </span>
            </>
          )}
        </div>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((o) => !o)}
          className="inline-flex min-h-10 shrink-0 items-center gap-1 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          {DETAILS_COPY.TOGGLE}
          <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} aria-hidden="true" />
        </button>
      </div>
      <dl id={panelId} hidden={!open} className="border-t border-foreground/10 font-sans">
        <Row label={DETAILS_COPY.ROUTE} value={routeLine(direction)} />
        {asset && <Row label={DETAILS_COPY.PER_SWAP} value={DETAILS_COPY.PER_SWAP_VALUE(formatSats(asset.minSats), formatSats(asset.maxSats))} />}
        <Row
          label={DETAILS_COPY.PRICE}
          value={quote ? DETAILS_COPY.PRICE_VALUE(quote.prices.source, formatTime(quote.prices.at)) : CARD_COPY.EMPTY_AMOUNT}
        />
      </dl>
    </div>
  );
}
