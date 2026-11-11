import type { Direction, LegDto, QuoteDto } from "@/lib/hub/contract";
import { formatLeg, formatUnits } from "@/lib/hub/format";
import { formatUsd } from "@/lib/quote";
import { legUsd } from "./amount";
import { SWAP_CARD } from "./constants";
import { CARD_COPY, DETAILS_COPY, PROGRESS_COPY } from "./copy";

/** Display helpers of the live swap card. Amounts stay exact; only rates are compacted. */

const COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: SWAP_CARD.compactRateFractionDigits });

/** "54.56M", "80K", "1.5": a rate short enough for the details row. */
export const compactNumber = (n: number): string => COMPACT.format(n);

/** "1 BTC = 54.56M CKB", from the prices the hub quoted with. */
export const compactRateLine = (quote: Pick<QuoteDto, "prices">, symbol: string): string =>
  `1 BTC = ${compactNumber(quote.prices.btcUsd / quote.prices.assetUsd)} ${symbol}`;

/** Whole sats, grouped: "20,000". */
export const formatSats = (sats: string): string => formatUnits(sats, 0);

/** A leg's amount without its unit, as the card's big figures show it: "2,000" (sats), "1,091.23" (tokens). */
export const legFigure = (leg: LegDto): string => formatUnits(leg.amount, leg.network === "lightning" ? 0 : leg.decimals);

/** A leg's amount with its unit: "2,000 sats", "1,091.23 CKB". */
export const legText = (leg: LegDto, symbol: string): string => formatLeg(leg, symbol);

/** "≈ $1.62": a leg's value at the quote's prices. */
export const usdHint = (leg: LegDto, prices: QuoteDto["prices"]): string => CARD_COPY.USD_HINT(formatUsd(legUsd(leg, prices)));

/** "2,000 sats to 1,091.23 CKB". */
export const pairLine = (quote: Pick<QuoteDto, "pay" | "receive">, symbol: string): string =>
  PROGRESS_COPY.PAIR(legText(quote.pay, symbol), legText(quote.receive, symbol));

/** The route the swap takes, from the user's side. */
export const routeLine = (direction: Direction): string =>
  direction === "ln_to_fiber" ? DETAILS_COPY.ROUTE_LN_TO_FIBER : DETAILS_COPY.ROUTE_FIBER_TO_LN;

/** "abcdef0123…456789abcd": a long hash or id shortened in the middle. */
export const shortHash = (value: string, edge: number = SWAP_CARD.shortHashChars): string =>
  value.length > edge * 2 + 1 ? `${value.slice(0, edge)}…${value.slice(-edge)}` : value;

/** True when a figure is long enough to need the smaller size on a phone. */
export const isLongFigure = (text: string): boolean => text.length > SWAP_CARD.longAmountChars;
