import { fromDecimalString, toDecimalString } from "../../common/utils/amount.util";
import type { Direction, FiberAssetId, Hex32, Quote, QuotePurpose, Swap, SwapEvent, SwapState } from "../../domain/types";
import { columnsOf } from "./sql.util";
import { SQL_FALSE, SQL_TRUE } from "./sqlite.constants";

/** Rows as SQLite stores them: bigints as decimal TEXT, times as INTEGER ms, booleans as INTEGER 0 or 1. */

export interface QuoteRow {
  id: string;
  direction: Direction;
  asset: FiberAssetId;
  sats: string;
  fiber_amount: string;
  btc_usd: number;
  asset_usd: number;
  price_source: string;
  price_at: number;
  fee_bps: number;
  purpose: QuotePurpose;
  created_at: number;
  expires_at: number;
  signature: string;
  hub_pubkey: string;
}

export interface SwapRow {
  id: string;
  quote_id: string;
  direction: Direction;
  asset: FiberAssetId;
  payment_hash: Hex32;
  sats: string;
  fiber_amount: string;
  payout_invoice: string;
  hold_invoice: string;
  state: SwapState;
  preimage: Hex32 | null;
  failure_reason: string | null;
  refunded: number;
  hold_cltv_expiry: number | null;
  hold_final_expiry_delta_ms: number | null;
  payout_lock_limit: number | null;
  quote_expires_at: number;
  cancel_token_hash: Hex32 | null;
  demo: number;
  created_at: number;
  updated_at: number;
}

export interface SwapEventRow {
  swap_id: string;
  at: number;
  type: string;
  detail: string;
}

export const QUOTE_COLUMNS = columnsOf<QuoteRow>({
  id: true,
  direction: true,
  asset: true,
  sats: true,
  fiber_amount: true,
  btc_usd: true,
  asset_usd: true,
  price_source: true,
  price_at: true,
  fee_bps: true,
  purpose: true,
  created_at: true,
  expires_at: true,
  signature: true,
  hub_pubkey: true,
});

export const SWAP_COLUMNS = columnsOf<SwapRow>({
  id: true,
  quote_id: true,
  direction: true,
  asset: true,
  payment_hash: true,
  sats: true,
  fiber_amount: true,
  payout_invoice: true,
  hold_invoice: true,
  state: true,
  preimage: true,
  failure_reason: true,
  refunded: true,
  hold_cltv_expiry: true,
  hold_final_expiry_delta_ms: true,
  payout_lock_limit: true,
  quote_expires_at: true,
  cancel_token_hash: true,
  demo: true,
  created_at: true,
  updated_at: true,
});

export const SWAP_EVENT_COLUMNS = columnsOf<SwapEventRow>({
  swap_id: true,
  at: true,
  type: true,
  detail: true,
});

const toSqlBoolean = (value: boolean): number => (value ? SQL_TRUE : SQL_FALSE);
const fromSqlBoolean = (value: number): boolean => value === SQL_TRUE;

export const toQuoteRow = (quote: Quote): QuoteRow => ({
  id: quote.id,
  direction: quote.direction,
  asset: quote.asset,
  sats: toDecimalString(quote.sats),
  fiber_amount: toDecimalString(quote.fiberAmount),
  btc_usd: quote.btcUsd,
  asset_usd: quote.assetUsd,
  price_source: quote.priceSource,
  price_at: quote.priceAt,
  fee_bps: quote.feeBps,
  purpose: quote.purpose,
  created_at: quote.createdAt,
  expires_at: quote.expiresAt,
  signature: quote.signature,
  hub_pubkey: quote.hubPubkey,
});

export const fromQuoteRow = (row: QuoteRow): Quote => ({
  id: row.id,
  direction: row.direction,
  asset: row.asset,
  sats: fromDecimalString(row.sats),
  fiberAmount: fromDecimalString(row.fiber_amount),
  btcUsd: row.btc_usd,
  assetUsd: row.asset_usd,
  priceSource: row.price_source,
  priceAt: row.price_at,
  feeBps: row.fee_bps,
  purpose: row.purpose,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  signature: row.signature,
  hubPubkey: row.hub_pubkey,
});

export const toSwapRow = (swap: Swap): SwapRow => ({
  id: swap.id,
  quote_id: swap.quoteId,
  direction: swap.direction,
  asset: swap.asset,
  payment_hash: swap.paymentHash,
  sats: toDecimalString(swap.sats),
  fiber_amount: toDecimalString(swap.fiberAmount),
  payout_invoice: swap.payoutInvoice,
  hold_invoice: swap.holdInvoice,
  state: swap.state,
  preimage: swap.preimage,
  failure_reason: swap.failureReason,
  refunded: toSqlBoolean(swap.refunded),
  hold_cltv_expiry: swap.holdCltvExpiry,
  hold_final_expiry_delta_ms: swap.holdFinalExpiryDeltaMs,
  payout_lock_limit: swap.payoutLockLimit,
  quote_expires_at: swap.quoteExpiresAt,
  cancel_token_hash: swap.cancelTokenHash,
  demo: toSqlBoolean(swap.demo),
  created_at: swap.createdAt,
  updated_at: swap.updatedAt,
});

export const fromSwapRow = (row: SwapRow): Swap => ({
  id: row.id,
  quoteId: row.quote_id,
  direction: row.direction,
  asset: row.asset,
  paymentHash: row.payment_hash,
  sats: fromDecimalString(row.sats),
  fiberAmount: fromDecimalString(row.fiber_amount),
  payoutInvoice: row.payout_invoice,
  holdInvoice: row.hold_invoice,
  state: row.state,
  preimage: row.preimage,
  failureReason: row.failure_reason,
  refunded: fromSqlBoolean(row.refunded),
  holdCltvExpiry: row.hold_cltv_expiry,
  holdFinalExpiryDeltaMs: row.hold_final_expiry_delta_ms,
  payoutLockLimit: row.payout_lock_limit,
  quoteExpiresAt: row.quote_expires_at,
  cancelTokenHash: row.cancel_token_hash,
  demo: fromSqlBoolean(row.demo),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const toSwapEventRow = (event: SwapEvent): SwapEventRow => ({
  swap_id: event.swapId,
  at: event.at,
  type: event.type,
  detail: event.detail,
});

export const fromSwapEventRow = (row: SwapEventRow): SwapEvent => ({
  swapId: row.swap_id,
  at: row.at,
  type: row.type,
  detail: row.detail,
});
