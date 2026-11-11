import { DuplicateHashError } from "../../../src/common/errors/hub.error";
import { MS_PER_HOUR } from "../../../src/common/constants/protocol.constants";
import { sha256Hex } from "../../../src/common/utils/hex.util";
import { FiberRpcAdapter } from "../../../src/infrastructure/fiber/fiber-rpc.adapter";
import { FiberRpcClient } from "../../../src/infrastructure/fiber/fiber-rpc.client";
import { FakeClock } from "../../fakes";
import { HOLD_FINAL_EXPIRY_DELTA_MS, ONE_CKB, OTHER_PREIMAGE, PAYMENT_HASH, PREIMAGE, QUOTE_TTL_SECONDS, RUSD_SCRIPT } from "./fiber.fixtures";
import { FnnSimulator } from "./fnn-simulator";

/**
 * FiberRpcAdapter + FiberRpcClient against a wire-level fnn stand-in: what actually travels as JSON-RPC text, and the
 * hold-invoice safety rules that depend on fnn's answers (docs/research/fiber-node.md 2.1-2.2).
 */

const QUANTITY_FIELDS = ["amount", "expiry", "final_expiry_delta", "max_fee_amount", "tlc_expiry_limit", "max_fee_rate"];
const HASH_FIELDS = ["payment_hash", "payment_preimage"];
const HEX_QUANTITY = /^0x[0-9a-f]+$/;
const HASH256 = /^0x[0-9a-f]{64}$/;

describe("FiberRpcAdapter over the wire (fnn stand-in)", () => {
  let clock: FakeClock;
  let sim: FnnSimulator;
  let adapter: FiberRpcAdapter;

  const holdArgs = {
    paymentHash: PAYMENT_HASH,
    amount: 25n * ONE_CKB,
    udtTypeScript: RUSD_SCRIPT,
    expirySeconds: QUOTE_TTL_SECONDS,
    finalExpiryDeltaMs: HOLD_FINAL_EXPIRY_DELTA_MS,
    description: "ckbolt swap",
  };

  beforeEach(() => {
    clock = new FakeClock();
    sim = new FnnSimulator("Fibt", clock);
    adapter = new FiberRpcAdapter(new FiberRpcClient({ url: "http://fnn.test:8227", timeoutMs: 1_000, httpPost: sim.httpPost }), "testnet");
  });

  async function receivedHold(): Promise<void> {
    const { invoice } = await adapter.createHoldInvoice(holdArgs);
    sim.receiveHoldPayment(sim.hashOf(invoice));
  }

  describe("wire format", () => {
    it("sends every call as JSON-RPC 2.0 with a one-object params array, 0x hex quantities and 0x Hash256 values", async () => {
      await adapter.getInfo();
      await receivedHold();
      await adapter.getInvoice(PAYMENT_HASH);
      await adapter.heldTlcs(PAYMENT_HASH, RUSD_SCRIPT);
      await adapter.settleInvoice(PAYMENT_HASH, PREIMAGE);
      const merchant = sim.registerExternalInvoice({ preimage: OTHER_PREIMAGE, amount: 10n * ONE_CKB });
      await adapter.payInvoice({ invoice: merchant.address, maxFeeAmount: ONE_CKB / 10n, tlcExpiryLimitMs: 8 * MS_PER_HOUR });
      await adapter.getPayment(merchant.hash);
      await adapter.listChannels();

      expect(sim.methods()).toEqual([
        "node_info",
        "new_invoice",
        "get_invoice",
        "list_channels",
        "settle_invoice",
        "parse_invoice",
        "get_payment",
        "send_payment",
        "get_payment",
        "list_channels",
      ]);
      expect(new Set(sim.requests.map((request) => request.id)).size).toBe(sim.requests.length);
      for (const request of sim.requests) {
        const params = request.params as unknown[];
        expect(Array.isArray(params)).toBe(true);
        if (request.method === "node_info") {
          expect(params).toEqual([]);
          continue;
        }
        expect(params).toHaveLength(1);
        const object = params[0] as Record<string, unknown>;
        for (const field of QUANTITY_FIELDS.filter((f) => f in object)) expect(object[field]).toMatch(HEX_QUANTITY);
        for (const field of HASH_FIELDS.filter((f) => f in object)) expect(object[field]).toMatch(HASH256);
      }
    });

    it("creates a hold invoice with every option, all accepted by the strict stand-in", async () => {
      await expect(adapter.createHoldInvoice(holdArgs)).resolves.toEqual({ invoice: expect.stringMatching(/^fibt1/) });
      expect(sim.lastParams("new_invoice")).toMatchObject({ hash_algorithm: "sha256", currency: "Fibt", udt_type_script: { code_hash: RUSD_SCRIPT.codeHash } });
    });
  });

  describe("hold invoice safety", () => {
    it("keeps retrying settle while fnn has stored the preimage but not yet removed the TLC, and refuses to cancel then", async () => {
      sim.settleCompletesAtOnce = false;
      await receivedHold();

      await adapter.settleInvoice(PAYMENT_HASH, PREIMAGE);
      expect(await adapter.getInvoice(PAYMENT_HASH)).toMatchObject({ state: "Received" });

      await expect(adapter.settleInvoice(PAYMENT_HASH, PREIMAGE)).resolves.toBeUndefined();
      await expect(adapter.cancelInvoice(PAYMENT_HASH)).rejects.toMatchObject({ rpcMessage: "PaymentPreimageAlreadyExists" });
      expect(sim.countOf("cancel_invoice")).toBe(1);

      sim.completeSettlement(PAYMENT_HASH);
      expect(await adapter.getInvoice(PAYMENT_HASH)).toMatchObject({ state: "Paid" });
      await expect(adapter.settleInvoice(PAYMENT_HASH, PREIMAGE)).resolves.toBeUndefined();
    });

    it("never turns a wrong preimage into a successful settle", async () => {
      await receivedHold();
      await expect(adapter.settleInvoice(PAYMENT_HASH, OTHER_PREIMAGE)).rejects.toMatchObject({ rpcMessage: "Hash mismatch" });
      expect(await adapter.getInvoice(PAYMENT_HASH)).toMatchObject({ state: "Received" });
    });

    it.each(["Duplicated invoice found", "invoice already exists"])("reports a reused hash (%s) as DuplicateHashError", async (message) => {
      sim.duplicateInvoiceMessage = message;
      await adapter.createHoldInvoice(holdArgs);
      await expect(adapter.createHoldInvoice(holdArgs)).rejects.toBeInstanceOf(DuplicateHashError);
    });
  });

  describe("user invoices the hub must check", () => {
    it("reports a ckb_hash invoice as ckb_hash, so the hub can refuse it", async () => {
      const { address } = sim.registerExternalInvoice({ preimage: OTHER_PREIMAGE, hashAlgorithm: "ckb_hash" });
      expect((await adapter.parseInvoice(address)).hashAlgorithm).toBe("ckb_hash");
    });

    it("reports the invoice's own network, so the hub can refuse another network's invoice", async () => {
      const { address } = sim.registerExternalInvoice({ preimage: OTHER_PREIMAGE, currency: "Fibb" });
      expect((await adapter.parseInvoice(address)).network).toBe("mainnet");
    });

    it("reports a UDT invoice's script and an amountless invoice's null amount", async () => {
      const udt = sim.registerExternalInvoice({ preimage: OTHER_PREIMAGE, udt: RUSD_SCRIPT });
      expect((await adapter.parseInvoice(udt.address)).udtTypeScript).toEqual(RUSD_SCRIPT);
      const open = sim.registerExternalInvoice({ preimage: PREIMAGE, amount: null });
      expect((await adapter.parseInvoice(open.address)).amount).toBeNull();
    });

    it("reports an invoice without expiry as never expiring", async () => {
      const { address } = sim.registerExternalInvoice({ preimage: OTHER_PREIMAGE, expirySeconds: null });
      expect((await adapter.parseInvoice(address)).expiresAt).toBeNull();
    });
  });

  describe("payout fee limit", () => {
    it.each([
      ["below fnn's default 0.5 %", ONE_CKB / 1_000n],
      ["at 0.5 %", (100n * ONE_CKB) / 200n],
      ["at 3 %", 3n * ONE_CKB],
      ["at 3 % plus one base unit", 3n * ONE_CKB + 1n],
    ])("lets fnn spend the whole max_fee_amount (%s of the amount)", async (_label, maxFeeAmount) => {
      const merchant = sim.registerExternalInvoice({ preimage: OTHER_PREIMAGE, amount: 100n * ONE_CKB });
      await adapter.payInvoice({ invoice: merchant.address, maxFeeAmount, tlcExpiryLimitMs: 8 * MS_PER_HOUR });
      expect(sim.payments.get(sha256Hex(OTHER_PREIMAGE))?.effectiveMaxFee).toBe(maxFeeAmount);
    });

    it("passes tlc_expiry_limit through, rounded down to whole ms", async () => {
      const merchant = sim.registerExternalInvoice({ preimage: OTHER_PREIMAGE });
      await adapter.payInvoice({ invoice: merchant.address, maxFeeAmount: 1n, tlcExpiryLimitMs: 8 * MS_PER_HOUR + 0.7 });
      expect(sim.lastParams("send_payment").tlc_expiry_limit).toBe(`0x${(8 * MS_PER_HOUR).toString(16)}`);
    });
  });
});
