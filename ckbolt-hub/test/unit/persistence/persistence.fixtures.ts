import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MS_PER_MINUTE } from "../../../src/common/constants/protocol.constants";
import { SWAP_EVENT } from "../../../src/common/constants/swap.constants";
import { sha256Hex } from "../../../src/common/utils/hex.util";
import type { Hex32, Quote, Swap, SwapEvent } from "../../../src/domain/types";
import type { FakeClock } from "../../fakes";

/**
 * Builders and file helpers for the persistence tests. Values are realistic for the hub (hashes are sha256 of a random
 * preimage, amounts are base units), so the store sees the same shapes the engine gives it.
 */

/** 2^64 + 1: a u128 Fiber amount (RUSD base units) that no JS number or SQLite INTEGER can hold. */
export const BEYOND_U64 = 2n ** 64n + 1n;
/** Largest u128, the widest amount fnn accepts. */
export const MAX_U128 = 2n ** 128n - 1n;

export const QUOTE_TTL_MS = 3 * MS_PER_MINUTE;

export const newPreimage = (): Hex32 => randomBytes(32).toString("hex");
export const newPaymentHash = (): Hex32 => sha256Hex(newPreimage());

export function makeQuote(clock: FakeClock, overrides: Partial<Quote> = {}): Quote {
  const createdAt = clock.now();
  return {
    id: randomUUID(),
    direction: "ln_to_fiber",
    asset: "CKB",
    sats: 50_000n,
    fiberAmount: 12_345_678_900n,
    btcUsd: 67_123.45,
    assetUsd: 0.01234567,
    priceSource: "median(coingecko,binance,kucoin)",
    priceAt: createdAt - 1_000,
    feeBps: 100,
    purpose: "swap",
    createdAt,
    expiresAt: createdAt + QUOTE_TTL_MS,
    signature: randomBytes(64).toString("hex"),
    hubPubkey: randomBytes(32).toString("hex"),
    ...overrides,
  };
}

export function makeSwap(clock: FakeClock, overrides: Partial<Swap> = {}): Swap {
  const now = clock.now();
  return {
    id: randomUUID(),
    quoteId: randomUUID(),
    direction: "ln_to_fiber",
    asset: "CKB",
    paymentHash: newPaymentHash(),
    sats: 50_000n,
    fiberAmount: 12_345_678_900n,
    payoutInvoice: `fibt${randomBytes(20).toString("hex")}`,
    holdInvoice: `lnbcrt${randomBytes(20).toString("hex")}`,
    state: "pending",
    preimage: null,
    failureReason: null,
    refunded: false,
    holdCltvExpiry: 120,
    holdFinalExpiryDeltaMs: null,
    payoutLockLimit: 14 * 24 * 60 * MS_PER_MINUTE,
    quoteExpiresAt: now + QUOTE_TTL_MS,
    cancelTokenHash: newPaymentHash(),
    demo: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** A fiber_to_ln swap: the other set of nullable timing fields is filled. */
export function makeFiberToLnSwap(clock: FakeClock, overrides: Partial<Swap> = {}): Swap {
  return makeSwap(clock, {
    direction: "fiber_to_ln",
    asset: "RUSD",
    payoutInvoice: `lnbcrt${randomBytes(20).toString("hex")}`,
    holdInvoice: `fibt${randomBytes(20).toString("hex")}`,
    holdCltvExpiry: null,
    holdFinalExpiryDeltaMs: 6 * 60 * MS_PER_MINUTE,
    payoutLockLimit: 400,
    demo: true,
    ...overrides,
  });
}

export function makeEvent(swapId: string, at: number, type: string = SWAP_EVENT.CREATED, detail = ""): SwapEvent {
  return { swapId, at, type, detail };
}

/** A fresh directory under the OS temp folder, removed by `removeTempDir`. */
export const makeTempDir = (): string => mkdtempSync(join(tmpdir(), "ckbolt-persistence-"));

export const removeTempDir = (dir: string): void => rmSync(dir, { recursive: true, force: true });
