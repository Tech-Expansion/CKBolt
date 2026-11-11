import type { FiberAssetId } from "@/lib/hub/contract";
import {
  CHANNEL_FEE_MARGIN_CKB,
  CHANNEL_RESERVE_CKB,
  CKB_DECIMALS,
  MIN_CHANNEL_CONTRIBUTION_CKB,
  NODE_CHANNEL_CONTRIBUTION_CKB,
  STORAGE_NAME,
} from "./constants";
import { CKB_ASSET, ckbToShannons } from "./channels";
import { storageKey, type KeyValueStore } from "./storage";

/**
 * The CKB the browser node puts into the hub's CKB channel when it accepts it: what it can pay out at once. The visitor
 * chooses it on the node page for each request; the node accepts the hub's channel with that amount (accept_channel,
 * hub-accept.ts), so a new amount needs no restart. The last valid amount is saved per network as the next default. An
 * open channel keeps what went in.
 */

const DIGITS = /^\d+$/;
/** Group separators a typed amount may carry: "49,000" and "49 000" both read as 49000. */
const GROUPING = /[,\s_]/g;

/** A typed amount as whole CKB the node may put in (at least MIN_CHANNEL_CONTRIBUTION_CKB), or null. */
export function parseContribution(text: string): number | null {
  const digits = text.replace(GROUPING, "");
  if (!DIGITS.test(digits)) return null;
  const ckb = Number(digits);
  return Number.isSafeInteger(ckb) && ckb >= MIN_CHANNEL_CONTRIBUTION_CKB ? ckb : null;
}

const contributionKey = (network: string): string => storageKey(network, STORAGE_NAME.CHANNEL_CONTRIBUTION);

/** The saved amount for `network`, or the default when none is saved, it does not parse, or storage is blocked. */
export function readContribution(store: KeyValueStore | null, network: string): number {
  try {
    return parseContribution(store?.getItem(contributionKey(network)) ?? "") ?? NODE_CHANNEL_CONTRIBUTION_CKB;
  } catch {
    return NODE_CHANNEL_CONTRIBUTION_CKB;
  }
}

/** Saves the amount for `network`; without storage it lasts until the page closes. */
export function saveContribution(store: KeyValueStore | null, network: string, ckb: number): void {
  try {
    store?.setItem(contributionKey(network), String(ckb));
  } catch {
    // Blocked storage: the page keeps the amount in memory.
  }
}

/** The CKB a side of a channel in `asset` locks as its reserve: CKB's own, or the same default for every token. */
export const channelReserveCkb = (asset: FiberAssetId): number => (asset === CKB_ASSET ? CHANNEL_RESERVE_CKB.CKB : CHANNEL_RESERVE_CKB.UDT);

/**
 * CKB the node must hold before it asks the hub for a channel in `asset`, so its accept cannot fail: what it puts into
 * a CKB channel, or the reserve of a token channel (any token the hub lists), plus the fee margin.
 */
export function ckbNeededToAccept(asset: FiberAssetId, contributionCkb: number): number {
  const own = asset === CKB_ASSET ? contributionCkb : channelReserveCkb(asset);
  return own + CHANNEL_FEE_MARGIN_CKB;
}

/** The most whole CKB the node can put in from `balance` shannons, keeping the fee margin (0 when it holds less). */
export function largestContribution(balance: bigint): number {
  const whole = Number(balance / BigInt(10 ** CKB_DECIMALS));
  return Math.max(0, whole - CHANNEL_FEE_MARGIN_CKB);
}

/** What the node can pay at once out of `contributionCkb`: all of it but the channel reserve. */
export const spendableContribution = (contributionCkb: number): number => contributionCkb - CHANNEL_RESERVE_CKB.CKB;

/**
 * What a new channel from the hub lets the node move at once, in the asset's base units: send its own share less its
 * reserve, receive the hub's share (`hubAmount`) less the hub's reserve. A token channel's reserves are CKB, so the
 * node sends none of the token at first and can receive all the hub puts in.
 */
export function newChannelCapacity(asset: FiberAssetId, hubAmount: bigint, contributionCkb: number): { send: bigint; receive: bigint } {
  if (asset !== CKB_ASSET) return { send: BigInt(0), receive: hubAmount };
  const reserve = ckbToShannons(CHANNEL_RESERVE_CKB.CKB);
  return {
    send: ckbToShannons(Math.max(0, spendableContribution(contributionCkb))),
    receive: hubAmount > reserve ? hubAmount - reserve : BigInt(0),
  };
}
