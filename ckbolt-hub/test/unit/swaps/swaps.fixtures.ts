import "reflect-metadata";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import type { FiberHashAlgorithm, FiberPaymentStatus } from "../../../src/application/ports/fiber.port";
import type { LnPaymentStatus } from "../../../src/application/ports/lightning.port";
import type { AssetAvailability, PricingService } from "../../../src/application/pricing/pricing.contract";
import type { CreatedSwap } from "../../../src/application/swaps/swap-engine.contract";
import { SwapEngineService } from "../../../src/application/swaps/swap-engine.service";
import type { ApiErrorCode } from "../../../src/common/constants/api.constants";
import {
  FIBER_MAX_COMMITMENT_DELAY_EPOCHS,
  FIBER_MAX_TLC_EXPIRY_LIMIT_MS,
  FIBER_MIN_FINAL_EXPIRY_DELTA_MS,
  MS_PER_HOUR,
  MS_PER_MINUTE,
  MS_PER_SECOND,
  MSAT_PER_SAT,
} from "../../../src/common/constants/protocol.constants";
import { HubError } from "../../../src/common/errors/hub.error";
import { sha256Hex } from "../../../src/common/utils/hex.util";
import { assetRegistryOf, loadHubConfig, type HubConfig } from "../../../src/config/hub.config";
import type { AssetRegistry } from "../../../src/domain/assets";
import type { AssetLiquidity } from "../../../src/domain/pricing";
import type { TimingProfile } from "../../../src/domain/timing/timing.types";
import type { BtcNetwork, CkbNetwork, Direction, FiberAssetId, Hex32, Quote, Script, Swap } from "../../../src/domain/types";
import {
  encodeFake,
  FAKE_FIBER_PREFIX,
  FAKE_LN_PREFIX,
  FakeClock,
  FakeFiberNetwork,
  FakeLightningNetwork,
  FakeSwapStore,
  type FakeFiberNode,
  type FakeLightningNode,
} from "../../fakes";

/**
 * Shared fixtures for the swap engine tests. The engine runs on the fakes in test/fakes (they behave like LND and fnn
 * where the hub relies on them). Expected timing numbers are worked out by hand from docs/research/lnd.md 6.4 and the
 * regtest timing profile; nothing here reuses the implementation's own helpers, so the specs stay an independent check.
 */

/* ------------------------------------------------------------------------------------------------------ units */

export const seconds = (n: number): number => n * MS_PER_SECOND;
export const minutes = (n: number): number => n * MS_PER_MINUTE;
export const hours = (n: number): number => n * MS_PER_HOUR;

/* ----------------------------------------------------------------------------------------------------- config */

export const HUB_BTC_NETWORK: BtcNetwork = "regtest";
export const HUB_CKB_NETWORK: CkbNetwork = "devnet";

/** Devnet RUSD stand-in. The upper-case copy checks that scripts are compared without regard to hex case. */
export const RUSD_SCRIPT: Script = { codeHash: `0x${"ab".repeat(32)}`, hashType: "type", args: `0x${"01".repeat(32)}` };
export const RUSD_SCRIPT_UPPER_CASE: Script = { codeHash: `0x${"AB".repeat(32)}`, hashType: "type", args: `0x${"01".repeat(32)}` };
export const UNKNOWN_UDT_SCRIPT: Script = { codeHash: `0x${"ef".repeat(32)}`, hashType: "type", args: "0x03" };

/** Explicit swap settings, so the specs do not depend on env defaults. */
export const SWAP_SETTINGS: HubConfig["swaps"] = {
  pollIntervalMs: 1_000,
  lnPayTimeoutSeconds: 45,
  lnMaxFeeBps: 100,
  fiberMaxFeeBps: 50,
  lnMaxPaymentParts: 16,
  lnInvoiceRouteHints: false,
  fiberHoldFinalExpiryDeltaMs: hours(6),
  holdInvoiceExpiryToleranceMs: seconds(5),
  fiberPeerChannelCommitmentDelayEpochs: FIBER_MAX_COMMITMENT_DELAY_EPOCHS,
  payoutMaxResends: 3,
  payoutMissingConfirmMs: seconds(30),
  // High enough that the specs' swaps never meet them; the cap specs lower them.
  maxUnpaidSwapsPerClient: 1_000,
  maxUnpaidSwaps: 1_000,
  maxUnpaidSharePercent: 100,
  maxOpenRequestsPerClient: 1_000,
  paused: false,
};

/** The client key (an address, as the HTTP layer's clientKeyOf gives it) the specs create swaps as. */
export const TEST_CLIENT_KEY = "203.0.113.7";

export interface ConfigPatch {
  swaps?: Partial<HubConfig["swaps"]>;
  timing?: Partial<TimingProfile>;
  /** The hub's Bitcoin network (BTC_NETWORK); regtest unless a spec needs another. */
  btcNetwork?: BtcNetwork;
}

/** Regtest Bitcoin, devnet CKB with the RUSD stand-in, the regtest timing profile and SWAP_SETTINGS. */
export function swapConfig(patch: ConfigPatch = {}): HubConfig {
  const base = loadHubConfig({
    BTC_NETWORK: patch.btcNetwork ?? HUB_BTC_NETWORK,
    CKB_NETWORK: HUB_CKB_NETWORK,
    TIMING_PROFILE: "regtest",
    UDT_RUSD_SCRIPT: JSON.stringify(RUSD_SCRIPT),
  });
  return { ...base, swaps: { ...SWAP_SETTINGS, ...patch.swaps }, timing: { ...base.timing, ...patch.timing } };
}

/* ------------------------------------------------------------------------- hand-worked timing (regtest profile) */

/**
 * Regtest profile: fast block 30 s, slow block 15 min, ln margin 6 blocks, ln route budget 80 blocks, Fiber margin 10 min,
 * 1 Fiber hop, payer max 1008.
 */
export const LN_TO_FIBER = {
  /** F_max = 160 min payee delta + 1 hop x 4 h + 10 min margin = 410 min. */
  PAYOUT_LIMIT_MS: minutes(410),
  /** C = ceil(410 min / 30 s) + 18 (LND auto-cancel) + 6 (margin) + 3 (LND padding) = 820 + 27 = 847 blocks. */
  HOLD_CLTV: 847,
  /**
   * Once held at height h with expiry h + 847, the lock left after n blocks is (847 - 18 - 6 - n) x 30 s; it may lose the
   * 10-minute margin but must keep 400 min = 800 blocks, so n <= 23.
   */
  MAX_BLOCKS_BEFORE_PAYOUT: 23,
  /** The 30 s fast block, to turn blocks into the payout lock by hand. */
  FAST_BLOCK_MS: seconds(30),
  /** 18 auto-cancel blocks + 6 margin blocks are never used by the payout. */
  RESERVED_BLOCKS: 24,
};

export const FIBER_TO_LN = {
  /** Payee min_final_cltv of the user's Lightning invoice in these specs. */
  PAYOUT_CLTV_EXPIRY: 40,
  /**
   * max(6 h, (40 + 3 + 1 + 80) x 15 min + (161 + 10) min, 160 min) = max(360, 2031, 160) = 2031 minutes: LND takes a
   * cltv_limit only above the invoice CLTV plus its 3 padding blocks, so the payout needs at least 40 + 3 + 1 blocks.
   */
  HOLD_DELTA_MS: minutes(2031),
  /** A TLC paid with a 14-day limit expires after the hold delta plus one 4 h hop delta: 2271 minutes. */
  HELD_TLC_LIFETIME_MS: minutes(2271),
  /** fnn early fail (160 min + 60 s) plus the 10-minute margin: never usable by the Lightning payout. */
  HOLD_RESERVE_MS: minutes(171),
  SLOW_BLOCK_MS: minutes(15),
  /** cltv_limit right away = floor((2271 - 171) min / 15 min) = 140 blocks. */
  CLTV_LIMIT: 140,
  /** 40 + 3 + 1 = 44 blocks are needed: 44 x 15 + 171 = 831 minutes must remain, so at most 2271 - 831 = 1440 may pass. */
  MAX_MINUTES_BEFORE_PAYOUT: 1440,
};

/* ------------------------------------------------------------------------------------------------------ quotes */

export const HUB_PUBKEY = "11".repeat(32);
export const QUOTE_TTL_MS = seconds(180);

/** Default amounts: 10,000 sats against 3,960 or 4,040 CKB (shannons). */
export const QUOTE_AMOUNTS: Readonly<Record<Direction, Pick<Quote, "sats" | "fiberAmount">>> = {
  ln_to_fiber: { sats: 10_000n, fiberAmount: 396_000_000_000n },
  fiber_to_ln: { sats: 10_000n, fiberAmount: 404_000_000_000n },
};

/** Every field of a quote but its signature, as sorted JSON (bigints as decimal strings). */
const quoteFields = (quote: Omit<Quote, "signature">): string =>
  JSON.stringify(
    Object.fromEntries(Object.entries(quote).sort(([a], [b]) => a.localeCompare(b))),
    (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
  );

/** A stand-in signature over every field, so a quote changed after signing no longer verifies. */
export const fakeSignature = (quote: Omit<Quote, "signature">): string => createHash("sha256").update(quoteFields(quote)).digest("hex");

/** Payout balances so large that no spec's unpaid swaps reach their share of them (SWAP_MAX_UNPAID_SHARE_PERCENT). */
export const PLENTY_OF_LIQUIDITY: AssetLiquidity = { lightningSats: 10n ** 18n, fiberAmount: 10n ** 30n };

/**
 * Implements the pricing contract the way the engine uses it: quotes from the store, a signature check, and the payout
 * balances the unpaid-swap share is taken of (`liquidity`, for every asset; plenty unless a spec lowers it). It asks no
 * node for them, so the specs' node call counts stay the engine's own.
 */
export class StubPricingService implements PricingService {
  liquidity: AssetLiquidity = PLENTY_OF_LIQUIDITY;

  constructor(private readonly store: FakeSwapStore) {}

  createQuote(): Promise<Quote> {
    return Promise.reject(new Error("The swap engine never creates quotes."));
  }

  getQuote(id: string): Quote | null {
    return this.store.getQuote(id);
  }

  verifyQuote(quote: Quote): boolean {
    const { signature, ...unsigned } = quote;
    return quote.hubPubkey === HUB_PUBKEY && signature === fakeSignature(unsigned);
  }

  listAssets(): Promise<AssetAvailability[]> {
    return Promise.resolve([]);
  }

  liquidityFor(): Promise<AssetLiquidity> {
    return Promise.resolve(this.liquidity);
  }
}

/* ----------------------------------------------------------------------------------------------------- harness */

export const START_HEIGHT = 100;

export interface SwapHarness {
  config: HubConfig;
  clock: FakeClock;
  lnNet: FakeLightningNetwork;
  fiberNet: FakeFiberNetwork;
  /** The hub's own nodes (LIGHTNING, FIBER). */
  hubLn: FakeLightningNode;
  hubFiber: FakeFiberNode;
  /** The user's nodes: they issue payout invoices and pay hold invoices. */
  userLn: FakeLightningNode;
  userFiber: FakeFiberNode;
  store: FakeSwapStore;
  pricing: StubPricingService;
  assets: AssetRegistry;
  engine: SwapEngineService;
  /** A new engine on the same store and nodes: the hub after a restart. Replaces `engine`. */
  restart(): SwapEngineService;
}

export function makeSwapHarness(patch: ConfigPatch = {}): SwapHarness {
  const config = swapConfig(patch);
  const clock = new FakeClock();
  const lnNet = new FakeLightningNetwork(HUB_BTC_NETWORK, clock, START_HEIGHT);
  const fiberNet = new FakeFiberNetwork(HUB_CKB_NETWORK, clock);
  const store = new FakeSwapStore(clock);
  const pricing = new StubPricingService(store);
  const assets = assetRegistryOf(config);
  const hubLn = lnNet.node("hub");
  const hubFiber = fiberNet.node("hub");
  const build = (): SwapEngineService => new SwapEngineService(hubLn, hubFiber, store, pricing, assets, config.timing, clock, config);

  const harness: SwapHarness = {
    config,
    clock,
    lnNet,
    fiberNet,
    hubLn,
    hubFiber,
    userLn: lnNet.node("user"),
    userFiber: fiberNet.node("user"),
    store,
    pricing,
    assets,
    engine: build(),
    restart: () => {
      harness.engine = build();
      return harness.engine;
    },
  };
  return harness;
}

/** Saves a signed quote valid for QUOTE_TTL_MS from now, with any field changed (the signature follows the fields). */
export function saveQuote(h: SwapHarness, direction: Direction, patch: Partial<Quote> = {}): Quote {
  const now = h.clock.now();
  const { signature, ...fields } = patch;
  const unsigned: Omit<Quote, "signature"> = {
    id: randomUUID(),
    direction,
    asset: "CKB",
    ...QUOTE_AMOUNTS[direction],
    btcUsd: 80_000,
    assetUsd: 0.002,
    priceSource: "median:fake-a,fake-b",
    priceAt: now,
    feeBps: 100,
    purpose: "swap",
    createdAt: now,
    expiresAt: now + QUOTE_TTL_MS,
    hubPubkey: HUB_PUBKEY,
    ...fields,
  };
  const quote: Quote = { ...unsigned, signature: signature ?? fakeSignature(unsigned) };
  h.store.saveQuote(quote);
  return quote;
}

/* ---------------------------------------------------------------------------------------------------- invoices */

export const newPreimage = (): Hex32 => randomBytes(32).toString("hex");

/** Payout invoices in these specs stay valid this long after their quote expires. */
export const PAYOUT_INVOICE_EXPIRY_SECONDS = 3_600;

/** Whole seconds from now until an hour after the quote expires. */
const payoutExpirySeconds = (h: SwapHarness, quote: Quote): number =>
  Math.ceil((quote.expiresAt - h.clock.now()) / MS_PER_SECOND) + PAYOUT_INVOICE_EXPIRY_SECONDS;

export const udtOf = (h: SwapHarness, asset: FiberAssetId): Script | null => h.assets.get(asset)?.udtTypeScript ?? null;

export interface FiberInvoiceOptions {
  amount?: bigint | null;
  udt?: Script | null;
  expirySeconds?: number | null;
  finalExpiryDeltaMs?: number;
  hashAlgorithm?: FiberHashAlgorithm;
}

/** The user's Fiber invoice (ln_to_fiber payout), registered on the fake network so the hub can pay it. */
export function userFiberInvoice(h: SwapHarness, preimage: Hex32, quote: Quote, opts: FiberInvoiceOptions = {}): string {
  return h.userFiber.createInvoiceWithOptions(preimage, {
    amount: opts.amount === undefined ? quote.fiberAmount : opts.amount,
    udt: opts.udt === undefined ? udtOf(h, quote.asset) : opts.udt,
    expirySeconds: opts.expirySeconds === undefined ? payoutExpirySeconds(h, quote) : opts.expirySeconds,
    finalExpiryDeltaMs: opts.finalExpiryDeltaMs ?? FIBER_MIN_FINAL_EXPIRY_DELTA_MS,
    hashAlgorithm: opts.hashAlgorithm ?? "sha256",
  });
}

export interface LnInvoiceOptions {
  amountSats?: bigint | null;
  expirySeconds?: number;
  cltvExpiry?: number;
}

/** The user's Lightning invoice (fiber_to_ln payout), registered on the fake network so the hub can pay it. */
export function userLnInvoice(h: SwapHarness, preimage: Hex32, quote: Quote, opts: LnInvoiceOptions = {}): string {
  return h.userLn.createInvoiceWithPreimage(preimage, opts.amountSats === undefined ? quote.sats : opts.amountSats, {
    expirySeconds: opts.expirySeconds ?? payoutExpirySeconds(h, quote),
    cltvExpiry: opts.cltvExpiry ?? FIBER_TO_LN.PAYOUT_CLTV_EXPIRY,
  });
}

export interface CraftedFiberInvoice {
  hash: Hex32;
  amount: bigint | null;
  network: CkbNetwork;
  hashAlgorithm: FiberHashAlgorithm;
  udt: Script | null;
  createdAt: number;
  expiresAt: number | null;
  finalExpiryDeltaMs: number | null;
  payee: string;
}

/**
 * A Fiber invoice string the fakes can parse but no node knows: for checks that never reach a payment. It asks for the
 * default ln_to_fiber quote's amount, so a spec changes only the field it tests.
 */
export function craftFiberInvoice(h: SwapHarness, fields: Partial<CraftedFiberInvoice> = {}): string {
  const now = h.clock.now();
  const payload: CraftedFiberInvoice = {
    hash: sha256Hex(newPreimage()),
    amount: QUOTE_AMOUNTS.ln_to_fiber.fiberAmount,
    network: HUB_CKB_NETWORK,
    hashAlgorithm: "sha256",
    udt: null,
    createdAt: now,
    expiresAt: now + seconds(PAYOUT_INVOICE_EXPIRY_SECONDS),
    finalExpiryDeltaMs: FIBER_MIN_FINAL_EXPIRY_DELTA_MS,
    payee: "user",
    ...fields,
  };
  return encodeFake(FAKE_FIBER_PREFIX, payload);
}

export interface CraftedLnInvoice {
  hash: Hex32;
  amountMsat: bigint | null;
  network: BtcNetwork;
  createdAt: number;
  expiresAt: number;
  cltvExpiry: number;
  destination: string;
  description: string;
}

/** A BOLT11 stand-in the fakes can decode but no node knows. It asks for the default fiber_to_ln quote's sats. */
export function craftLnInvoice(h: SwapHarness, fields: Partial<CraftedLnInvoice> = {}): string {
  const now = h.clock.now();
  const payload: CraftedLnInvoice = {
    hash: sha256Hex(newPreimage()),
    amountMsat: QUOTE_AMOUNTS.fiber_to_ln.sats * MSAT_PER_SAT,
    network: HUB_BTC_NETWORK,
    createdAt: now,
    expiresAt: now + seconds(PAYOUT_INVOICE_EXPIRY_SECONDS),
    cltvExpiry: FIBER_TO_LN.PAYOUT_CLTV_EXPIRY,
    destination: "user",
    description: "payout",
    ...fields,
  };
  return encodeFake(FAKE_LN_PREFIX, payload);
}

/* ------------------------------------------------------------------------------------------------------ swaps */

export interface StartedSwap {
  /** The swap createSwap answered, without its cancel token: what the store keeps. */
  swap: Swap;
  /** The cancel token createSwap answered with, the only time it exists outside the caller's hands. */
  cancelToken: string;
  quote: Quote;
  preimage: Hex32;
  payoutInvoice: string;
}

export interface StartOptions {
  asset?: FiberAssetId;
  quote?: Partial<Quote>;
  demo?: boolean;
  /** Who creates the swap; TEST_CLIENT_KEY by default. */
  clientKey?: string;
  /** Builds the payout invoice; defaults to a valid user invoice for the quote. */
  payoutInvoice?: (preimage: Hex32, quote: Quote) => string;
}

export function defaultPayoutInvoice(h: SwapHarness, preimage: Hex32, quote: Quote): string {
  return quote.direction === "ln_to_fiber" ? userFiberInvoice(h, preimage, quote) : userLnInvoice(h, preimage, quote);
}

/** The swap as the store keeps it: createSwap's answer without the cancel token. */
export function withoutCancelToken(created: CreatedSwap): Swap;
export function withoutCancelToken(created: CreatedSwap | undefined): Swap | undefined;
export function withoutCancelToken(created: CreatedSwap | undefined): Swap | undefined {
  if (!created) return undefined;
  const { cancelToken: _cancelToken, ...swap } = created;
  return swap;
}

/** Saves a quote, makes the user's payout invoice and creates the swap through the engine. */
export async function startSwap(h: SwapHarness, direction: Direction, opts: StartOptions = {}): Promise<StartedSwap> {
  const quote = saveQuote(h, direction, { asset: opts.asset ?? "CKB", ...opts.quote });
  const preimage = newPreimage();
  const payoutInvoice = opts.payoutInvoice ? opts.payoutInvoice(preimage, quote) : defaultPayoutInvoice(h, preimage, quote);
  const created = await h.engine.createSwap({ quoteId: quote.id, payoutInvoice, demo: opts.demo ?? false, clientKey: opts.clientKey ?? TEST_CLIENT_KEY });
  return { swap: withoutCancelToken(created), cancelToken: created.cancelToken, quote, preimage, payoutInvoice };
}

export interface PayOptions {
  /** Fiber payer's tlc_expiry_limit (fiber_to_ln); default the 14-day maximum. */
  tlcExpiryLimitMs?: number;
  /** Lightning payer's cltv_limit (ln_to_fiber); default 2016. */
  cltvLimit?: number;
}

/** The user pays the swap's hold invoice from their own node. */
export function payHoldInvoice(h: SwapHarness, swap: Swap, opts: PayOptions = {}): Promise<LnPaymentStatus | FiberPaymentStatus> {
  if (swap.direction === "ln_to_fiber") {
    return h.userLn.payInvoice({ paymentRequest: swap.holdInvoice, maxFeeSats: 1_000n, cltvLimit: opts.cltvLimit ?? 2_016, timeoutSeconds: 60 });
  }
  return h.userFiber.payInvoice({ invoice: swap.holdInvoice, maxFeeAmount: 0n, tlcExpiryLimitMs: opts.tlcExpiryLimitMs ?? FIBER_MAX_TLC_EXPIRY_LIMIT_MS });
}

export function requireSwap(h: SwapHarness, id: string): Swap {
  const swap = h.store.getSwap(id);
  if (!swap) throw new Error(`test setup: swap ${id} is not in the store`);
  return swap;
}

/** Runs processSwap `passes` times and returns the swap as saved. */
export async function processPasses(h: SwapHarness, id: string, passes: number): Promise<Swap> {
  for (let pass = 0; pass < passes; pass += 1) await h.engine.processSwap(id);
  return requireSwap(h, id);
}

/** Runs processSwap until a pass changes neither the state nor the refund (bounded). */
export async function processToRest(h: SwapHarness, id: string, maxPasses = 12): Promise<Swap> {
  let before = requireSwap(h, id);
  for (let pass = 0; pass < maxPasses; pass += 1) {
    await h.engine.processSwap(id);
    const after = requireSwap(h, id);
    if (after.state === before.state && after.refunded === before.refunded) return after;
    before = after;
  }
  return before;
}

export const eventTypes = (h: SwapHarness, id: string): string[] => h.store.listEvents(id).map((event) => event.type);

export const callCount = (node: { calls: string[] }, method: string): number => node.calls.filter((call) => call === method).length;

/**
 * Wraps a node method so every call first records the swap as saved at that moment, then runs the real method.
 * Shows that a transition was saved before the engine acted on it.
 */
export function swapsSeenAtCall(node: object, method: string, h: SwapHarness, id: string): Array<Swap | null> {
  const target = node as Record<string, (...args: unknown[]) => unknown>;
  const original = target[method];
  if (!original) throw new Error(`test setup: no method ${method}`);
  const bound = original.bind(node);
  const seen: Array<Swap | null> = [];
  jest.spyOn(target, method).mockImplementation((...args: unknown[]) => {
    seen.push(h.store.getSwap(id));
    return bound(...args);
  });
  return seen;
}

/* ------------------------------------------------------------------------------------------------- assertions */

/** A sentence a person can read: starts with a capital, ends with a full stop, no leaked JS values. */
export function expectPlainSentence(text: string | null | undefined): void {
  expect(text).toEqual(expect.any(String));
  expect(text).toMatch(/^[A-Z][\s\S]*\.$/);
  expect(text).not.toMatch(/NaN|undefined|null|Infinity|\[object/);
}

/** Runs `action` and returns the HubError it throws, after checking its status, code and message. */
export async function expectHubError(action: () => unknown, status: number, code: ApiErrorCode): Promise<HubError> {
  let thrown: unknown;
  try {
    await action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(HubError);
  const hubError = thrown as HubError;
  expect({ status: hubError.status, code: hubError.code }).toEqual({ status, code });
  expectPlainSentence(hubError.message);
  return hubError;
}

export interface LogSpies {
  error: jest.SpyInstance;
  warn: jest.SpyInstance;
}

/** Silences the Nest logger (the engine logs every retry and alert) and returns the error and warn spies. */
export function silenceLogs(): LogSpies {
  jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, "debug").mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, "verbose").mockImplementation(() => undefined);
  return {
    error: jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined),
    warn: jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined),
  };
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every pending promise callback run (several macrotask turns). */
export async function flushAsync(turns = 5): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}
