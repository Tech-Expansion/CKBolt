import "reflect-metadata";
import { DemoWalletService } from "../../../src/application/demo/demo-wallet.service";
import {
  DemoAssetUnavailableError,
  DemoDisabledError,
  DemoWalletUnavailableError,
  SwapNotAwaitingPaymentError,
  SwapNotForDemoWalletError,
} from "../../../src/application/demo/demo.errors";
import { API_ERROR_CODE } from "../../../src/common/constants/api.constants";
import { LN_PAYMENT_REFUSAL_REASON } from "../../../src/common/constants/lnd.constants";
import { MSAT_PER_SAT, MS_PER_SECOND } from "../../../src/common/constants/protocol.constants";
import { HubError, NotFoundError } from "../../../src/common/errors/hub.error";
import { sha256Hex } from "../../../src/common/utils/hex.util";
import type { HubConfig } from "../../../src/config/hub.config";
import type { AssetRegistry } from "../../../src/domain/assets";
import type { Swap, SwapState } from "../../../src/domain/types";
import {
  decodeFake,
  encodeFake,
  FAKE_FIBER_PREFIX,
  FAKE_LN_PREFIX,
  FakeClock,
  FakeFiberNetwork,
  FakeLightningNetwork,
  type FakeFiberNode,
  type FakeLightningNode,
} from "../../fakes";
import { DEVNET_RUSD_SCRIPT, makeSwap, spyOnLogger, StubSwapEngine, testAssets, testConfig } from "./api.fixtures";

/**
 * DemoWalletService against the fake LND and fnn networks: the demo nodes ("visitor" side) are separate from the hub's
 * nodes. ln_to_fiber payouts are Fiber sha256 invoices with a fresh random 32-byte preimage the demo node keeps;
 * fiber_to_ln payouts are BOLT11 invoices. Paying a hold invoice uses the demo node of the swap's incoming network, and
 * only for a swap whose payout is an open invoice of the demo wallet's own node.
 */

const HEX32 = /^[0-9a-f]{64}$/;
const HOLD_CLTV_EXPIRY = 200;

const ceilBps = (amount: bigint, bps: number): bigint => (amount * BigInt(bps) + 9_999n) / 10_000n;

/** Preimages of the swaps' payout invoices: the demo wallet's own invoices unless a test says otherwise. */
const LN_TO_FIBER_PREIMAGE = "01".repeat(32);
const FIBER_TO_LN_PREIMAGE = "02".repeat(32);
const LN_TO_FIBER_PAYOUT = 2_000_000_000_000n;
const FIBER_TO_LN_PAYOUT_SATS = 50_000n;

describe("DemoWalletService", () => {
  let clock: FakeClock;
  let ln: FakeLightningNetwork;
  let fiber: FakeFiberNetwork;
  let hubLn: FakeLightningNode;
  let demoLn: FakeLightningNode;
  let hubFiber: FakeFiberNode;
  let demoFiber: FakeFiberNode;
  let engine: StubSwapEngine;
  let config: HubConfig;
  let assets: AssetRegistry;
  let logs: ReturnType<typeof spyOnLogger>;

  const wallet = (nodes: { lightning?: FakeLightningNode | null; fiber?: FakeFiberNode | null } = {}): DemoWalletService =>
    new DemoWalletService(
      config,
      assets,
      engine,
      nodes.lightning === undefined ? demoLn : nodes.lightning,
      nodes.fiber === undefined ? demoFiber : nodes.fiber,
    );

  /** Forgets the node calls a test's setup made, so assertions see only the wallet's own calls. */
  const clearCalls = (): void => {
    for (const node of [hubLn, demoLn, hubFiber, demoFiber]) node.calls.splice(0);
  };

  /** The payout invoice of an ln_to_fiber swap: by default a Fiber invoice the demo fnn made (a demo swap). */
  const fiberPayoutInvoice = async (payee: FakeFiberNode = demoFiber): Promise<string> => {
    const { invoice } = await payee.createInvoice({
      preimage: LN_TO_FIBER_PREIMAGE,
      amount: LN_TO_FIBER_PAYOUT,
      udtTypeScript: null,
      expirySeconds: config.pricing.quoteTtlSeconds + config.demo.payoutInvoiceExtraSeconds,
      description: "payout",
    });
    return invoice;
  };

  /** The payout invoice of a fiber_to_ln swap: by default a BOLT11 invoice the demo LND made (a demo swap). */
  const lightningPayoutInvoice = (payee: FakeLightningNode = demoLn): string =>
    payee.createInvoiceWithPreimage(FIBER_TO_LN_PREIMAGE, FIBER_TO_LN_PAYOUT_SATS);

  /** A pending ln_to_fiber swap whose BOLT11 hold invoice the hub's LND issued. */
  const lnToFiberSwap = async (overrides: Partial<Swap> = {}, cltvExpiry = HOLD_CLTV_EXPIRY, payee: FakeFiberNode = demoFiber): Promise<Swap> => {
    const paymentHash = sha256Hex(LN_TO_FIBER_PREIMAGE);
    const payoutInvoice = await fiberPayoutInvoice(payee);
    const { paymentRequest } = await hubLn.createHoldInvoice({ paymentHash, amountSats: 50_000n, expirySeconds: config.pricing.quoteTtlSeconds, cltvExpiry, memo: "hold" });
    clearCalls();
    return engine.add(
      makeSwap({
        direction: "ln_to_fiber",
        paymentHash,
        sats: 50_000n,
        fiberAmount: LN_TO_FIBER_PAYOUT,
        payoutInvoice,
        holdInvoice: paymentRequest,
        holdCltvExpiry: cltvExpiry,
        ...overrides,
      }),
    );
  };

  /** A pending fiber_to_ln swap whose Fiber hold invoice the hub's fnn issued. */
  const fiberToLnSwap = async (overrides: Partial<Swap> = {}, payee: FakeLightningNode = demoLn): Promise<Swap> => {
    const paymentHash = sha256Hex(FIBER_TO_LN_PREIMAGE);
    const payoutInvoice = lightningPayoutInvoice(payee);
    const { invoice } = await hubFiber.createHoldInvoice({
      paymentHash,
      amount: 2_000_000_000_000n,
      udtTypeScript: null,
      expirySeconds: config.pricing.quoteTtlSeconds,
      finalExpiryDeltaMs: config.swaps.fiberHoldFinalExpiryDeltaMs,
      description: "hold",
    });
    clearCalls();
    return engine.add(
      makeSwap({
        direction: "fiber_to_ln",
        paymentHash,
        sats: FIBER_TO_LN_PAYOUT_SATS,
        fiberAmount: 2_000_000_000_000n,
        payoutInvoice,
        holdInvoice: invoice,
        holdCltvExpiry: null,
        holdFinalExpiryDeltaMs: config.swaps.fiberHoldFinalExpiryDeltaMs,
        ...overrides,
      }),
    );
  };

  const rejectionOf = async (promise: Promise<unknown>): Promise<HubError> => {
    try {
      await promise;
    } catch (error) {
      return error as HubError;
    }
    throw new Error("expected a rejection");
  };

  beforeEach(() => {
    logs = spyOnLogger();
    clock = new FakeClock();
    ln = new FakeLightningNetwork("regtest", clock);
    fiber = new FakeFiberNetwork("devnet", clock);
    hubLn = ln.node("hub");
    demoLn = ln.node("demo");
    hubFiber = fiber.node("hub");
    demoFiber = fiber.node("demo");
    engine = new StubSwapEngine();
    config = testConfig({ swaps: { lnMaxFeeBps: 150, fiberMaxFeeBps: 75, lnPayTimeoutSeconds: 45 }, timing: { payerMaxCltv: 1_008 } });
    assets = testAssets(config);
  });

  afterEach(() => jest.restoreAllMocks());

  describe("enabled", () => {
    it("is true when both demo nodes are bound", () => {
      expect(wallet().enabled).toBe(true);
    });

    it.each([
      ["no demo Lightning node", { lightning: null }],
      ["no demo Fiber node", { fiber: null }],
      ["no demo nodes", { lightning: null, fiber: null }],
    ])("is false with %s", (_label, nodes) => {
      expect(wallet(nodes).enabled).toBe(false);
    });

    it("a disabled wallet refuses both actions with 404 demo_disabled and touches no node", async () => {
      const disabled = wallet({ fiber: null });
      const swap = await lnToFiberSwap();
      const actions = [() => disabled.createPayoutInvoice({ direction: "ln_to_fiber", asset: "CKB", amount: 1n }), () => disabled.payHoldInvoice(swap.id)];
      for (const action of actions) {
        const error = await rejectionOf(action());
        expect(error).toBeInstanceOf(DemoDisabledError);
        expect(error.status).toBe(404);
        expect(error.code).toBe(API_ERROR_CODE.DEMO_DISABLED);
      }
      expect(demoLn.calls).toEqual([]);
    });
  });

  describe("createPayoutInvoice: ln_to_fiber (Fiber invoice on the demo fnn)", () => {
    it("makes a sha256 Fiber invoice for the amount, without a UDT for CKB", async () => {
      const result = await wallet().createPayoutInvoice({ direction: "ln_to_fiber", asset: "CKB", amount: 7_500_000_000n });
      expect(Object.keys(result).sort()).toEqual(["invoice", "paymentHash"]);
      const parsed = await hubFiber.parseInvoice(result.invoice);
      expect(parsed).toMatchObject({ paymentHash: result.paymentHash, amount: 7_500_000_000n, hashAlgorithm: "sha256", udtTypeScript: null, network: "devnet", payee: demoFiber.nodeId });
      expect(result.paymentHash).toMatch(HEX32);
      expect(demoFiber.calls).toEqual(["createInvoice"]);
      expect(demoLn.calls).toEqual([]);
      expect(hubFiber.calls).toEqual(["parseInvoice"]);
    });

    it("uses the asset's UDT type script from the registry", async () => {
      const result = await wallet().createPayoutInvoice({ direction: "ln_to_fiber", asset: "RUSD", amount: 1_000_000_000n });
      const parsed = await hubFiber.parseInvoice(result.invoice);
      expect(parsed.udtTypeScript).toEqual(DEVNET_RUSD_SCRIPT);
    });

    it("uses a fresh random 32-byte preimage that only the demo node keeps", async () => {
      const create = jest.spyOn(demoFiber, "createInvoice");
      const demo = wallet();
      const first = await demo.createPayoutInvoice({ direction: "ln_to_fiber", asset: "CKB", amount: 100n });
      const second = await demo.createPayoutInvoice({ direction: "ln_to_fiber", asset: "CKB", amount: 100n });
      const preimages = create.mock.calls.map(([args]) => args.preimage);
      for (const preimage of preimages) expect(preimage).toMatch(HEX32);
      expect(preimages[0]).not.toBe(preimages[1]);
      expect(first.paymentHash).toBe(sha256Hex(preimages[0] ?? ""));
      expect(second.paymentHash).toBe(sha256Hex(preimages[1] ?? ""));
      expect(first.paymentHash).not.toBe(second.paymentHash);
      for (const [result, preimage] of [[first, preimages[0]], [second, preimages[1]]] as const) {
        expect(JSON.stringify(result)).not.toContain(preimage);
      }
    });

    it("gives the invoice a lifetime longer than the quote, so the hub can still pay it at the end of the swap", async () => {
      const create = jest.spyOn(demoFiber, "createInvoice");
      const result = await wallet().createPayoutInvoice({ direction: "ln_to_fiber", asset: "CKB", amount: 100n });
      const [args] = create.mock.calls[0] ?? [];
      expect(args?.expirySeconds).toBeGreaterThan(config.pricing.quoteTtlSeconds);
      const parsed = await hubFiber.parseInvoice(result.invoice);
      expect((parsed.expiresAt ?? 0) - clock.now()).toBeGreaterThan(config.pricing.quoteTtlSeconds * MS_PER_SECOND);
    });

    it.each([
      ["a request quote's (REQUEST_QUOTE_TTL_SECONDS)", { quoteTtlSeconds: 180, requestQuoteTtlSeconds: 900 }, 900],
      ["a swap quote's (QUOTE_TTL_SECONDS)", { quoteTtlSeconds: 1_000, requestQuoteTtlSeconds: 300 }, 1_000],
    ])(
      "adds config.demo.payoutInvoiceExtraSeconds (DEMO_PAYOUT_INVOICE_EXTRA_SECONDS) to the longest quote validity, here %s, in both directions",
      async (_longest, ttls, longestSeconds) => {
        config = testConfig({ demo: { payoutInvoiceExtraSeconds: 1_234 }, pricing: ttls });
        const fiberCreate = jest.spyOn(demoFiber, "createInvoice");
        const lnCreate = jest.spyOn(demoLn, "createInvoice");
        await wallet().createPayoutInvoice({ direction: "ln_to_fiber", asset: "CKB", amount: 100n });
        await wallet().createPayoutInvoice({ direction: "fiber_to_ln", asset: "CKB", amount: 100n });

        expect(fiberCreate.mock.calls[0]?.[0].expirySeconds).toBe(longestSeconds + 1_234);
        expect(lnCreate.mock.calls[0]?.[0].expirySeconds).toBe(longestSeconds + 1_234);
      },
    );

    it("refuses an asset the hub does not serve with 422 asset_unavailable, before calling the node", async () => {
      const error = await rejectionOf(wallet().createPayoutInvoice({ direction: "ln_to_fiber", asset: "CWBTC", amount: 100n }));
      expect(error).toBeInstanceOf(DemoAssetUnavailableError);
      expect(error.status).toBe(422);
      expect(error.code).toBe(API_ERROR_CODE.ASSET_UNAVAILABLE);
      expect(demoFiber.calls).toEqual([]);
    });

    it("a node transport error becomes 503 upstream_unavailable, logged for the operator without leaking to the user", async () => {
      demoFiber.failNext = "createInvoice";
      const error = await rejectionOf(wallet().createPayoutInvoice({ direction: "ln_to_fiber", asset: "CKB", amount: 100n }));
      expect(error).toBeInstanceOf(DemoWalletUnavailableError);
      expect(error.status).toBe(503);
      expect(error.code).toBe(API_ERROR_CODE.UPSTREAM_UNAVAILABLE);
      expect(error.message).not.toContain("simulated transport error");
      expect(logs.warn.mock.calls.flat().join(" ")).toContain("simulated transport error");
      expect((error.cause as Error).message).toContain("simulated transport error");
    });
  });

  describe("createPayoutInvoice: fiber_to_ln (BOLT11 invoice on the demo LND)", () => {
    it("makes a regular invoice for the sats", async () => {
      const result = await wallet().createPayoutInvoice({ direction: "fiber_to_ln", asset: "CKB", amount: 42_000n });
      const decoded = await hubLn.decodeInvoice(result.invoice);
      expect(decoded).toMatchObject({ paymentHash: result.paymentHash, amountMsat: 42_000n * MSAT_PER_SAT, network: "regtest", destination: demoLn.pubkey });
      expect(decoded.expiresAt - clock.now()).toBeGreaterThan(config.pricing.quoteTtlSeconds * MS_PER_SECOND);
      expect(demoLn.calls).toEqual(["createInvoice"]);
      expect(demoFiber.calls).toEqual([]);
    });

    it("works for any served asset (the payout is BTC)", async () => {
      const result = await wallet().createPayoutInvoice({ direction: "fiber_to_ln", asset: "RUSD", amount: 1_000n });
      expect(result.paymentHash).toMatch(HEX32);
    });

    it("each invoice has its own payment hash", async () => {
      const demo = wallet();
      const a = await demo.createPayoutInvoice({ direction: "fiber_to_ln", asset: "CKB", amount: 1_000n });
      const b = await demo.createPayoutInvoice({ direction: "fiber_to_ln", asset: "CKB", amount: 1_000n });
      expect(a.paymentHash).not.toBe(b.paymentHash);
    });

    it("a node transport error becomes 503 upstream_unavailable", async () => {
      demoLn.failNext = "createInvoice";
      const error = await rejectionOf(wallet().createPayoutInvoice({ direction: "fiber_to_ln", asset: "CKB", amount: 1_000n }));
      expect(error).toBeInstanceOf(DemoWalletUnavailableError);
    });
  });

  describe("payHoldInvoice: ln_to_fiber (the demo LND pays the hub's BOLT11 hold invoice)", () => {
    it("pays it so the hub's invoice is held (ACCEPTED), from the demo node only", async () => {
      const swap = await lnToFiberSwap();
      await wallet().payHoldInvoice(swap.id);
      const status = await hubLn.lookupInvoice(swap.paymentHash);
      expect(status?.state).toBe("ACCEPTED");
      expect(status?.amountPaidMsat).toBe(50_000n * MSAT_PER_SAT);
      expect(demoLn.calls).toEqual(["payInvoice"]);
      // The demo fnn, which receives the payout, only confirms the payout invoice is its own.
      expect(demoFiber.calls).toEqual(["parseInvoice", "getInvoice", "getInfo"]);
      expect(hubLn.calls).not.toContain("payInvoice");
      expect(engine.getSwap).toHaveBeenCalledWith(swap.id);
    });

    it("uses the fee limit, CLTV cap and timeout from config", async () => {
      const pay = jest.spyOn(demoLn, "payInvoice");
      const swap = await lnToFiberSwap({ sats: 50_001n });
      await wallet().payHoldInvoice(swap.id);
      expect(pay).toHaveBeenCalledWith({
        paymentRequest: swap.holdInvoice,
        maxFeeSats: ceilBps(50_001n, 150),
        cltvLimit: 1_008,
        timeoutSeconds: 45,
      });
    });

    it("a fee limit on a tiny payment rounds up instead of becoming 0", async () => {
      const pay = jest.spyOn(demoLn, "payInvoice");
      const swap = await lnToFiberSwap({ sats: 10n });
      await wallet().payHoldInvoice(swap.id);
      expect(pay.mock.calls[0]?.[0].maxFeeSats).toBe(1n);
    });

    it("a payment that fails at once (CLTV above the payer cap) is 503 upstream_unavailable and logged", async () => {
      const swap = await lnToFiberSwap({}, 2_000);
      const error = await rejectionOf(wallet().payHoldInvoice(swap.id));
      expect(error).toBeInstanceOf(DemoWalletUnavailableError);
      expect(error.status).toBe(503);
      expect((await hubLn.lookupInvoice(swap.paymentHash))?.state).toBe("OPEN");
      // LND refuses a cltv_limit that cannot carry the invoice's CLTV: nothing is sent.
      expect(logs.warn.mock.calls.flat().join(" ")).toContain(LN_PAYMENT_REFUSAL_REASON.CLTV_LIMIT_TOO_LOW);
    });

    it("a payment to an expired hold invoice fails with 503", async () => {
      const swap = await lnToFiberSwap();
      clock.advance((config.pricing.quoteTtlSeconds + 1) * MS_PER_SECOND);
      const error = await rejectionOf(wallet().payHoldInvoice(swap.id));
      expect(error).toBeInstanceOf(DemoWalletUnavailableError);
    });

    it("a transport error while paying is 503 upstream_unavailable", async () => {
      const swap = await lnToFiberSwap();
      demoLn.failNext = "payInvoice";
      const error = await rejectionOf(wallet().payHoldInvoice(swap.id));
      expect(error).toBeInstanceOf(DemoWalletUnavailableError);
    });
  });

  describe("payHoldInvoice: fiber_to_ln (the demo fnn pays the hub's Fiber hold invoice)", () => {
    it("pays it so the hub's invoice is Received with a held TLC, from the demo node only", async () => {
      const swap = await fiberToLnSwap();
      await wallet().payHoldInvoice(swap.id);
      expect((await hubFiber.getInvoice(swap.paymentHash))?.state).toBe("Received");
      expect(await hubFiber.heldTlcs(swap.paymentHash, null)).toHaveLength(1);
      expect(demoFiber.calls).toEqual(["payInvoice"]);
      expect(demoLn.calls).toEqual(["decodeInvoice", "lookupInvoice", "getInfo"]);
    });

    it("uses the Fiber fee limit from config and a lock limit that covers the hub's final_expiry_delta", async () => {
      const pay = jest.spyOn(demoFiber, "payInvoice");
      const swap = await fiberToLnSwap({ fiberAmount: 2_000_000_000_001n });
      await wallet().payHoldInvoice(swap.id);
      const [args] = pay.mock.calls[0] ?? [];
      expect(args?.invoice).toBe(swap.holdInvoice);
      expect(args?.maxFeeAmount).toBe(ceilBps(2_000_000_000_001n, 75));
      expect(args?.tlcExpiryLimitMs).toBeGreaterThanOrEqual(config.swaps.fiberHoldFinalExpiryDeltaMs);
    });

    it("a payment that fails at once (expired hold invoice) is 503 upstream_unavailable", async () => {
      const swap = await fiberToLnSwap();
      clock.advance((config.pricing.quoteTtlSeconds + 1) * MS_PER_SECOND);
      const error = await rejectionOf(wallet().payHoldInvoice(swap.id));
      expect(error).toBeInstanceOf(DemoWalletUnavailableError);
      expect(logs.warn.mock.calls.flat().join(" ")).toContain("InvoiceExpired");
    });
  });

  describe("payHoldInvoice: which swaps it pays", () => {
    it("404 not_found for an unknown swap, without touching a node", async () => {
      const error = await rejectionOf(wallet().payHoldInvoice("33333333-3333-4333-8333-333333333333"));
      expect(error).toBeInstanceOf(NotFoundError);
      expect(error.status).toBe(404);
      expect(error.code).toBe(API_ERROR_CODE.NOT_FOUND);
      expect(demoLn.calls).toEqual([]);
      expect(demoFiber.calls).toEqual([]);
    });

    it.each<SwapState>(["incoming_accepted", "outgoing_in_flight", "outgoing_succeeded", "succeeded", "failed"])(
      "409 for a swap in state %s: the hold invoice is not paid twice",
      async (state) => {
        const swap = await lnToFiberSwap({ state });
        const error = await rejectionOf(wallet().payHoldInvoice(swap.id));
        expect(error).toBeInstanceOf(SwapNotAwaitingPaymentError);
        expect(error.status).toBe(409);
        expect(error.code).toBe(API_ERROR_CODE.CONFLICT);
        expect(demoLn.calls).toEqual([]);
      },
    );

    describe("only swaps that pay out to the demo wallet (the demo money never funds someone else's payout)", () => {
      const expectRefused = async (swap: Swap): Promise<void> => {
        const error = await rejectionOf(wallet().payHoldInvoice(swap.id));
        expect(error).toBeInstanceOf(SwapNotForDemoWalletError);
        expect(error.status).toBe(409);
        expect(error.code).toBe(API_ERROR_CODE.CONFLICT);
        expect(demoLn.calls).not.toContain("payInvoice");
        expect(demoFiber.calls).not.toContain("payInvoice");
      };

      it("409 for an ln_to_fiber swap whose Fiber payout invoice is another wallet's: the demo LND pays nothing", async () => {
        const swap = await lnToFiberSwap({}, HOLD_CLTV_EXPIRY, fiber.node("attacker"));
        await expectRefused(swap);
        expect((await hubLn.lookupInvoice(swap.paymentHash))?.state).toBe("OPEN");
      });

      it("409 for a fiber_to_ln swap whose BOLT11 payout invoice is another wallet's: the demo fnn pays nothing", async () => {
        const swap = await fiberToLnSwap({}, ln.node("attacker"));
        await expectRefused(swap);
        expect((await hubFiber.getInvoice(swap.paymentHash))?.state).toBe("Open");
      });

      it("409 for a payout invoice that reuses a demo invoice's payment hash but is addressed to another node", async () => {
        const swap = await lnToFiberSwap();
        const forged = encodeFake(FAKE_FIBER_PREFIX, { ...decodeFake<Record<string, unknown>>(FAKE_FIBER_PREFIX, swap.payoutInvoice), payee: "03attacker" });
        engine.add({ ...swap, payoutInvoice: forged });
        await expectRefused(swap);
      });

      it("409 for a BOLT11 payout invoice that reuses a demo invoice's payment hash but is addressed to another node", async () => {
        const swap = await fiberToLnSwap();
        const forged = encodeFake(FAKE_LN_PREFIX, { ...decodeFake<Record<string, unknown>>(FAKE_LN_PREFIX, swap.payoutInvoice), destination: "02attacker" });
        engine.add({ ...swap, payoutInvoice: forged });
        await expectRefused(swap);
      });

      it("409 for a payout invoice addressed to the demo node that the demo node never issued", async () => {
        const swap = await fiberToLnSwap();
        const unknownHash = sha256Hex("03".repeat(32));
        const forged = encodeFake(FAKE_LN_PREFIX, { ...decodeFake<Record<string, unknown>>(FAKE_LN_PREFIX, swap.payoutInvoice), hash: unknownHash });
        engine.add({ ...swap, payoutInvoice: forged });
        await expectRefused(swap);
      });

      it("still pays for a demo swap whose payout invoice was cancelled meanwhile: the payout fails and the hub refunds", async () => {
        const swap = await fiberToLnSwap();
        await demoLn.cancelInvoice(swap.paymentHash);
        await wallet().payHoldInvoice(swap.id);
        expect((await hubFiber.getInvoice(swap.paymentHash))?.state).toBe("Received");
      });

      it("a demo node that cannot answer the check is 503 upstream_unavailable, and nothing is paid", async () => {
        const swap = await lnToFiberSwap();
        demoFiber.failNext = "getInvoice";
        const error = await rejectionOf(wallet().payHoldInvoice(swap.id));
        expect(error).toBeInstanceOf(DemoWalletUnavailableError);
        expect(demoLn.calls).not.toContain("payInvoice");
      });

      it("ignores the swap's demo flag: a swap flagged demo that pays out elsewhere is still refused", async () => {
        const swap = await lnToFiberSwap({ demo: true }, HOLD_CLTV_EXPIRY, fiber.node("attacker"));
        await expectRefused(swap);
      });
    });

    it("reads the swap from the engine each time (no stale cache)", async () => {
      const swap = await lnToFiberSwap();
      const demo = wallet();
      engine.add({ ...swap, state: "incoming_accepted" });
      await expect(demo.payHoldInvoice(swap.id)).rejects.toBeInstanceOf(SwapNotAwaitingPaymentError);
    });
  });

  describe("receivesPayout: is a payout invoice the demo wallet's own (the swap's demo flag)?", () => {
    it("is true for a Fiber invoice the demo fnn made and for a BOLT11 invoice the demo LND made", async () => {
      expect(await wallet().receivesPayout(await fiberPayoutInvoice())).toBe(true);
      expect(await wallet().receivesPayout(lightningPayoutInvoice())).toBe(true);
    });

    it("is false for another wallet's invoices, whatever network", async () => {
      expect(await wallet().receivesPayout(await fiberPayoutInvoice(fiber.node("visitor")))).toBe(false);
      expect(await wallet().receivesPayout(lightningPayoutInvoice(ln.node("visitor")))).toBe(false);
    });

    it("is false for a string no demo node can read, without logging", async () => {
      expect(await wallet().receivesPayout("not an invoice")).toBe(false);
      expect(logs.warn).not.toHaveBeenCalled();
    });

    it("is false for an invoice addressed to the demo node that the demo node never issued", async () => {
      const forged = encodeFake(FAKE_LN_PREFIX, { ...decodeFake<Record<string, unknown>>(FAKE_LN_PREFIX, lightningPayoutInvoice()), hash: sha256Hex("04".repeat(32)) });
      expect(await wallet().receivesPayout(forged)).toBe(false);
    });

    it("is false, touching no node, when the demo is off", async () => {
      expect(await wallet({ lightning: null }).receivesPayout(lightningPayoutInvoice())).toBe(false);
      expect(demoLn.calls).toEqual([]);
    });

    it("is false and logged for the operator when a demo node cannot answer", async () => {
      const invoice = lightningPayoutInvoice();
      demoLn.failNext = "lookupInvoice";
      expect(await wallet().receivesPayout(invoice)).toBe(false);
      expect(logs.warn.mock.calls.flat().join(" ")).toContain("simulated transport error");
    });
  });
});
