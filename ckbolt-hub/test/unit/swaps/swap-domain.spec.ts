import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertTransition,
  canCancelIncoming,
  canTransition,
  createPendingSwap,
  expectedIncomingAmount,
  expectedPayoutAmount,
  heldPaymentProblem,
  INITIAL_SWAP_STATE,
  InvalidSwapTransitionError,
  isQuoteExpired,
  isSwapOpen,
  LEG_NETWORK,
  legNetworks,
  needsRefund,
  SWAP_REASON,
  SWAP_STATES,
  SWAP_TRANSITIONS,
} from "../../../src/domain/swap";
import type { Quote, SwapState } from "../../../src/domain/types";
import { FakeClock, FakeSwapStore } from "../../fakes";
import { expectPlainSentence, HUB_PUBKEY, minutes } from "./swaps.fixtures";

/**
 * The swap domain (src/domain/swap): the state machine as data with its guard, the never-cancel rule, the legs of a
 * swap per direction, and the pure rules the engine decides with. Expected values come from docs/architecture.md
 * ("Swap state machine") and docs/phase-3-plan.md section 3, written out here by hand.
 */

const ALL_STATES: SwapState[] = ["pending", "incoming_accepted", "outgoing_in_flight", "outgoing_succeeded", "succeeded", "failed"];

/** architecture.md: the only allowed moves. No self-loops, nothing out of a final state, outgoing_succeeded never fails. */
const ALLOWED: Readonly<Record<SwapState, readonly SwapState[]>> = {
  pending: ["incoming_accepted", "failed"],
  incoming_accepted: ["outgoing_in_flight", "failed"],
  outgoing_in_flight: ["outgoing_succeeded", "failed"],
  outgoing_succeeded: ["succeeded"],
  succeeded: [],
  failed: [],
};

const PAIRS = ALL_STATES.flatMap((from) => ALL_STATES.map((to) => [from, to, ALLOWED[from].includes(to)] as const));

const PREIMAGE = "cd".repeat(32);
const CANCEL_TOKEN_HASH = "ef".repeat(32);

const quote = (patch: Partial<Quote> = {}): Quote => ({
  id: "6f1c1d1e-0000-4000-8000-000000000001",
  direction: "ln_to_fiber",
  asset: "CKB",
  sats: 10_000n,
  fiberAmount: 396_000_000_000n,
  btcUsd: 80_000,
  assetUsd: 0.002,
  priceSource: "median:fake",
  priceAt: Date.UTC(2026, 9, 23, 11, 59),
  feeBps: 100,
  purpose: "swap",
  createdAt: Date.UTC(2026, 9, 23, 12),
  expiresAt: Date.UTC(2026, 9, 23, 12, 3),
  signature: "00".repeat(64),
  hubPubkey: HUB_PUBKEY,
  ...patch,
});

describe("swap domain: state machine", () => {
  it("knows exactly the six swap states and starts every swap in pending", () => {
    expect([...SWAP_STATES].sort()).toEqual([...ALL_STATES].sort());
    expect(Object.keys(SWAP_TRANSITIONS).sort()).toEqual([...ALL_STATES].sort());
    expect(INITIAL_SWAP_STATE).toBe("pending");
  });

  it("keeps the allowed transitions as data that matches the architecture exactly", () => {
    for (const state of ALL_STATES) expect([...SWAP_TRANSITIONS[state]].sort()).toEqual([...ALLOWED[state]].sort());
  });

  it.each(PAIRS)("%s -> %s allowed: %s", (from, to, allowed) => {
    expect(canTransition(from, to)).toBe(allowed);
    if (allowed) {
      expect(() => assertTransition(from, to)).not.toThrow();
    } else {
      expect(() => assertTransition(from, to)).toThrow(InvalidSwapTransitionError);
    }
  });

  it("the guard's error names both states", () => {
    let thrown: unknown;
    try {
      assertTransition("outgoing_succeeded", "failed");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(InvalidSwapTransitionError);
    const error = thrown as InvalidSwapTransitionError;
    expect({ from: error.from, to: error.to }).toEqual({ from: "outgoing_succeeded", to: "failed" });
    expect(error.message).toContain("outgoing_succeeded");
    expect(error.message).toContain("failed");
  });

  it("outgoing_succeeded can never fail: once the preimage is known the hub must collect", () => {
    expect(canTransition("outgoing_succeeded", "failed")).toBe(false);
    expect(SWAP_TRANSITIONS.outgoing_succeeded).toEqual(["succeeded"]);
  });

  it("final states have no way out", () => {
    expect(SWAP_TRANSITIONS.succeeded).toHaveLength(0);
    expect(SWAP_TRANSITIONS.failed).toHaveLength(0);
  });
});

describe("swap domain: the never-cancel rule", () => {
  it.each(["pending", "incoming_accepted", "failed"] as const)("may cancel the incoming leg in %s while no preimage is known", (state) => {
    expect(canCancelIncoming({ state, preimage: null })).toBe(true);
  });

  it.each(["outgoing_in_flight", "outgoing_succeeded", "succeeded"] as const)("never cancels in %s (a payout exists or settled)", (state) => {
    expect(canCancelIncoming({ state, preimage: null })).toBe(false);
  });

  it.each(ALL_STATES)("never cancels in %s once a preimage is known", (state) => {
    expect(canCancelIncoming({ state, preimage: PREIMAGE })).toBe(false);
  });
});

describe("swap domain: open swaps and refunds", () => {
  it("a failed swap needs a refund until its incoming leg is cancelled", () => {
    expect(needsRefund({ state: "failed", refunded: false })).toBe(true);
    expect(needsRefund({ state: "failed", refunded: true })).toBe(false);
    for (const state of ALL_STATES.filter((s) => s !== "failed")) expect(needsRefund({ state, refunded: false })).toBe(false);
  });

  it("isSwapOpen agrees with SwapStore.listOpenSwaps for every state and refund flag", () => {
    const clock = new FakeClock();
    const store = new FakeSwapStore(clock);
    const cases = ALL_STATES.flatMap((state) => [false, true].map((refunded) => ({ state, refunded })));
    cases.forEach(({ state, refunded }, index) => {
      store.createSwap({
        ...createPendingSwap({
          id: `swap-${index}`,
          quote: quote({ id: `quote-${index}` }),
          paymentHash: index.toString(16).padStart(64, "0"),
          payoutInvoice: "payout",
          holdInvoice: "hold",
          timing: { holdCltvExpiry: 847, holdFinalExpiryDeltaMs: null, payoutLockLimit: minutes(410) },
          cancelTokenHash: CANCEL_TOKEN_HASH,
          demo: false,
          now: clock.now() + index,
        }),
        state,
        refunded,
      });
    });
    const openIds = new Set(store.listOpenSwaps().map((s) => s.id));
    cases.forEach(({ state, refunded }, index) => expect([state, refunded, isSwapOpen({ state, refunded })]).toEqual([state, refunded, openIds.has(`swap-${index}`)]));
    expect(isSwapOpen({ state: "succeeded", refunded: false })).toBe(false);
    expect(isSwapOpen({ state: "failed", refunded: false })).toBe(true);
  });
});

describe("swap domain: legs per direction", () => {
  const amounts = { sats: 12_345n, fiberAmount: 987_654_321n };

  it("ln_to_fiber: the user pays on Lightning, the hub pays out on Fiber", () => {
    expect(legNetworks("ln_to_fiber")).toEqual({ incoming: LEG_NETWORK.LIGHTNING, outgoing: LEG_NETWORK.FIBER });
    expect(expectedIncomingAmount({ direction: "ln_to_fiber", ...amounts })).toBe(12_345n);
    expect(expectedPayoutAmount({ direction: "ln_to_fiber", ...amounts })).toBe(987_654_321n);
  });

  it("fiber_to_ln: the user pays on Fiber, the hub pays out on Lightning", () => {
    expect(legNetworks("fiber_to_ln")).toEqual({ incoming: LEG_NETWORK.FIBER, outgoing: LEG_NETWORK.LIGHTNING });
    expect(expectedIncomingAmount({ direction: "fiber_to_ln", ...amounts })).toBe(987_654_321n);
    expect(expectedPayoutAmount({ direction: "fiber_to_ln", ...amounts })).toBe(12_345n);
  });

  it("the two legs are on different networks in both directions", () => {
    for (const direction of ["ln_to_fiber", "fiber_to_ln"] as const) {
      const legs = legNetworks(direction);
      expect(legs.incoming).not.toBe(legs.outgoing);
    }
  });
});

describe("swap domain: rules", () => {
  const expiresAt = Date.UTC(2026, 9, 23, 12, 3);

  it("a quote is honoured before its expiry instant and not after it", () => {
    expect(isQuoteExpired(expiresAt, expiresAt - 1)).toBe(false);
    expect(isQuoteExpired(expiresAt, expiresAt - minutes(2))).toBe(false);
    expect(isQuoteExpired(expiresAt, expiresAt + 1)).toBe(true);
    expect(isQuoteExpired(expiresAt, expiresAt + minutes(60))).toBe(true);
  });

  it("a held payment must cover the quote: nothing held or too little is a problem, enough or more is fine", () => {
    expectPlainSentence(heldPaymentProblem(0n, 10_000n));
    expectPlainSentence(heldPaymentProblem(9_999n, 10_000n));
    expect(heldPaymentProblem(10_000n, 10_000n)).toBeNull();
    expect(heldPaymentProblem(10_001n, 10_000n)).toBeNull();
  });

  it("an underpayment's reason names both amounts", () => {
    const reason = heldPaymentProblem(9_999n, 10_000n) ?? "";
    expect(reason).toContain("9999");
    expect(reason).toContain("10000");
  });
});

describe("swap domain: a new swap", () => {
  it("is pending, takes direction, asset, amounts and expiry from the quote, and has no preimage or refund yet", () => {
    const q = quote({ direction: "fiber_to_ln", asset: "RUSD", sats: 5_000n, fiberAmount: 4_000_000_000n });
    const now = Date.UTC(2026, 9, 23, 12, 0, 30);
    const swap = createPendingSwap({
      id: "swap-1",
      quote: q,
      paymentHash: "ab".repeat(32),
      payoutInvoice: "lnbcrt-payout",
      holdInvoice: "fibd-hold",
      timing: { holdCltvExpiry: null, holdFinalExpiryDeltaMs: minutes(906), payoutLockLimit: null },
      cancelTokenHash: CANCEL_TOKEN_HASH,
      demo: true,
      now,
    });
    expect(swap).toEqual({
      id: "swap-1",
      quoteId: q.id,
      direction: "fiber_to_ln",
      asset: "RUSD",
      paymentHash: "ab".repeat(32),
      sats: 5_000n,
      fiberAmount: 4_000_000_000n,
      payoutInvoice: "lnbcrt-payout",
      holdInvoice: "fibd-hold",
      state: "pending",
      preimage: null,
      failureReason: null,
      refunded: false,
      holdCltvExpiry: null,
      holdFinalExpiryDeltaMs: minutes(906),
      payoutLockLimit: null,
      quoteExpiresAt: q.expiresAt,
      cancelTokenHash: CANCEL_TOKEN_HASH,
      demo: true,
      createdAt: now,
      updatedAt: now,
    });
  });
});

describe("swap domain: reasons users read", () => {
  it("every reason is a plain sentence, with any arguments filled in", () => {
    const texts: string[] = [];
    for (const [name, value] of Object.entries(SWAP_REASON)) {
      if (typeof value === "string") texts.push(value);
      else if (name === "created") texts.push((value as (n: string) => string)("Lightning"));
      else if (name === "underpaid") texts.push((value as (a: bigint, b: bigint) => string)(1n, 2n));
      else if (name === "payoutFailed") {
        texts.push((value as (why: string | null) => string)(null));
        texts.push((value as (why: string | null) => string)("no route"));
      } else if (name === "retrying") {
        for (const state of ALL_STATES) texts.push((value as (s: SwapState) => string)(state));
      } else if (name === "peerChannelHoldTooShort") {
        texts.push((value as (epochs: number) => string)(84));
      } else {
        throw new Error(`SWAP_REASON.${name}: add it to this test`);
      }
    }
    expect(texts.length).toBeGreaterThan(10);
    texts.forEach(expectPlainSentence);
  });

  it("a payment over a payer-opened channel names the commitment delay the hub assumed for it", () => {
    expect(SWAP_REASON.peerChannelHoldTooShort(84)).toContain("84 epochs");
  });

  it("a temporary problem is worded per state without node details", () => {
    const sentences = ALL_STATES.map((state) => SWAP_REASON.retrying(state));
    expect(new Set(sentences).size).toBe(ALL_STATES.length);
  });
});

describe("swap domain: purity and coding rules", () => {
  const SWAP_DOMAIN_DIR = join(__dirname, "../../../src/domain/swap");
  const sources = readdirSync(SWAP_DOMAIN_DIR)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".spec.ts"))
    .map((file) => ({ file, text: readFileSync(join(SWAP_DOMAIN_DIR, file), "utf8") }));

  const codeOnly = (text: string) =>
    text
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "")
      .replace(/(["'`])(?:\\.|(?!\1)[\s\S])*\1/g, '""');

  it("has source files to check", () => {
    expect(sources.map((s) => s.file)).toEqual(expect.arrayContaining(["swap.state-machine.ts", "index.ts"]));
  });

  it.each(sources.map((s) => [s.file, s.text] as const))("%s imports no framework, I/O or outer layer", (_file, text) => {
    const imports = [...text.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1] ?? "");
    for (const source of imports) {
      expect(source).toMatch(/^\.\.?\//);
      expect(source).not.toMatch(/@nestjs|node:|application|infrastructure|interfaces|config\//);
    }
  });

  it.each(sources.map((s) => [s.file, s.text] as const))("%s never reads the clock, randomness or the environment", (_file, text) => {
    const code = codeOnly(text);
    expect(code).not.toMatch(/Date\.now|new Date\(|performance\.now|Math\.random|process\.|console\./);
  });
});
