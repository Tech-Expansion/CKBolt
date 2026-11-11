import { HubApiError } from "@/lib/hub/client";
import { API_ERROR_CODE, type Direction, type FiberAssetId, type LegDto, type SwapDto, type SwapEventDto, type SwapState } from "@/lib/hub/contract";
import { UUID_PATTERN } from "@/lib/hub/constants";
import { accumulateProgress, NO_PROGRESS } from "@/lib/hub/lifecycle";
import { FUNDED_STATES } from "./constants";

/**
 * The swaps the app starts (the swap card, Pay's Lightning invoices, Get paid's Lightning invoices), kept where the
 * Fiber node's History reads them (docs/pay-get-paid.md, part E): localStorage per hub network, the newest
 * SWAP_HISTORY.max. The app page writes a swap as its run moves; the node (the header popup's iframe or the node page,
 * same origin, same storage) reads them, merges each with its own leg of the swap by the payment hash, and reads the
 * ones not final yet from the hub again. Both may write, so a write merges with what is stored and never moves a swap
 * back. Only what History shows is kept: the swap's id, direction, asset, amounts, payment hash, time and state. No
 * invoice, no preimage, nothing a wallet holds.
 */

export const SWAP_HISTORY = {
  /** The most swaps kept per network (the newest). */
  max: 100,
  /** localStorage key prefix: `<prefix>:<network>`. */
  storagePrefix: "ckbolt:swap-history",
  /** The node reads the swaps not final yet from the hub this often. */
  refreshMs: 10_000,
} as const;

/** One side of a swap as History shows it (the hub's leg without its invoice). */
export type RecordLeg = Pick<LegDto, "network" | "asset" | "amount" | "decimals">;

export interface SwapRecord {
  id: string;
  direction: Direction;
  asset: FiberAssetId;
  /** The Fiber asset's display symbol when the swap started. */
  symbol: string;
  /** Hex as the hub writes it (bare); both legs share it. */
  paymentHash: string;
  pay: RecordLeg;
  receive: RecordLeg;
  /** ISO time the hub created the swap. */
  createdAt: string;
  state: SwapState;
  /** The hub cancelled the incoming hold (a failed swap's payment went back, or nothing was paid). */
  refunded: boolean;
  /** The hub held the visitor's payment at some point: a failed swap was refunded rather than cancelled. */
  funded: boolean;
}

/** The part of the hub client a refresh uses; tests pass a fake. */
export interface SwapReader {
  getSwap(id: string): Promise<SwapDto>;
  listSwapEvents(id: string): Promise<SwapEventDto[]>;
}

/** The part of Web Storage the store uses; tests pass a map. */
export interface SwapHistoryStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Nothing more will change: succeeded, or failed with its hold cancelled. */
export const isRecordFinal = (record: Pick<SwapRecord, "state" | "refunded">): boolean =>
  record.state === "succeeded" || (record.state === "failed" && record.refunded);

const funded = (state: SwapState): boolean => (FUNDED_STATES as readonly SwapState[]).includes(state);
const legOf = ({ network, asset, amount, decimals }: RecordLeg): RecordLeg => ({ network, asset, amount, decimals });

/** The hub's swap as History keeps it; `held` says the hub held the payment (from the run's progress or its events). */
export function recordOf(swap: SwapDto, symbol: string, held: boolean): SwapRecord {
  return {
    id: swap.id,
    direction: swap.direction,
    asset: swap.asset,
    symbol,
    paymentHash: swap.paymentHash,
    pay: legOf(swap.pay),
    receive: legOf(swap.receive),
    createdAt: swap.createdAt,
    state: swap.state,
    refunded: swap.refunded,
    funded: held || funded(swap.state),
  };
}

/** How far a swap got: the hub's states only move forward, and both ends (succeeded, failed) are as far as it goes. */
const STATE_RANK: Readonly<Record<SwapState, number>> = {
  pending: 0,
  incoming_accepted: 1,
  outgoing_in_flight: 2,
  outgoing_succeeded: 3,
  succeeded: 4,
  failed: 4,
};

/**
 * One swap as two writers saw it (the page's run, the node's read from the hub), merged: the state that got further
 * wins (an older read never moves it back), the first symbol known stays, and refunded or funded once stays so.
 */
export function mergeSwapRecord(kept: SwapRecord, next: SwapRecord): SwapRecord {
  const ahead = STATE_RANK[next.state] >= STATE_RANK[kept.state] ? next : kept;
  return { ...ahead, symbol: kept.symbol || next.symbol, refunded: kept.refunded || next.refunded, funded: kept.funded || next.funded };
}

/** Merges the swap with the same id where it is, or adds it, newest first by creation; the oldest drop past the cap. */
export function upsertSwapRecord(records: readonly SwapRecord[], record: SwapRecord): SwapRecord[] {
  const kept = records.find((r) => r.id === record.id);
  const next = kept ? records.map((r) => (r.id === record.id ? mergeSwapRecord(kept, record) : r)) : [record, ...records];
  return [...next].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, SWAP_HISTORY.max);
}

/** A payment hash as History keys it: 0x and lowercase (the hub writes it bare, fnn with 0x). */
export const hashKey = (hash: string): string => `0x${hash.toLowerCase().replace(/^0x/, "")}`;

/**
 * The swap as the hub has it now. A failed swap that never showed a held payment: its events tell whether there was one,
 * so a refund is told from a swap where nothing was paid.
 */
export async function readSwapRecord(hub: SwapReader, record: Pick<SwapRecord, "id" | "symbol" | "funded">): Promise<{ swap: SwapDto; record: SwapRecord }> {
  const swap = await hub.getSwap(record.id);
  const held = swap.state === "failed" && !record.funded ? accumulateProgress(NO_PROGRESS, swap, await hub.listSwapEvents(swap.id)).funded : false;
  return { swap, record: recordOf(swap, record.symbol, held || record.funded) };
}

/** The hub has no such swap (another hub, or its data was reset): asking again would not change that. */
export const unknownToHub = (e: unknown): boolean => e instanceof HubApiError && (e.status === 404 || e.code === API_ERROR_CODE.NOT_FOUND);

/* ------------------------------------------------------------------------------------------- storage */

/** Where a network's swaps are kept; the node listens for changes to it (the storage event). */
export const swapHistoryKey = (network: string): string => `${SWAP_HISTORY.storagePrefix}:${network}`;

const DIRECTIONS: readonly string[] = ["ln_to_fiber", "fiber_to_ln"];
const STATES: readonly string[] = Object.keys(STATE_RANK);
const HASH = /^(0x)?[0-9a-f]{64}$/i;
const BASE_UNITS = /^\d{1,30}$/;
const isRecordLike = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isLeg = (v: unknown): v is RecordLeg =>
  isRecordLike(v) &&
  (v.network === "lightning" || v.network === "fiber") &&
  typeof v.asset === "string" &&
  typeof v.amount === "string" &&
  BASE_UNITS.test(v.amount) &&
  Number.isInteger(v.decimals);

function readRecord(value: unknown): SwapRecord | null {
  if (!isRecordLike(value)) return null;
  const ok =
    typeof value.id === "string" &&
    UUID_PATTERN.test(value.id) &&
    typeof value.direction === "string" &&
    DIRECTIONS.includes(value.direction) &&
    typeof value.asset === "string" &&
    typeof value.symbol === "string" &&
    typeof value.paymentHash === "string" &&
    HASH.test(value.paymentHash) &&
    isLeg(value.pay) &&
    isLeg(value.receive) &&
    typeof value.createdAt === "string" &&
    !Number.isNaN(Date.parse(value.createdAt)) &&
    typeof value.state === "string" &&
    STATES.includes(value.state) &&
    typeof value.refunded === "boolean" &&
    typeof value.funded === "boolean";
  if (!ok) return null;
  // Only the listed fields come back, whatever else was stored.
  const r = value as unknown as SwapRecord;
  return {
    id: r.id,
    direction: r.direction,
    asset: r.asset,
    symbol: r.symbol,
    paymentHash: r.paymentHash,
    pay: legOf(r.pay),
    receive: legOf(r.receive),
    createdAt: r.createdAt,
    state: r.state,
    refunded: r.refunded,
    funded: r.funded,
  };
}

/** The swaps kept for `network`, newest first; empty when none, unreadable, or storage is blocked. */
export function readSwapHistory(store: SwapHistoryStore | null, network: string): SwapRecord[] {
  try {
    const parsed: unknown = JSON.parse(store?.getItem(swapHistoryKey(network)) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(readRecord)
      .filter((r): r is SwapRecord => r !== null)
      .slice(0, SWAP_HISTORY.max);
  } catch {
    return [];
  }
}

/** Keeps the swaps for `network` (the newest SWAP_HISTORY.max); without storage they last until the page closes. */
export function saveSwapHistory(store: SwapHistoryStore | null, network: string, records: readonly SwapRecord[]): void {
  try {
    store?.setItem(swapHistoryKey(network), JSON.stringify(records.slice(0, SWAP_HISTORY.max).map(readRecord).filter(Boolean)));
  } catch {
    // Blocked or full storage: the swap is not kept.
  }
}

/**
 * Keeps one swap: reads what is stored now (the other document may have written since), merges the swap into it and
 * writes it back in the same task, so neither writer drops the other's swaps. Returns the list as stored.
 */
export function keepSwapRecord(store: SwapHistoryStore | null, network: string, record: SwapRecord): SwapRecord[] {
  const records = upsertSwapRecord(readSwapHistory(store, network), record);
  saveSwapHistory(store, network, records);
  return records;
}
