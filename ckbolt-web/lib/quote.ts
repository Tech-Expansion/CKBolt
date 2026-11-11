/**
 * Quote maths of the landing page's examples, and USD formatting.
 *
 * Market rates are reference prices, not executable. The cost parameters below
 * are PROTOTYPE ASSUMPTIONS, not measured values from live liquidity. The app's
 * swaps use firm quotes from the CKBolt hub instead (stage 3, live testnet swaps).
 */

import { fmtRate } from "./format";
import type { Token } from "./tokens";

export const QUOTE_ASSUMPTIONS = {
  /** Spread charged by a hypothetical liquidity provider. */
  liquiditySpreadPct: 0.5,
  /** Lightning or Fiber routing fee budget. */
  routingFeeBudgetPct: 0.5,
  /** Extra headroom the user authorises above or below the estimate. */
  slippagePct: 1,
  /** Seconds a quote stays valid in the prototype. */
  quoteTtlSeconds: 60,
} as const;

/** What the payer adds on top of the market value (1.01 with the defaults). */
export const HUB_COST_FACTOR = 1 + (QUOTE_ASSUMPTIONS.liquiditySpreadPct + QUOTE_ASSUMPTIONS.routingFeeBudgetPct) / 100;
/** What the receiver keeps of the market value (0.99 with the defaults). */
export const HUB_OUT_FACTOR = 1 - (QUOTE_ASSUMPTIONS.liquiditySpreadPct + QUOTE_ASSUMPTIONS.routingFeeBudgetPct) / 100;
const SLIPPAGE = QUOTE_ASSUMPTIONS.slippagePct / 100;

export interface RateSnapshot {
  btcUsd: number;
  ethUsd: number;
  ckbUsd: number;
  source: string;
  /** Unix ms when the upstream source reported the price (or when we fetched it). */
  updatedAt: number;
}

export type SwapAsset = "BTC" | "ETH";

export function formatUsd(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: n < 0.01 ? 6 : n < 1 ? 4 : 2,
    maximumFractionDigits: n < 0.01 ? 6 : n < 1 ? 4 : 2,
  });
}

/** BTC and ETH amounts. Small values get more decimals so they never show as zero. */
export function formatAsset(n: number, asset: SwapAsset): string {
  const digits = asset === "BTC" ? (n >= 0.001 ? 6 : 8) : n >= 0.01 ? 4 : n >= 0.0001 ? 6 : 8;
  if (n > 0 && n < 10 ** -digits) return `< ${(10 ** -digits).toFixed(digits)}`;
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Sats a customer pays for a USD value, rounded up to a whole sat. */
export function satsForUsd(usd: number, rate: RateSnapshot): { marketSats: number; sats: number } {
  const marketSats = (usd / rate.btcUsd) * 1e8;
  return { marketSats, sats: Math.ceil(marketSats * HUB_COST_FACTOR) };
}

export type QuoteView = {
  /** Amount paid, in the pay side's display unit (token units, or sats for BTC in). */
  payAmount: number;
  /** Upper bound the payer authorises. */
  maxPay: number;
  /** Amount received, numeric, in the receive side's unit. */
  receiveAmount: number;
  /** Lower bound the receiver accepts. */
  minReceive: number;
  receive: string;
  rateLine: string;
  costs: { label: string; value: string; note?: string }[];
};

const assumedCosts = () => [
  { label: "Liquidity spread", value: `${QUOTE_ASSUMPTIONS.liquiditySpreadPct}%`, note: "Assumed" },
  { label: "Routing cost", value: `${QUOTE_ASSUMPTIONS.routingFeeBudgetPct}%`, note: "Assumed" },
];

/** CKB-side token in, BTC on Lightning or ETH out. */
export function quoteSwap(amount: number, pay: Token, dest: SwapAsset, rate: RateSnapshot): QuoteView | null {
  const price = pay.usdPrice(rate);
  if (price === null) return null;
  const usd = amount * price;
  const destPrice = dest === "BTC" ? rate.btcUsd : rate.ethUsd;
  const market = usd / destPrice;
  const estimated = market * HUB_OUT_FACTOR;
  const min = estimated * (1 - SLIPPAGE);
  return {
    payAmount: amount,
    maxPay: amount,
    receiveAmount: estimated,
    minReceive: min,
    receive: `${formatAsset(estimated, dest)} ${dest}`,
    rateLine: `1 ${dest} = ${fmtRate(destPrice / price)} ${pay.symbol}`,
    costs: [
      { label: "At reference price", value: `${formatAsset(market, dest)} ${dest}` },
      ...assumedCosts(),
      { label: "Minimum received", value: `${formatAsset(min, dest)} ${dest}`, note: `${QUOTE_ASSUMPTIONS.slippagePct}% slippage limit` },
      { label: "Value", value: formatUsd(usd) },
    ],
  };
}
