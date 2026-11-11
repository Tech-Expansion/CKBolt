import { HttpStatus } from "@nestjs/common";
import type { FiberPaymentStatus } from "../../../src/application/ports/fiber.port";
import { API_ERROR_CODE } from "../../../src/common/constants/api.constants";
import { DuplicateHashError } from "../../../src/common/errors/hub.error";
import type { CkbNetwork } from "../../../src/domain/types";
import { FiberRpcAdapter } from "../../../src/infrastructure/fiber/fiber-rpc.adapter";
import { FiberInvoiceInvalidError, FiberRpcError, FiberRpcTransportError } from "../../../src/infrastructure/fiber/fiber-rpc.errors";
import type { FiberUpdateSource, PaymentHashListener } from "../../../src/infrastructure/fiber/fiber-store-changes.subscriber";
import {
  CHAIN_HASH_BY_CURRENCY,
  CHANNEL_ID,
  failWith,
  HOLD_FINAL_EXPIRY_DELTA_MS,
  hex,
  INVOICE_ADDRESS,
  NODE_PUBKEY,
  ONE_CKB,
  OTHER_PREIMAGE,
  PAYMENT_HASH,
  PEER_PUBKEY,
  PREIMAGE,
  QUOTE_TTL_SECONDS,
  RUSD_SCRIPT,
  ScriptedFiberRpc,
  T0,
  TLC_EXPIRY_LIMIT_MS,
  wireChannel,
  wireGetInvoiceResult,
  wireInvoiceResult,
  wireNodeInfo,
  wirePayment,
  wireRusdScript,
  wireTlc,
} from "./fiber.fixtures";

const NETWORK: CkbNetwork = "testnet";
const HASH_PARAM = { payment_hash: `0x${PAYMENT_HASH}` };

const transportError = (method: string) => new FiberRpcTransportError(method, "network", "connect ECONNREFUSED");
const throwTransport = (method: string) => () => {
  throw transportError(method);
};

const holdArgs = {
  paymentHash: PAYMENT_HASH,
  amount: 25n * ONE_CKB,
  udtTypeScript: RUSD_SCRIPT,
  expirySeconds: QUOTE_TTL_SECONDS,
  finalExpiryDeltaMs: HOLD_FINAL_EXPIRY_DELTA_MS,
  description: "ckbolt swap 42",
};

const payArgs = { invoice: INVOICE_ADDRESS, maxFeeAmount: 2n * ONE_CKB, tlcExpiryLimitMs: TLC_EXPIRY_LIMIT_MS };

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to fail");
}

describe("FiberRpcAdapter (FiberPort over fnn JSON-RPC)", () => {
  let rpc: ScriptedFiberRpc;
  let adapter: FiberRpcAdapter;

  beforeEach(() => {
    rpc = new ScriptedFiberRpc();
    adapter = new FiberRpcAdapter(rpc, NETWORK);
  });

  describe("getInfo", () => {
    it("calls node_info without params and reports the network of the node's chain (chain_hash)", async () => {
      rpc.on("node_info", () => wireNodeInfo(NODE_PUBKEY, CHAIN_HASH_BY_CURRENCY.Fibt));
      await expect(adapter.getInfo()).resolves.toEqual({ nodeId: NODE_PUBKEY, network: NETWORK, version: "0.9.1" });
      expect(rpc.calls).toEqual([{ method: "node_info", params: [] }]);
    });

    it("lets a transport failure through (health reports the node as down)", async () => {
      rpc.on("node_info", throwTransport("node_info"));
      await expect(adapter.getInfo()).rejects.toBeInstanceOf(FiberRpcTransportError);
    });
  });

  describe("parseInvoice", () => {
    it("calls parse_invoice with the invoice and maps the result", async () => {
      rpc.on("parse_invoice", () => ({ invoice: wireInvoiceResult().invoice }));
      const parsed = await adapter.parseInvoice(INVOICE_ADDRESS);
      expect(rpc.paramsOf("parse_invoice")).toEqual({ invoice: INVOICE_ADDRESS });
      expect(parsed).toMatchObject({ paymentHash: PAYMENT_HASH, hashAlgorithm: "sha256", network: "testnet", udtTypeScript: RUSD_SCRIPT });
    });

    it("turns an invoice fnn refuses into a 400 invoice_invalid error", async () => {
      rpc.on("parse_invoice", failWith("parse_invoice", "Failed to parse invoice: checksum failed"));
      const error = await caught(adapter.parseInvoice("fibt1garbage"));
      expect(error).toBeInstanceOf(FiberInvoiceInvalidError);
      expect(error).toMatchObject({ status: HttpStatus.BAD_REQUEST, code: API_ERROR_CODE.INVOICE_INVALID });
      expect((error as Error).message).toContain("checksum failed");
    });

    it("turns an invoice the hub cannot read (unknown currency) into invoice_invalid", async () => {
      rpc.on("parse_invoice", () => ({ invoice: wireInvoiceResult({ currency: "Fibx" }).invoice }));
      await expect(adapter.parseInvoice(INVOICE_ADDRESS)).rejects.toBeInstanceOf(FiberInvoiceInvalidError);
    });

    it("keeps a transport failure a 503, not the user's fault", async () => {
      rpc.on("parse_invoice", throwTransport("parse_invoice"));
      const error = await caught(adapter.parseInvoice(INVOICE_ADDRESS));
      expect(error).toBeInstanceOf(FiberRpcTransportError);
      expect(error).toMatchObject({ status: HttpStatus.SERVICE_UNAVAILABLE });
    });
  });

  describe("createHoldInvoice", () => {
    it("calls new_invoice with payment_hash, sha256, the network's currency, expiry (s), final_expiry_delta (ms) and the UDT script", async () => {
      rpc.on("new_invoice", () => wireInvoiceResult());
      await expect(adapter.createHoldInvoice(holdArgs)).resolves.toEqual({ invoice: INVOICE_ADDRESS });
      expect(rpc.calls).toHaveLength(1);
      expect(rpc.paramsOf("new_invoice")).toEqual({
        amount: hex(25n * ONE_CKB),
        currency: "Fibt",
        description: "ckbolt swap 42",
        hash_algorithm: "sha256",
        expiry: hex(QUOTE_TTL_SECONDS),
        payment_hash: `0x${PAYMENT_HASH}`,
        final_expiry_delta: hex(HOLD_FINAL_EXPIRY_DELTA_MS),
        udt_type_script: wireRusdScript(),
      });
    });

    it.each<[CkbNetwork, string]>([
      ["devnet", "Fibd"],
      ["mainnet", "Fibb"],
    ])("uses the currency of the configured network (%s -> %s)", async (network, currency) => {
      rpc.on("new_invoice", () => wireInvoiceResult());
      await new FiberRpcAdapter(rpc, network).createHoldInvoice({ ...holdArgs, udtTypeScript: null });
      expect(rpc.paramsOf("new_invoice")).toMatchObject({ currency });
      expect(rpc.paramsOf("new_invoice")).not.toHaveProperty("udt_type_script");
    });

    it.each(["Duplicated invoice found: 0xabc", "invoice already exists"])("reports %p as a 409 duplicate hash", async (message) => {
      rpc.on("new_invoice", failWith("new_invoice", message));
      const error = await caught(adapter.createHoldInvoice(holdArgs));
      expect(error).toBeInstanceOf(DuplicateHashError);
      expect(error).toMatchObject({ status: HttpStatus.CONFLICT, code: API_ERROR_CODE.DUPLICATE_HASH });
    });

    it("lets other fnn errors through unchanged", async () => {
      rpc.on("new_invoice", failWith("new_invoice", "final_expiry_delta must be at least 9600000"));
      await expect(adapter.createHoldInvoice(holdArgs)).rejects.toBeInstanceOf(FiberRpcError);
    });

    it("lets transport failures through", async () => {
      rpc.on("new_invoice", throwTransport("new_invoice"));
      await expect(adapter.createHoldInvoice(holdArgs)).rejects.toBeInstanceOf(FiberRpcTransportError);
    });
  });

  describe("createInvoice", () => {
    const args = { preimage: PREIMAGE, amount: 3n * ONE_CKB, udtTypeScript: null, expirySeconds: 600, description: "demo" };

    it("calls new_invoice with payment_preimage and sha256, and returns the address and hash", async () => {
      rpc.on("new_invoice", () => wireInvoiceResult({ paymentHash: `0x${PAYMENT_HASH.toUpperCase()}` }, "fibt1demo"));
      await expect(adapter.createInvoice(args)).resolves.toEqual({ invoice: "fibt1demo", paymentHash: PAYMENT_HASH });
      const params = rpc.paramsOf("new_invoice");
      expect(params).toMatchObject({ payment_preimage: `0x${PREIMAGE}`, hash_algorithm: "sha256", currency: "Fibt", amount: hex(3n * ONE_CKB), expiry: hex(600) });
      expect(params).not.toHaveProperty("payment_hash");
    });

    it("reports a reused preimage as a duplicate hash", async () => {
      rpc.on("new_invoice", failWith("new_invoice", "Duplicated invoice found"));
      await expect(adapter.createInvoice(args)).rejects.toBeInstanceOf(DuplicateHashError);
    });
  });

  describe("getInvoice", () => {
    it("calls get_invoice with the 0x hash and maps the status", async () => {
      rpc.on("get_invoice", () => wireGetInvoiceResult("Received"));
      await expect(adapter.getInvoice(PAYMENT_HASH)).resolves.toEqual({ paymentHash: PAYMENT_HASH, state: "Received", amount: ONE_CKB });
      expect(rpc.paramsOf("get_invoice")).toEqual(HASH_PARAM);
    });

    it("returns null when fnn does not know the hash", async () => {
      rpc.on("get_invoice", failWith("get_invoice", "invoice not found"));
      await expect(adapter.getInvoice(PAYMENT_HASH)).resolves.toBeNull();
    });

    it("lets other errors through", async () => {
      rpc.on("get_invoice", failWith("get_invoice", "internal error"));
      await expect(adapter.getInvoice(PAYMENT_HASH)).rejects.toBeInstanceOf(FiberRpcError);
      rpc.on("get_invoice", throwTransport("get_invoice"));
      await expect(adapter.getInvoice(PAYMENT_HASH)).rejects.toBeInstanceOf(FiberRpcTransportError);
    });

    it.each(["Channel not found", "Payment session not found: 0x01", "peer not found, invoice not found"])(
      "lets an error that only mentions 'not found' through (%p): only get_invoice's own text means no invoice",
      async (message) => {
        rpc.on("get_invoice", failWith("get_invoice", message));
        await expect(adapter.getInvoice(PAYMENT_HASH)).rejects.toBeInstanceOf(FiberRpcError);
      },
    );
  });

  describe("settleInvoice (idempotent)", () => {
    it("calls settle_invoice with the 0x hash and preimage", async () => {
      rpc.on("settle_invoice", () => null);
      await adapter.settleInvoice(PAYMENT_HASH, PREIMAGE);
      expect(rpc.calls).toEqual([{ method: "settle_invoice", params: [{ payment_hash: `0x${PAYMENT_HASH}`, payment_preimage: `0x${PREIMAGE}` }] }]);
    });

    it("succeeds when fnn refuses because the invoice is already Paid", async () => {
      rpc.on("settle_invoice", failWith("settle_invoice", "Invoice is already paid"));
      rpc.on("get_invoice", () => wireGetInvoiceResult("Paid"));
      await expect(adapter.settleInvoice(PAYMENT_HASH, PREIMAGE)).resolves.toBeUndefined();
      expect(rpc.methods()).toEqual(["settle_invoice", "get_invoice"]);
    });

    it.each(["Received", "Open", "Cancelled", "Expired"])("fails when fnn refuses and the invoice is %s", async (status) => {
      rpc.on("settle_invoice", failWith("settle_invoice", "Hash mismatch"));
      rpc.on("get_invoice", () => wireGetInvoiceResult(status));
      const error = await caught(adapter.settleInvoice(PAYMENT_HASH, OTHER_PREIMAGE));
      expect(error).toBeInstanceOf(FiberRpcError);
      expect(error).toMatchObject({ rpcMessage: "Hash mismatch" });
    });

    it("fails with fnn's error when the invoice does not exist", async () => {
      rpc.on("settle_invoice", failWith("settle_invoice", "invoice not found"));
      rpc.on("get_invoice", failWith("get_invoice", "invoice not found"));
      await expect(adapter.settleInvoice(PAYMENT_HASH, PREIMAGE)).rejects.toMatchObject({ method: "settle_invoice" });
    });

    it("leaves a transport failure to the caller (who retries) without guessing", async () => {
      rpc.on("settle_invoice", throwTransport("settle_invoice"));
      await expect(adapter.settleInvoice(PAYMENT_HASH, PREIMAGE)).rejects.toBeInstanceOf(FiberRpcTransportError);
      expect(rpc.methods()).toEqual(["settle_invoice"]);
    });
  });

  describe("cancelInvoice (idempotent; never once a preimage is stored)", () => {
    it("calls cancel_invoice with the 0x hash", async () => {
      rpc.on("cancel_invoice", () => wireGetInvoiceResult("Cancelled"));
      await adapter.cancelInvoice(PAYMENT_HASH);
      expect(rpc.calls).toEqual([{ method: "cancel_invoice", params: [HASH_PARAM] }]);
    });

    it("succeeds when fnn refuses because the invoice is already Cancelled", async () => {
      rpc.on("cancel_invoice", failWith("cancel_invoice", "Invoice is already cancelled"));
      rpc.on("get_invoice", () => wireGetInvoiceResult("Cancelled"));
      await expect(adapter.cancelInvoice(PAYMENT_HASH)).resolves.toBeUndefined();
    });

    it("fails when fnn refuses because a preimage is stored (the hub must settle, not refund)", async () => {
      rpc.on("cancel_invoice", failWith("cancel_invoice", "PaymentPreimageAlreadyExists"));
      rpc.on("get_invoice", () => wireGetInvoiceResult("Received"));
      await expect(adapter.cancelInvoice(PAYMENT_HASH)).rejects.toMatchObject({ rpcMessage: "PaymentPreimageAlreadyExists" });
    });

    it("fails when the invoice is already Paid", async () => {
      rpc.on("cancel_invoice", failWith("cancel_invoice", "Invoice is already paid"));
      rpc.on("get_invoice", () => wireGetInvoiceResult("Paid"));
      await expect(adapter.cancelInvoice(PAYMENT_HASH)).rejects.toBeInstanceOf(FiberRpcError);
    });

    it("leaves a transport failure to the caller", async () => {
      rpc.on("cancel_invoice", throwTransport("cancel_invoice"));
      await expect(adapter.cancelInvoice(PAYMENT_HASH)).rejects.toBeInstanceOf(FiberRpcTransportError);
      expect(rpc.methods()).toEqual(["cancel_invoice"]);
    });
  });

  describe("heldTlcs", () => {
    it("reads list_channels pending_tlcs: received TLCs for the hash, with absolute expiry in ms", async () => {
      const expiry = T0 + 5 * 60 * 60 * 1_000;
      rpc.on("list_channels", () => ({
        channels: [
          wireChannel({
            pendingTlcs: [
              wireTlc({ id: 1, amount: 25n * ONE_CKB, expiry }),
              wireTlc({ id: 2, status: { Outbound: "Committed" } }),
              wireTlc({ id: 3, paymentHash: `0x${"99".repeat(32)}` }),
            ],
          }),
        ],
      }));
      await expect(adapter.heldTlcs(PAYMENT_HASH, null)).resolves.toEqual([
        { paymentHash: PAYMENT_HASH, amount: 25n * ONE_CKB, expiresAt: expiry, channelId: CHANNEL_ID, channelOpenedByPeer: false },
      ]);
      expect(rpc.calls).toEqual([{ method: "list_channels", params: [{}] }]);
    });

    it("is empty when the held TLC is gone, even if the invoice still says Received", async () => {
      rpc.on("list_channels", () => ({ channels: [wireChannel()] }));
      rpc.on("get_invoice", () => wireGetInvoiceResult("Received"));
      await expect(adapter.getInvoice(PAYMENT_HASH)).resolves.toMatchObject({ state: "Received" });
      await expect(adapter.heldTlcs(PAYMENT_HASH, null)).resolves.toEqual([]);
    });
  });

  describe("hasOfferedTlcs", () => {
    it("reads list_channels: true while a TLC this node sent for the hash is still pending", async () => {
      rpc.on("list_channels", () => ({ channels: [wireChannel({ pendingTlcs: [wireTlc({ status: { Outbound: "Committed" } })] })] }));
      await expect(adapter.hasOfferedTlcs(PAYMENT_HASH)).resolves.toBe(true);
      expect(rpc.calls).toEqual([{ method: "list_channels", params: [{}] }]);
    });

    it("is false when only received TLCs are pending", async () => {
      rpc.on("list_channels", () => ({ channels: [wireChannel({ pendingTlcs: [wireTlc()] })] }));
      await expect(adapter.hasOfferedTlcs(PAYMENT_HASH)).resolves.toBe(false);
    });
  });

  describe("offeredTlcs and forceCloseChannel", () => {
    it("offeredTlcs reads list_channels once", async () => {
      rpc.on("list_channels", () => ({ channels: [wireChannel({ isPublic: false, pendingTlcs: [wireTlc({ status: { Outbound: "Committed" } })] })] }));
      await expect(adapter.offeredTlcs(PAYMENT_HASH)).resolves.toMatchObject([{ channelId: CHANNEL_ID, channelPublic: false }]);
      expect(rpc.calls).toEqual([{ method: "list_channels", params: [{}] }]);
    });

    it("forceCloseChannel calls shutdown_channel with force", async () => {
      rpc.on("shutdown_channel", () => null);
      await adapter.forceCloseChannel(CHANNEL_ID);
      expect(rpc.calls).toEqual([{ method: "shutdown_channel", params: [{ channel_id: CHANNEL_ID, force: true }] }]);
    });
  });

  describe("payInvoice (idempotent per payment hash)", () => {
    const parses = () => rpc.on("parse_invoice", () => ({ invoice: wireInvoiceResult({ amount: hex(100n * ONE_CKB) }).invoice }));

    it("reads the invoice, checks get_payment, then calls send_payment with fee and expiry limits", async () => {
      parses();
      rpc.on("get_payment", failWith("get_payment", `Payment session not found: 0x${PAYMENT_HASH}`));
      rpc.on("send_payment", () => wirePayment({ status: "Created" }));

      const status = await adapter.payInvoice(payArgs);

      expect(status).toEqual({ paymentHash: PAYMENT_HASH, state: "Created", preimage: null, fee: 0n, failedError: null });
      expect(rpc.methods()).toEqual(["parse_invoice", "get_payment", "send_payment"]);
      expect(rpc.paramsOf("get_payment")).toEqual(HASH_PARAM);
      expect(rpc.paramsOf("send_payment")).toEqual({
        invoice: INVOICE_ADDRESS,
        max_fee_amount: hex(2n * ONE_CKB),
        tlc_expiry_limit: hex(TLC_EXPIRY_LIMIT_MS),
        max_parts: hex(1),
        max_fee_rate: hex(20),
      });
    });

    it("sets max_fee_rate so fnn does not clamp max_fee_amount below what the hub allows", async () => {
      parses();
      rpc.on("get_payment", failWith("get_payment", "Payment session not found"));
      rpc.on("send_payment", () => wirePayment());
      await adapter.payInvoice({ ...payArgs, maxFeeAmount: 333_333n });
      const params = rpc.paramsOf("send_payment") ?? {};
      const rate = BigInt(String(params.max_fee_rate));
      expect((100n * ONE_CKB * rate) / 1_000n).toBeGreaterThanOrEqual(333_333n);
    });

    it("omits max_fee_rate for an invoice without an amount", async () => {
      rpc.on("parse_invoice", () => ({ invoice: wireInvoiceResult({ amount: null }).invoice }));
      rpc.on("get_payment", failWith("get_payment", "Payment session not found"));
      rpc.on("send_payment", () => wirePayment());
      await adapter.payInvoice(payArgs);
      expect(rpc.paramsOf("send_payment")).not.toHaveProperty("max_fee_rate");
    });

    it.each([
      ["Created", undefined],
      ["Inflight", undefined],
      ["Success", `0x${PREIMAGE}`],
    ])("returns the existing %s payment and never sends twice", async (status, preimage) => {
      parses();
      rpc.on("get_payment", () => wirePayment({ status, preimage }));
      const result = await adapter.payInvoice(payArgs);
      expect(result.state).toBe(status);
      expect(rpc.methods()).not.toContain("send_payment");
      if (status === "Success") expect(result.preimage).toBe(PREIMAGE);
    });

    it("sends again when the previous payment Failed", async () => {
      parses();
      rpc.on("get_payment", () => wirePayment({ status: "Failed", failedError: "Failed to build route" }));
      rpc.on("send_payment", () => wirePayment({ status: "Created" }));
      await expect(adapter.payInvoice(payArgs)).resolves.toMatchObject({ state: "Created" });
      expect(rpc.methods()).toEqual(["parse_invoice", "get_payment", "send_payment"]);
    });

    it("does not send when the existing payment cannot be read (transport): the outcome is unknown", async () => {
      parses();
      rpc.on("get_payment", throwTransport("get_payment"));
      await expect(adapter.payInvoice(payArgs)).rejects.toBeInstanceOf(FiberRpcTransportError);
      expect(rpc.methods()).not.toContain("send_payment");
    });

    it("does not send when get_payment fails with an unexpected error", async () => {
      parses();
      rpc.on("get_payment", failWith("get_payment", "store is locked"));
      await expect(adapter.payInvoice(payArgs)).rejects.toBeInstanceOf(FiberRpcError);
      expect(rpc.methods()).not.toContain("send_payment");
    });

    it("does not touch payments for an invoice fnn cannot parse", async () => {
      rpc.on("parse_invoice", failWith("parse_invoice", "Failed to parse invoice"));
      await expect(adapter.payInvoice(payArgs)).rejects.toBeInstanceOf(FiberInvoiceInvalidError);
      expect(rpc.methods()).toEqual(["parse_invoice"]);
    });

    it("returns the live session when send_payment is refused because a concurrent send started it", async () => {
      parses();
      rpc.once("get_payment", failWith("get_payment", "Payment session not found"));
      rpc.once("get_payment", () => wirePayment({ status: "Inflight" }));
      rpc.on("send_payment", failWith("send_payment", "Payment session already exists"));
      await expect(adapter.payInvoice(payArgs)).resolves.toMatchObject({ state: "Inflight", failedError: null });
      expect(rpc.methods()).toEqual(["parse_invoice", "get_payment", "send_payment", "get_payment"]);
    });

    it("reports a refused send with no live session as a definite failure carrying fnn's reason", async () => {
      parses();
      rpc.on("get_payment", failWith("get_payment", "Payment session not found"));
      rpc.on("send_payment", failWith("send_payment", "Failed to build route"));
      await expect(adapter.payInvoice(payArgs)).resolves.toEqual<FiberPaymentStatus>({
        paymentHash: PAYMENT_HASH,
        state: "Failed",
        preimage: null,
        fee: 0n,
        failedError: "Failed to build route",
      });
    });

    it("reports a refused retry after a failure as failed with the new reason", async () => {
      parses();
      rpc.on("get_payment", () => wirePayment({ status: "Failed", failedError: "IncorrectOrUnknownPaymentDetails" }));
      rpc.on("send_payment", failWith("send_payment", "invoice is expired"));
      await expect(adapter.payInvoice(payArgs)).resolves.toMatchObject({ state: "Failed", failedError: "invoice is expired" });
    });

    it("leaves a transport failure on send_payment unresolved: the payment may have started", async () => {
      parses();
      rpc.on("get_payment", failWith("get_payment", "Payment session not found"));
      rpc.on("send_payment", throwTransport("send_payment"));
      await expect(adapter.payInvoice(payArgs)).rejects.toBeInstanceOf(FiberRpcTransportError);
    });
  });

  describe("getPayment", () => {
    it("calls get_payment and takes the preimage from payment_preimage", async () => {
      rpc.on("get_payment", () => wirePayment({ status: "Success", preimage: `0x${PREIMAGE}`, fee: hex(1_000) }));
      await expect(adapter.getPayment(PAYMENT_HASH)).resolves.toEqual({ paymentHash: PAYMENT_HASH, state: "Success", preimage: PREIMAGE, fee: 1_000n, failedError: null });
      expect(rpc.paramsOf("get_payment")).toEqual(HASH_PARAM);
    });

    it("returns null when this node never paid that hash", async () => {
      rpc.on("get_payment", failWith("get_payment", `Payment session not found: 0x${PAYMENT_HASH}`));
      await expect(adapter.getPayment(PAYMENT_HASH)).resolves.toBeNull();
    });

    it("returns null for fnn v0.9.1's own text (InvalidParameter: Payment session not found: Hash256(0x...))", async () => {
      rpc.on("get_payment", failWith("get_payment", `InvalidParameter: Payment session not found: Hash256(0x${PAYMENT_HASH})`));
      await expect(adapter.getPayment(PAYMENT_HASH)).resolves.toBeNull();
    });

    it.each(["Channel not found", "invoice not found", "Peer session not found", "source TLC not found for on-chain payer reconciliation"])(
      "lets another 'not found' error through (%p): the engine would send the payout again on a null",
      async (message) => {
        rpc.on("get_payment", failWith("get_payment", message));
        await expect(adapter.getPayment(PAYMENT_HASH)).rejects.toBeInstanceOf(FiberRpcError);
      },
    );

    it("lets transport failures through", async () => {
      rpc.on("get_payment", throwTransport("get_payment"));
      await expect(adapter.getPayment(PAYMENT_HASH)).rejects.toBeInstanceOf(FiberRpcTransportError);
    });
  });

  describe("listChannels", () => {
    it("lists every channel with balances and readiness", async () => {
      rpc.on("list_channels", () => ({
        channels: [wireChannel(), wireChannel({ channelId: `0x${"c2".repeat(32)}`, udtScript: wireRusdScript(), stateName: "AwaitingChannelReady", localBalance: 7n })],
      }));
      const list = await adapter.listChannels();
      expect(list).toEqual([
        { channelId: CHANNEL_ID, peer: PEER_PUBKEY, udtTypeScript: null, ready: true, localBalance: 400n * ONE_CKB, remoteBalance: 151n * ONE_CKB },
        { channelId: `0x${"c2".repeat(32)}`, peer: PEER_PUBKEY, udtTypeScript: RUSD_SCRIPT, ready: false, localBalance: 7n, remoteBalance: 151n * ONE_CKB },
      ]);
      expect(rpc.calls).toEqual([{ method: "list_channels", params: [{}] }]);
    });
  });

  describe("onUpdate (store-changes push hints)", () => {
    class FakeUpdates implements FiberUpdateSource {
      readonly listeners = new Set<PaymentHashListener>();
      closed = 0;
      subscribe(listener: PaymentHashListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      }
      close(): void {
        this.closed++;
      }
    }

    it("is absent without an update source, so the engine knows to poll", () => {
      expect(adapter.onUpdate).toBeUndefined();
      expect(() => adapter.onModuleDestroy()).not.toThrow();
    });

    it("subscribes listeners to the update source and returns its unsubscribe", () => {
      const updates = new FakeUpdates();
      const withUpdates = new FiberRpcAdapter(rpc, NETWORK, updates);
      const seen: string[] = [];
      const unsubscribe = withUpdates.onUpdate?.((hash) => seen.push(hash));
      for (const listener of updates.listeners) listener(PAYMENT_HASH);
      expect(seen).toEqual([PAYMENT_HASH]);
      unsubscribe?.();
      expect(updates.listeners.size).toBe(0);
    });

    it("closes the update source when the module is destroyed", () => {
      const updates = new FakeUpdates();
      new FiberRpcAdapter(rpc, NETWORK, updates).onModuleDestroy();
      expect(updates.closed).toBe(1);
    });
  });
});
