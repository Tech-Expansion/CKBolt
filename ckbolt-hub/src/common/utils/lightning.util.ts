import { BOLT11_PREFIXES, LND_BLOCK_PADDING_BLOCKS, LND_CLTV_LIMIT_MIN_EXCESS_BLOCKS } from "../constants/protocol.constants";
import type { BtcNetwork } from "../../domain/types";

/**
 * Smallest `cltv_limit` LND accepts for paying an invoice whose final CLTV is `finalCltvExpiry`: LND adds its block
 * padding to the final CLTV and wants the limit strictly above the sum. The timing policy and the LND adapter both use
 * it, so a limit the policy accepts is never refused by LND.
 */
export const minLnCltvLimit = (finalCltvExpiry: number): number =>
  finalCltvExpiry + LND_BLOCK_PADDING_BLOCKS + LND_CLTV_LIMIT_MIN_EXCESS_BLOCKS;

/** The Bitcoin network a BOLT11 invoice is for, read from its human-readable prefix; null when it has none we know. */
export function bolt11Network(paymentRequest: string): BtcNetwork | null {
  const request = paymentRequest.trim().toLowerCase();
  return BOLT11_PREFIXES.find(({ prefix }) => request.startsWith(prefix))?.network ?? null;
}

/** Sats as a JS number, for Lightning libraries that take amounts as numbers. Throws when precision would be lost. */
export function satsToNumber(sats: bigint): number {
  if (sats < 0n || sats > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`Not a payable amount of sats: ${sats}`);
  return Number(sats);
}
