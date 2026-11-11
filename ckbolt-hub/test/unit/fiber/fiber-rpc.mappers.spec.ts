import { FIBER_RPC_RESULT_SCHEMAS, type RpcChannel, type RpcCkbInvoice } from "../../../src/infrastructure/fiber/fiber-rpc.schemas";
import { FIBER_RPC_METHOD } from "../../../src/common/constants/fiber-rpc.constants";
import { FIBER_DEFAULT_MAX_FEE_RATE_PER_MILLE, MS_PER_HOUR } from "../../../src/common/constants/protocol.constants";
import { FiberRpcResponseError } from "../../../src/infrastructure/fiber/fiber-rpc.errors";
import {
  fromRpcHash,
  fromRpcScript,
  hasOfferedTlcs,
  toOfferedTlcs,
  hasRemovingTlcs,
  maxFeeRateFor,
  networkFromCurrency,
  paymentHashFromStoreChange,
  refusedPaymentStatus,
  toChannelBalance,
  toHeldTlcs,
  toHoldInvoiceParams,
  toInvoiceStatus,
  toNodeInfo,
  toParsedInvoice,
  toPaymentStatus,
  toPubkey,
  toRegularInvoiceParams,
  toRpcHash,
  toRpcScript,
  toSendPaymentParams,
} from "../../../src/infrastructure/fiber/fiber-rpc.mappers";
import type { CkbNetwork } from "../../../src/domain/types";
import {
  BEYOND_U64,
  CHANNEL_ID,
  HOLD_FINAL_EXPIRY_DELTA_MS,
  hex,
  holdInvoiceAttrs,
  MAX_U128,
  NODE_PUBKEY,
  ONE_CKB,
  OTHER_HASH,
  PAYMENT_HASH,
  PEER_PUBKEY,
  PREIMAGE,
  QUOTE_TTL_SECONDS,
  RUSD_SCRIPT,
  T0,
  TLC_EXPIRY_LIMIT_MS,
  UDT_CHANNEL_ID,
  with0x,
  wireChannel,
  wireGetInvoiceResult,
  wireInvoice,
  wireNodeInfo,
  wirePayment,
  wireRusdScript,
  wireTlc,
  type WireAttr,
  type WireInvoiceOptions,
} from "./fiber.fixtures";

/** Wire objects go through the real result schemas first, exactly as the client hands them to the mappers. */
const invoice = (options: WireInvoiceOptions = {}): RpcCkbInvoice =>
  FIBER_RPC_RESULT_SCHEMAS[FIBER_RPC_METHOD.PARSE_INVOICE].parse({ invoice: wireInvoice(options) }).invoice;
const getInvoiceResult = (status: string, options: WireInvoiceOptions = {}) =>
  FIBER_RPC_RESULT_SCHEMAS[FIBER_RPC_METHOD.GET_INVOICE].parse(wireGetInvoiceResult(status, options));
const payment = (options: Parameters<typeof wirePayment>[0] = {}) => FIBER_RPC_RESULT_SCHEMAS[FIBER_RPC_METHOD.GET_PAYMENT].parse(wirePayment(options));
const channels = (...wire: Record<string, unknown>[]): RpcChannel[] =>
  FIBER_RPC_RESULT_SCHEMAS[FIBER_RPC_METHOD.LIST_CHANNELS].parse({ channels: wire }).channels;

const withoutAttr = (key: string): WireAttr[] => holdInvoiceAttrs().filter((attr) => !(key in attr));
const replacingAttr = (key: string, value: unknown): WireAttr[] => [...withoutAttr(key), { [key]: value }];

const holdArgs = {
  paymentHash: PAYMENT_HASH,
  amount: ONE_CKB,
  udtTypeScript: RUSD_SCRIPT,
  expirySeconds: QUOTE_TTL_SECONDS,
  finalExpiryDeltaMs: HOLD_FINAL_EXPIRY_DELTA_MS,
  description: "ckbolt swap",
};

describe("fiber-rpc.mappers", () => {
  describe("scalars", () => {
    it("Hex32 <-> Hash256: adds 0x on the way out, strips it and lower-cases on the way in", () => {
      expect(toRpcHash(PAYMENT_HASH)).toBe(`0x${PAYMENT_HASH}`);
      expect(fromRpcHash(`0x${PAYMENT_HASH.toUpperCase()}`, "payment_hash")).toBe(PAYMENT_HASH);
      expect(fromRpcHash(PAYMENT_HASH, "payment_hash")).toBe(PAYMENT_HASH);
    });

    it.each(["0x1234", "0x" + "zz".repeat(32), ""])("rejects %p as a Hash256 with FiberRpcResponseError", (value) => {
      expect(() => fromRpcHash(value, "payment_hash")).toThrow(FiberRpcResponseError);
    });

    it("normalises public keys to lower-case hex without 0x", () => {
      expect(toPubkey(`0x${NODE_PUBKEY.toUpperCase()}`)).toBe(NODE_PUBKEY);
      expect(toPubkey(NODE_PUBKEY)).toBe(NODE_PUBKEY);
    });

    it("Script camelCase -> snake_case", () => {
      expect(toRpcScript(RUSD_SCRIPT)).toEqual(wireRusdScript());
    });

    it("Script snake_case -> camelCase, lower-casing hex and accepting any spelling of hash_type", () => {
      const wire = { code_hash: RUSD_SCRIPT.codeHash.toUpperCase().replace("0X", "0x"), hash_type: "Type", args: RUSD_SCRIPT.args.toUpperCase().replace("0X", "0x") };
      expect(fromRpcScript(wire)).toEqual(RUSD_SCRIPT);
    });

    it("rejects an unknown script hash_type", () => {
      expect(() => fromRpcScript({ code_hash: RUSD_SCRIPT.codeHash, hash_type: "data3", args: RUSD_SCRIPT.args })).toThrow(FiberRpcResponseError);
    });

    it.each<[string, CkbNetwork]>([
      ["Fibb", "mainnet"],
      ["Fibt", "testnet"],
      ["Fibd", "devnet"],
      ["fibt", "testnet"],
      ["FIBD", "devnet"],
    ])("maps currency %s to %s", (currency, network) => {
      expect(networkFromCurrency(currency)).toBe(network);
    });

    it("rejects an unknown currency", () => {
      expect(() => networkFromCurrency("Fibx")).toThrow(FiberRpcResponseError);
    });
  });

  describe("toParsedInvoice (parse_invoice / new_invoice CkbInvoice)", () => {
    it("reads every attribute of a recorded RUSD hold invoice", () => {
      expect(toParsedInvoice(invoice())).toEqual({
        paymentHash: PAYMENT_HASH,
        amount: ONE_CKB,
        network: "testnet",
        hashAlgorithm: "sha256",
        udtTypeScript: RUSD_SCRIPT,
        createdAt: T0,
        expiresAt: T0 + QUOTE_TTL_SECONDS * 1_000,
        finalExpiryDeltaMs: HOLD_FINAL_EXPIRY_DELTA_MS,
        payee: NODE_PUBKEY,
        allowsMpp: false,
      });
    });

    it.each([["BASIC_MPP_OPTIONAL"], ["BASIC_MPP_REQUIRED"], ["basic_mpp_optional"]])(
      "says the invoice allows MPP when its feature attribute lists %s (made with allow_mpp, as fnn v0.9.1 writes it)",
      (feature) => {
        const attrs: WireAttr[] = [...holdInvoiceAttrs(), { feature: ["GOSSIP_QUERIES_OPTIONAL", feature] }];
        expect(toParsedInvoice(invoice({ attrs })).allowsMpp).toBe(true);
      },
    );

    it("says it does not allow MPP without the attribute or without an MPP feature", () => {
      expect(toParsedInvoice(invoice()).allowsMpp).toBe(false);
      expect(toParsedInvoice(invoice({ attrs: [...holdInvoiceAttrs(), { feature: ["TRAMPOLINE_ROUTING_OPTIONAL"] }] })).allowsMpp).toBe(false);
      expect(toParsedInvoice(invoice({ attrs: [...holdInvoiceAttrs(), { feature: [] }] })).allowsMpp).toBe(false);
    });

    it.each([["0x1"], [3], [["BASIC_MPP_OPTIONAL", 3]]])("rejects a feature attribute it cannot read (%p): MPP could not be ruled out", (feature) => {
      const attrs: WireAttr[] = [...holdInvoiceAttrs(), { feature }];
      expect(() => toParsedInvoice(invoice({ attrs }))).toThrow(FiberRpcResponseError);
    });

    it.each<[string, CkbNetwork]>([
      ["Fibb", "mainnet"],
      ["Fibt", "testnet"],
      ["Fibd", "devnet"],
    ])("takes the network from currency %s", (currency, network) => {
      expect(toParsedInvoice(invoice({ currency })).network).toBe(network);
    });

    it("rejects an invoice in an unknown currency", () => {
      expect(() => toParsedInvoice(invoice({ currency: "Fibz" }))).toThrow(FiberRpcResponseError);
    });

    it("treats a missing hash_algorithm as fnn's default ckb_hash (so the hub can reject it)", () => {
      expect(toParsedInvoice(invoice({ attrs: withoutAttr("hash_algorithm") })).hashAlgorithm).toBe("ckb_hash");
    });

    it.each([
      ["sha256", "sha256"],
      ["Sha256", "sha256"],
      ["SHA256", "sha256"],
      ["ckb_hash", "ckb_hash"],
      ["CkbHash", "ckb_hash"],
    ])("reads hash_algorithm %s as %s", (wire, expected) => {
      expect(toParsedInvoice(invoice({ attrs: replacingAttr("hash_algorithm", wire) })).hashAlgorithm).toBe(expected);
    });

    it("rejects an unknown hash algorithm", () => {
      expect(() => toParsedInvoice(invoice({ attrs: replacingAttr("hash_algorithm", "blake3") }))).toThrow(FiberRpcResponseError);
    });

    it("has no expiry when expiry_time is absent (the invoice never expires)", () => {
      expect(toParsedInvoice(invoice({ attrs: withoutAttr("expiry_time") })).expiresAt).toBeNull();
    });

    it("reads expiry_time as seconds after the millisecond timestamp", () => {
      const parsed = toParsedInvoice(invoice({ timestamp: hex(T0 + 123), attrs: replacingAttr("expiry_time", hex(3_600)) }));
      expect(parsed.createdAt).toBe(T0 + 123);
      expect(parsed.expiresAt).toBe(T0 + 123 + 3_600_000);
    });

    it("reads final_htlc_minimum_expiry_delta as milliseconds, null when absent", () => {
      expect(toParsedInvoice(invoice({ attrs: replacingAttr("final_htlc_minimum_expiry_delta", "0x927c00") })).finalExpiryDeltaMs).toBe(9_600_000);
      expect(toParsedInvoice(invoice({ attrs: withoutAttr("final_htlc_minimum_expiry_delta") })).finalExpiryDeltaMs).toBeNull();
    });

    it("normalises payee_public_key and gives null when absent", () => {
      expect(toParsedInvoice(invoice({ attrs: replacingAttr("payee_public_key", `0x${NODE_PUBKEY.toUpperCase()}`) })).payee).toBe(NODE_PUBKEY);
      expect(toParsedInvoice(invoice({ attrs: withoutAttr("payee_public_key") })).payee).toBeNull();
    });

    it("has no UDT script for a CKB invoice", () => {
      expect(toParsedInvoice(invoice({ attrs: holdInvoiceAttrs({ udtScript: null }) })).udtTypeScript).toBeNull();
    });

    it("also accepts udt_script as a JSON script", () => {
      expect(toParsedInvoice(invoice({ attrs: replacingAttr("udt_script", wireRusdScript()) })).udtTypeScript).toEqual(RUSD_SCRIPT);
    });

    it.each([
      ["malformed molecule", "0x55000000"],
      ["a number", 42],
      ["an object that is not a script", { code: 1 }],
    ])("rejects udt_script as %s", (_label, value) => {
      expect(() => toParsedInvoice(invoice({ attrs: replacingAttr("udt_script", value) }))).toThrow(FiberRpcResponseError);
    });

    it("reads attribute keys spelled in PascalCase too", () => {
      const attrs: WireAttr[] = [{ HashAlgorithm: "sha256" }, { ExpiryTime: hex(60) }, { FinalHtlcMinimumExpiryDelta: hex(9_600_000) }];
      const parsed = toParsedInvoice(invoice({ attrs }));
      expect(parsed).toMatchObject({ hashAlgorithm: "sha256", expiresAt: T0 + 60_000, finalExpiryDeltaMs: 9_600_000 });
    });

    it("ignores attributes the hub does not read", () => {
      const attrs: WireAttr[] = [...holdInvoiceAttrs(), { fallback_addr: "ckt1qyq" }, { payment_secret: `0x${"55".repeat(32)}` }];
      expect(toParsedInvoice(invoice({ attrs })).paymentHash).toBe(PAYMENT_HASH);
    });

    it("gives a null amount for an invoice without one", () => {
      expect(toParsedInvoice(invoice({ amount: null })).amount).toBeNull();
    });

    it.each([BEYOND_U64, MAX_U128])("keeps a u128 amount exact (%s)", (amount) => {
      expect(toParsedInvoice(invoice({ amount: hex(amount) })).amount).toBe(amount);
    });

    it("normalises the payment hash", () => {
      expect(toParsedInvoice(invoice({ paymentHash: `0x${PAYMENT_HASH.toUpperCase()}` })).paymentHash).toBe(PAYMENT_HASH);
    });

    it.each([
      ["a decimal amount", { amount: "100000000" }],
      ["a bad timestamp", { timestamp: "1761220800000" }],
      ["a bad payment hash", { paymentHash: "0x1234" }],
      ["expiry_time as a JSON number", { attrs: replacingAttr("expiry_time", 3_600) }],
      ["expiry_time beyond a safe integer", { attrs: replacingAttr("expiry_time", hex(2n ** 60n)) }],
      ["hash_algorithm as a JSON number", { attrs: replacingAttr("hash_algorithm", 1) }],
    ])("rejects %s with FiberRpcResponseError", (_label, options) => {
      expect(() => toParsedInvoice(invoice(options as WireInvoiceOptions))).toThrow(FiberRpcResponseError);
    });
  });

  describe("toInvoiceStatus (get_invoice)", () => {
    it.each(["Open", "Received", "Paid", "Cancelled", "Expired"])("maps status %s", (status) => {
      expect(toInvoiceStatus(getInvoiceResult(status))).toEqual({ paymentHash: PAYMENT_HASH, state: status, amount: ONE_CKB });
    });

    it.each([
      ["received", "Received"],
      ["PAID", "Paid"],
      ["cancelled", "Cancelled"],
    ])("accepts the spelling %s", (wire, state) => {
      expect(toInvoiceStatus(getInvoiceResult(wire)).state).toBe(state);
    });

    it("reports amount 0 for an invoice without an amount", () => {
      expect(toInvoiceStatus(getInvoiceResult("Open", { amount: null })).amount).toBe(0n);
    });

    it("rejects an unknown status", () => {
      expect(() => toInvoiceStatus(getInvoiceResult("Settled"))).toThrow(FiberRpcResponseError);
    });
  });

  describe("new_invoice params", () => {
    it.each<[CkbNetwork, string]>([
      ["mainnet", "Fibb"],
      ["testnet", "Fibt"],
      ["devnet", "Fibd"],
    ])("hold invoice on %s: payment_hash, sha256, currency %s, expiry in s, final_expiry_delta in ms, UDT script", (network, currency) => {
      expect(toHoldInvoiceParams(holdArgs, network)).toEqual({
        amount: "0x5f5e100",
        currency,
        description: "ckbolt swap",
        hash_algorithm: "sha256",
        expiry: "0xb4",
        payment_hash: `0x${PAYMENT_HASH}`,
        final_expiry_delta: "0x1499700",
        udt_type_script: wireRusdScript(),
      });
    });

    it("hold invoice never carries a preimage", () => {
      expect(toHoldInvoiceParams(holdArgs, "testnet")).not.toHaveProperty("payment_preimage");
    });

    it("omits udt_type_script for CKB", () => {
      expect(toHoldInvoiceParams({ ...holdArgs, udtTypeScript: null }, "testnet")).not.toHaveProperty("udt_type_script");
    });

    it("rounds expiry down and final_expiry_delta up", () => {
      const params = toHoldInvoiceParams({ ...holdArgs, expirySeconds: 179.9, finalExpiryDeltaMs: 9_600_000.2 }, "testnet");
      expect(params.expiry).toBe(hex(179));
      expect(params.final_expiry_delta).toBe(hex(9_600_001));
    });

    it("encodes a u128 amount exactly", () => {
      expect(toHoldInvoiceParams({ ...holdArgs, amount: MAX_U128 }, "testnet").amount).toBe(`0x${"f".repeat(32)}`);
    });

    it("regular invoice: payment_preimage with sha256, no payment_hash", () => {
      const params = toRegularInvoiceParams(
        { preimage: PREIMAGE, amount: 5n * ONE_CKB, udtTypeScript: null, expirySeconds: 600, description: "demo" },
        "devnet",
      );
      expect(params).toEqual({
        amount: hex(5n * ONE_CKB),
        currency: "Fibd",
        description: "demo",
        hash_algorithm: "sha256",
        expiry: hex(600),
        payment_preimage: `0x${PREIMAGE}`,
      });
    });
  });

  describe("send_payment params", () => {
    const payArgs = { invoice: "fibt1qq", maxFeeAmount: 50_000n, tlcExpiryLimitMs: TLC_EXPIRY_LIMIT_MS };

    it("passes invoice, max_fee_amount and tlc_expiry_limit as hex, with a max_fee_rate, in a single part", () => {
      expect(toSendPaymentParams(payArgs, ONE_CKB)).toEqual({
        invoice: "fibt1qq",
        max_fee_amount: hex(50_000),
        tlc_expiry_limit: hex(TLC_EXPIRY_LIMIT_MS),
        max_parts: hex(1),
        max_fee_rate: hex(5),
      });
    });

    it("always asks for one part (max_parts 0x1), so no part can stay out after the payment reads Failed", () => {
      expect(toSendPaymentParams(payArgs, null).max_parts).toBe("0x1");
    });

    it("rounds tlc_expiry_limit down", () => {
      expect(toSendPaymentParams({ ...payArgs, tlcExpiryLimitMs: 1_000.9 }, ONE_CKB).tlc_expiry_limit).toBe(hex(1_000));
    });

    it("leaves max_fee_rate to fnn when the invoice has no amount", () => {
      expect(toSendPaymentParams(payArgs, null)).not.toHaveProperty("max_fee_rate");
    });

    it("never goes below fnn's default rate", () => {
      expect(maxFeeRateFor(0n, ONE_CKB)).toBe(FIBER_DEFAULT_MAX_FEE_RATE_PER_MILLE);
      expect(maxFeeRateFor(1n, ONE_CKB)).toBe(FIBER_DEFAULT_MAX_FEE_RATE_PER_MILLE);
    });

    it("raises the rate when max_fee_amount is above 0.5 % of the amount", () => {
      expect(maxFeeRateFor(ONE_CKB / 100n, ONE_CKB)).toBe(10n);
      expect(maxFeeRateFor(1n, 3n)).toBe(334n);
    });

    it.each<[bigint, bigint]>([
      [50_000n, ONE_CKB],
      [ONE_CKB / 50n, ONE_CKB],
      [1n, 3n],
      [7n, 1_000n],
      [999n, 1_001n],
      [123_456_789n, 987_654_321n],
      [ONE_CKB, ONE_CKB],
      [10n * ONE_CKB, ONE_CKB],
      [BEYOND_U64, MAX_U128],
    ])("fnn's clamp min(max_fee_amount, amount x rate / 1000) keeps max_fee_amount %s on amount %s", (maxFee, amount) => {
      const params = toSendPaymentParams({ ...payArgs, maxFeeAmount: maxFee }, amount);
      const rate = BigInt(params.max_fee_rate ?? "0x0");
      const clamped = (amount * rate) / 1_000n;
      expect(clamped >= maxFee ? maxFee : clamped).toBe(maxFee);
    });
  });

  describe("toPaymentStatus (send_payment / get_payment)", () => {
    it("reads a successful payment with its preimage and fee", () => {
      expect(toPaymentStatus(payment({ status: "Success", preimage: `0x${PREIMAGE}`, fee: hex(1_234) }))).toEqual({
        paymentHash: PAYMENT_HASH,
        state: "Success",
        preimage: PREIMAGE,
        fee: 1_234n,
        failedError: null,
      });
    });

    it("reads a failed payment with its error", () => {
      expect(toPaymentStatus(payment({ status: "Failed", failedError: "InvoiceCancelled" }))).toMatchObject({ state: "Failed", failedError: "InvoiceCancelled", preimage: null });
    });

    it.each([
      ["Created", "Created"],
      ["Inflight", "Inflight"],
      ["inflight", "Inflight"],
      ["IN_FLIGHT", "Inflight"],
      ["success", "Success"],
    ])("maps status %s to %s", (wire, state) => {
      expect(toPaymentStatus(payment({ status: wire })).state).toBe(state);
    });

    it("has no preimage while the payment is not done, and fee 0 when absent", () => {
      expect(toPaymentStatus(payment({ status: "Inflight", preimage: null, fee: null }))).toMatchObject({ preimage: null, fee: 0n });
    });

    it("normalises the preimage", () => {
      expect(toPaymentStatus(payment({ status: "Success", preimage: `0x${PREIMAGE.toUpperCase()}` })).preimage).toBe(PREIMAGE);
    });

    it.each([
      ["an unknown status", { status: "Retrying" }],
      ["a malformed preimage", { status: "Success", preimage: "0x12" }],
      ["a decimal fee", { fee: "100" }],
    ])("rejects %s", (_label, options) => {
      expect(() => toPaymentStatus(payment(options))).toThrow(FiberRpcResponseError);
    });

    it("refusedPaymentStatus: a send fnn refused is a definite failure with the reason", () => {
      expect(refusedPaymentStatus(PAYMENT_HASH, "Failed to build route")).toEqual({
        paymentHash: PAYMENT_HASH,
        state: "Failed",
        preimage: null,
        fee: 0n,
        failedError: "Failed to build route",
      });
    });
  });

  describe("toChannelBalance (list_channels)", () => {
    it("maps a ready CKB channel", () => {
      const [channel] = channels(wireChannel({ localBalance: 400n * ONE_CKB, remoteBalance: 151n * ONE_CKB }));
      expect(toChannelBalance(channel!)).toEqual({
        channelId: CHANNEL_ID,
        peer: PEER_PUBKEY,
        udtTypeScript: null,
        ready: true,
        localBalance: 400n * ONE_CKB,
        remoteBalance: 151n * ONE_CKB,
      });
    });

    it("maps a UDT channel's funding script to camelCase and keeps u128 balances exact", () => {
      const [channel] = channels(wireChannel({ channelId: UDT_CHANNEL_ID, udtScript: wireRusdScript(), localBalance: BEYOND_U64 }));
      expect(toChannelBalance(channel!)).toMatchObject({ channelId: UDT_CHANNEL_ID, udtTypeScript: RUSD_SCRIPT, localBalance: BEYOND_U64 });
    });

    it.each([
      ["ChannelReady", true, true],
      ["CHANNEL_READY", true, true],
      ["ChannelReady", false, false],
      ["AwaitingChannelReady", true, false],
      ["NegotiatingFunding", true, false],
      ["ShuttingDown", true, false],
      ["Closed", true, false],
    ])("state %s, enabled %s -> ready %s", (stateName, enabled, ready) => {
      const [channel] = channels(wireChannel({ stateName, enabled }));
      expect(toChannelBalance(channel!).ready).toBe(ready);
    });

    it("treats a ready channel without an enabled flag as ready", () => {
      const wire = wireChannel();
      delete wire.enabled;
      expect(toChannelBalance(channels(wire)[0]!).ready).toBe(true);
    });

    it("normalises the peer public key", () => {
      expect(toChannelBalance(channels(wireChannel({ pubkey: `0x${PEER_PUBKEY.toUpperCase()}` }))[0]!).peer).toBe(PEER_PUBKEY);
    });
  });

  describe("toHeldTlcs (pending_tlcs held for a hash)", () => {
    const expiry = T0 + 7 * 60 * 60 * 1_000;

    it("returns an inbound, committed, not forwarded TLC for the hash with its absolute expiry in ms", () => {
      const list = channels(wireChannel({ pendingTlcs: [wireTlc({ amount: 5n * ONE_CKB, expiry })] }));
      expect(toHeldTlcs(list, PAYMENT_HASH, null)).toEqual([
        { paymentHash: PAYMENT_HASH, amount: 5n * ONE_CKB, expiresAt: expiry, channelId: CHANNEL_ID, channelOpenedByPeer: false },
      ]);
    });

    it.each<[string, boolean | null, boolean]>([
      ["the hub's node opened (is_acceptor false)", false, false],
      ["the peer opened (is_acceptor true): the peer chose its commitment delay", true, true],
      ["a node that does not say who opened (counted as the peer, the worst case)", null, true],
    ])("tells whether the TLC came over a channel %s", (_label, isAcceptor, openedByPeer) => {
      const list = channels(wireChannel({ isAcceptor, pendingTlcs: [wireTlc()] }));
      expect(toHeldTlcs(list, PAYMENT_HASH, null)[0]?.channelOpenedByPeer).toBe(openedByPeer);
    });

    it.each([
      ["outbound TLCs", { status: { Outbound: "Committed" } }],
      ["inbound TLCs not committed yet", { status: { Inbound: "RemoteAnnounced" } }],
      ["inbound TLCs waiting for an ack", { status: { Inbound: "AnnounceWaitAck" } }],
      ["inbound TLCs already being removed", { status: { Inbound: "LocalRemoved" } }],
      ["inbound TLCs whose removal is confirmed", { status: { Inbound: "RemoveAckConfirmed" } }],
      ["forwarded TLCs (the node is not the final hop)", { forwardingChannelId: UDT_CHANNEL_ID }],
      ["TLCs of another hash", { paymentHash: `0x${OTHER_HASH}` }],
      ["a status that is a plain string", { status: "Committed" }],
      ["a null status", { status: null }],
      ["an empty status object", { status: {} }],
    ])("ignores %s", (_label, options) => {
      const list = channels(wireChannel({ pendingTlcs: [wireTlc(options)] }));
      expect(toHeldTlcs(list, PAYMENT_HASH, null)).toEqual([]);
    });

    it.each([{ inbound: "committed" }, { INBOUND: "COMMITTED" }, { Inbound: "Committed" }])("accepts the status spelling %p", (status) => {
      expect(toHeldTlcs(channels(wireChannel({ pendingTlcs: [wireTlc({ status })] })), PAYMENT_HASH, null)).toHaveLength(1);
    });

    it("matches the hash whatever its case", () => {
      const list = channels(wireChannel({ pendingTlcs: [wireTlc({ paymentHash: `0x${PAYMENT_HASH.toUpperCase()}` })] }));
      expect(toHeldTlcs(list, PAYMENT_HASH, null)).toHaveLength(1);
    });

    it("collects every held part across channels (MPP) and skips the rest", () => {
      const list = channels(
        wireChannel({ pendingTlcs: [wireTlc({ id: 1, amount: 3n * ONE_CKB }), wireTlc({ id: 2, paymentHash: `0x${OTHER_HASH}` })] }),
        wireChannel({ channelId: UDT_CHANNEL_ID, pendingTlcs: [wireTlc({ id: 7, amount: 2n * ONE_CKB })] }),
        wireChannel({ channelId: `0x${"c3".repeat(32)}` }),
      );
      expect(toHeldTlcs(list, PAYMENT_HASH, null).map((tlc) => [tlc.channelId, tlc.amount])).toEqual([
        [CHANNEL_ID, 3n * ONE_CKB],
        [UDT_CHANNEL_ID, 2n * ONE_CKB],
      ]);
    });

    it("counts only TLCs on channels in the asset asked for: a CKB TLC never pays an RUSD invoice", () => {
      const list = channels(
        wireChannel({ pendingTlcs: [wireTlc({ id: 1, amount: 3n * ONE_CKB })] }),
        wireChannel({ channelId: UDT_CHANNEL_ID, udtScript: wireRusdScript(), pendingTlcs: [wireTlc({ id: 7, amount: 2n * ONE_CKB })] }),
      );
      expect(toHeldTlcs(list, PAYMENT_HASH, RUSD_SCRIPT).map((tlc) => [tlc.channelId, tlc.amount])).toEqual([[UDT_CHANNEL_ID, 2n * ONE_CKB]]);
      expect(toHeldTlcs(list, PAYMENT_HASH, null).map((tlc) => [tlc.channelId, tlc.amount])).toEqual([[CHANNEL_ID, 3n * ONE_CKB]]);
      const upperCase = { ...RUSD_SCRIPT, codeHash: `0x${RUSD_SCRIPT.codeHash.slice(2).toUpperCase()}` };
      expect(toHeldTlcs(list, PAYMENT_HASH, upperCase)).toHaveLength(1);
    });

    it.each([
      ["a channel that is not ready", { stateName: "ShuttingDown" }],
      ["a disabled channel", { enabled: false }],
    ])("does not count a TLC on %s", (_label, options) => {
      const list = channels(wireChannel({ ...options, pendingTlcs: [wireTlc()] }));
      expect(toHeldTlcs(list, PAYMENT_HASH, null)).toEqual([]);
    });

    it("returns nothing when no channel holds anything", () => {
      expect(toHeldTlcs(channels(wireChannel()), PAYMENT_HASH, null)).toEqual([]);
      expect(toHeldTlcs([], PAYMENT_HASH, null)).toEqual([]);
    });
  });

  describe("hasOfferedTlcs (a TLC this node sent for the hash is still out)", () => {
    it.each(["LocalAnnounced", "Committed", "RemoteRemoved", "RemoveWaitPrevAck", "RemoveWaitAck", "committed"])(
      "is true for an outbound %s TLC of the hash: the payee may still claim it",
      (state) => {
        expect(hasOfferedTlcs(channels(wireChannel({ pendingTlcs: [wireTlc({ status: { Outbound: state } })] })), PAYMENT_HASH)).toBe(true);
      },
    );

    it("is true when any channel has one, among other TLCs", () => {
      const list = channels(
        wireChannel({ pendingTlcs: [wireTlc({ id: 1 })] }),
        wireChannel({ channelId: UDT_CHANNEL_ID, pendingTlcs: [wireTlc({ id: 2, status: { Outbound: "Committed" } })] }),
      );
      expect(hasOfferedTlcs(list, PAYMENT_HASH)).toBe(true);
    });

    it.each([
      ["an outbound TLC whose removal both sides acknowledged (fnn lists it until the next update)", { status: { Outbound: "RemoveAckConfirmed" } }],
      ["an outbound TLC whose removal both sides acknowledged, in another spelling", { status: { outbound: "remove_ack_confirmed" } }],
      ["an inbound (held) TLC", { status: { Inbound: "Committed" } }],
      ["an outbound TLC of another hash", { status: { Outbound: "Committed" }, paymentHash: `0x${OTHER_HASH}` }],
      ["a status it cannot read", { status: "Committed" }],
    ])("is false for %s", (_label, options) => {
      expect(hasOfferedTlcs(channels(wireChannel({ pendingTlcs: [wireTlc(options)] })), PAYMENT_HASH)).toBe(false);
    });

    it("is false when no channel has a TLC", () => {
      expect(hasOfferedTlcs(channels(wireChannel()), PAYMENT_HASH)).toBe(false);
      expect(hasOfferedTlcs([], PAYMENT_HASH)).toBe(false);
    });
  });

  describe("toOfferedTlcs (the TLCs this node sent for the hash, with their channel)", () => {
    const PRIVATE_PEER = `03${"ef".repeat(32)}`;
    const EXPIRY = T0 + 7 * MS_PER_HOUR;

    it("lists each unresolved outbound TLC of the hash on a ready channel, with its expiry and channel", () => {
      const list = channels(
        wireChannel({ isPublic: false, isAcceptor: false, pubkey: PRIVATE_PEER, pendingTlcs: [wireTlc({ status: { Outbound: "Committed" }, expiry: EXPIRY })] }),
        wireChannel({ channelId: UDT_CHANNEL_ID, isAcceptor: true, pendingTlcs: [wireTlc({ id: 2, status: { Outbound: "RemoteRemoved" } })] }),
      );
      expect(toOfferedTlcs(list, PAYMENT_HASH)).toEqual([
        { paymentHash: PAYMENT_HASH, expiresAt: EXPIRY, channelId: CHANNEL_ID, peer: PRIVATE_PEER, channelPublic: false, channelOpenedByPeer: false },
        { paymentHash: PAYMENT_HASH, expiresAt: T0 + 10 * MS_PER_HOUR, channelId: UDT_CHANNEL_ID, peer: PEER_PUBKEY, channelPublic: true, channelOpenedByPeer: true },
      ]);
    });

    it("counts a channel whose opener fnn does not report as opened by the peer", () => {
      const list = channels(wireChannel({ isAcceptor: null, pendingTlcs: [wireTlc({ status: { Outbound: "Committed" } })] }));
      expect(toOfferedTlcs(list, PAYMENT_HASH)[0]?.channelOpenedByPeer).toBe(true);
    });

    it.each([
      ["an outbound TLC whose removal both sides acknowledged", { status: { Outbound: "RemoveAckConfirmed" } }],
      ["an inbound (held) TLC", { status: { Inbound: "Committed" } }],
      ["an outbound TLC of another hash", { status: { Outbound: "Committed" }, paymentHash: `0x${OTHER_HASH}` }],
    ])("leaves out %s", (_label, options) => {
      expect(toOfferedTlcs(channels(wireChannel({ pendingTlcs: [wireTlc(options)] })), PAYMENT_HASH)).toEqual([]);
    });

    it("leaves out a channel that is closing or not ready: it is already settling on chain", () => {
      const outbound = [wireTlc({ status: { Outbound: "Committed" } })];
      const list = channels(wireChannel({ stateName: "ShuttingDown", pendingTlcs: outbound }), wireChannel({ enabled: false, pendingTlcs: outbound }));
      expect(toOfferedTlcs(list, PAYMENT_HASH)).toEqual([]);
    });
  });

  describe("hasRemovingTlcs (an inbound TLC for the hash on its way out)", () => {
    it.each(["LocalRemoved", "RemoveAckConfirmed", "localremoved"])("is true for an inbound %s TLC of the hash (settled or failed, not acknowledged)", (state) => {
      expect(hasRemovingTlcs(channels(wireChannel({ pendingTlcs: [wireTlc({ status: { Inbound: state } })] })), PAYMENT_HASH)).toBe(true);
    });

    it.each([
      ["a held (committed) TLC", { status: { Inbound: "Committed" } }],
      ["an inbound TLC not committed yet", { status: { Inbound: "AnnounceWaitAck" } }],
      ["an outbound TLC being removed", { status: { Outbound: "LocalRemoved" } }],
      ["a forwarded TLC being removed", { status: { Inbound: "LocalRemoved" }, forwardingChannelId: UDT_CHANNEL_ID }],
      ["a TLC of another hash being removed", { status: { Inbound: "LocalRemoved" }, paymentHash: `0x${OTHER_HASH}` }],
    ])("is false for %s", (_label, options) => {
      expect(hasRemovingTlcs(channels(wireChannel({ pendingTlcs: [wireTlc(options)] })), PAYMENT_HASH)).toBe(false);
    });

    it("is false when no channel has a TLC", () => {
      expect(hasRemovingTlcs(channels(wireChannel()), PAYMENT_HASH)).toBe(false);
      expect(hasRemovingTlcs([], PAYMENT_HASH)).toBe(false);
    });
  });

  describe("paymentHashFromStoreChange (store_changes pushes)", () => {
    const push = (result: unknown) => ({ jsonrpc: "2.0", method: "store_changes", params: { subscription: 3, result } });

    it.each([
      ["PutCkbInvoiceStatus", { payment_hash: `0x${PAYMENT_HASH}`, invoice_status: "Received" }],
      ["PutPreimage", { payment_hash: `0x${PAYMENT_HASH}`, payment_preimage: `0x${PREIMAGE}` }],
      ["PutPaymentSession", { payment_hash: `0x${PAYMENT_HASH}`, payment_session: { status: "Inflight", attempts: [] }, payment_preimage: null }],
      ["PutAttempt", { payment_hash: `0x${PAYMENT_HASH}`, attempt_status: "Retrying" }],
    ])("reads the payment hash of %s", (variant, body) => {
      expect(paymentHashFromStoreChange(push({ [variant]: body }))).toBe(PAYMENT_HASH);
    });

    it("normalises an upper-case hash", () => {
      expect(paymentHashFromStoreChange(push({ PutPreimage: { payment_hash: `0x${PAYMENT_HASH.toUpperCase()}` } }))).toBe(PAYMENT_HASH);
    });

    it.each([
      ["the subscribe answer", { jsonrpc: "2.0", id: 1, result: 3 }],
      ["another notification method", { jsonrpc: "2.0", method: "other", params: { result: { PutPreimage: { payment_hash: `0x${PAYMENT_HASH}` } } } }],
      ["an empty change", push({})],
      ["a change without payment_hash", push({ PutSomethingNew: { channel_id: CHANNEL_ID } })],
      ["a hash that is not 32 bytes", push({ PutPreimage: { payment_hash: "0x1234" } })],
      ["null", null],
      ["a string", "store_changes"],
    ])("returns null for %s", (_label, message) => {
      expect(paymentHashFromStoreChange(message)).toBeNull();
    });
  });

  describe("toNodeInfo (node_info)", () => {
    it.each<CkbNetwork>(["devnet", "testnet", "mainnet"])("takes the network from the hub's configuration (%s)", (network) => {
      const info = FIBER_RPC_RESULT_SCHEMAS[FIBER_RPC_METHOD.NODE_INFO].parse(wireNodeInfo(`0x${NODE_PUBKEY.toUpperCase()}`));
      expect(toNodeInfo(info, network)).toEqual({ nodeId: NODE_PUBKEY, network, version: "0.9.1" });
    });
  });
});
