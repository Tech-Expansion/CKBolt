import { HttpStatus } from "@nestjs/common";
import { API_ERROR_CODE } from "../../../src/common/constants/api.constants";
import { FIBER_RPC_METHOD } from "../../../src/common/constants/fiber-rpc.constants";
import { MS_PER_SECOND } from "../../../src/common/constants/protocol.constants";
import { FiberRpcAdapter } from "../../../src/infrastructure/fiber/fiber-rpc.adapter";
import { FiberInvoiceInvalidError, FiberRpcResponseError } from "../../../src/infrastructure/fiber/fiber-rpc.errors";
import { toParsedInvoice } from "../../../src/infrastructure/fiber/fiber-rpc.mappers";
import { FIBER_RPC_RESULT_SCHEMAS, type RpcCkbInvoice } from "../../../src/infrastructure/fiber/fiber-rpc.schemas";
import {
  encodeMoleculeScript,
  hex,
  HOLD_FINAL_EXPIRY_DELTA_MS,
  holdInvoiceAttrs,
  INVOICE_ADDRESS,
  NODE_PUBKEY,
  ONE_CKB,
  PAYMENT_HASH,
  QUOTE_TTL_SECONDS,
  RUSD_SCRIPT,
  ScriptedFiberRpc,
  T0,
  wireInvoice,
  wireInvoiceResult,
  type WireAttr,
} from "./fiber.fixtures";

/**
 * Security review H1: fnn's invoice `attrs` is a list of single-key objects, so one invoice can carry the same attribute
 * twice. Read last-wins, the hub would check one hash algorithm or one UDT script while the paying node used the other.
 * The mapper refuses any repeated attribute (FiberRpcResponseError), and the adapter turns that into invoice_invalid.
 */

const invoice = (attrs: WireAttr[]): RpcCkbInvoice =>
  FIBER_RPC_RESULT_SCHEMAS[FIBER_RPC_METHOD.PARSE_INVOICE].parse({ invoice: wireInvoice({ attrs }) }).invoice;

/** A UDT the hub does not serve, standing in for the token a forged invoice would really be paid in. */
const OTHER_UDT_MOLECULE = encodeMoleculeScript({ codeHash: `0x${"ef".repeat(32)}`, hashType: "type", args: "0x03" });

/** The attribute names a hold invoice carries, from the recorded fnn answer. */
const HOLD_INVOICE_ATTR_NAMES = holdInvoiceAttrs().flatMap((attr) => Object.keys(attr));

/** The hold invoice's attributes with one of them given once more, with `value` (its own value when absent). */
function repeating(name: string, value?: unknown): WireAttr[] {
  const attrs = holdInvoiceAttrs();
  const original = attrs.find((attr) => name in attr);
  if (!original) throw new Error(`test setup: the hold invoice has no ${name}`);
  return [...attrs, { [name]: value === undefined ? original[name] : value }];
}

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

describe("toParsedInvoice: repeated invoice attributes (security review H1)", () => {
  it("is checked against every attribute of a recorded hold invoice", () => {
    expect(HOLD_INVOICE_ATTR_NAMES).toEqual([
      "description",
      "expiry_time",
      "final_htlc_minimum_expiry_delta",
      "hash_algorithm",
      "udt_script",
      "payee_public_key",
    ]);
  });

  it("refuses two hash_algorithm attributes that disagree (sha256, then ckb_hash)", () => {
    expect(() => toParsedInvoice(invoice(repeating("hash_algorithm", "ckb_hash")))).toThrow(FiberRpcResponseError);
  });

  it("refuses two hash_algorithm attributes whatever their order (ckb_hash first, then sha256)", () => {
    const attrs = [{ hash_algorithm: "ckb_hash" }, ...holdInvoiceAttrs()];
    expect(() => toParsedInvoice(invoice(attrs))).toThrow(FiberRpcResponseError);
  });

  it("refuses two udt_script attributes that name different tokens", () => {
    expect(() => toParsedInvoice(invoice(repeating("udt_script", OTHER_UDT_MOLECULE)))).toThrow(FiberRpcResponseError);
  });

  it.each(HOLD_INVOICE_ATTR_NAMES)("refuses %s given twice, even with the same value", (name) => {
    expect(() => toParsedInvoice(invoice(repeating(name)))).toThrow(FiberRpcResponseError);
  });

  it("refuses two feature attributes (one without MPP, one with)", () => {
    const attrs = [...holdInvoiceAttrs(), { feature: ["GOSSIP_QUERIES_OPTIONAL"] }, { feature: ["BASIC_MPP_OPTIONAL"] }];
    expect(() => toParsedInvoice(invoice(attrs))).toThrow(FiberRpcResponseError);
  });

  it("refuses an attribute the hub does not read when it is repeated too", () => {
    const fallback = { fallback_addr: "ckt1qyq" };
    expect(() => toParsedInvoice(invoice([...holdInvoiceAttrs(), fallback, fallback]))).toThrow(FiberRpcResponseError);
  });

  it("counts a key spelled another way (hash_algorithm and HashAlgorithm) as the same attribute", () => {
    expect(() => toParsedInvoice(invoice([...holdInvoiceAttrs(), { HashAlgorithm: "ckb_hash" }]))).toThrow(FiberRpcResponseError);
  });

  it("counts two keys in one attribute object the same way as two objects", () => {
    const attrs = [...holdInvoiceAttrs().filter((attr) => !("hash_algorithm" in attr)), { hash_algorithm: "sha256", HashAlgorithm: "ckb_hash" }];
    expect(() => toParsedInvoice(invoice(attrs))).toThrow(FiberRpcResponseError);
  });

  it("names the repeated attribute in the error", () => {
    const error = thrownBy(() => toParsedInvoice(invoice(repeating("udt_script", OTHER_UDT_MOLECULE))));
    expect(error).toBeInstanceOf(FiberRpcResponseError);
    expect((error as FiberRpcResponseError).detail).toBe("invoice attribute udt_script appears more than once");
  });

  describe("distinct attributes map as before", () => {
    it("reads every attribute of a recorded RUSD hold invoice", () => {
      expect(toParsedInvoice(invoice(holdInvoiceAttrs()))).toEqual({
        paymentHash: PAYMENT_HASH,
        amount: ONE_CKB,
        network: "testnet",
        hashAlgorithm: "sha256",
        udtTypeScript: RUSD_SCRIPT,
        createdAt: T0,
        expiresAt: T0 + QUOTE_TTL_SECONDS * MS_PER_SECOND,
        finalExpiryDeltaMs: HOLD_FINAL_EXPIRY_DELTA_MS,
        payee: NODE_PUBKEY,
        allowsMpp: false,
      });
    });

    it("reads an invoice with extra distinct attributes (feature, fallback address, payment secret)", () => {
      const extra: WireAttr[] = [{ feature: ["BASIC_MPP_OPTIONAL"] }, { fallback_addr: "ckt1qyq" }, { payment_secret: `0x${"55".repeat(32)}` }];
      expect(toParsedInvoice(invoice([...holdInvoiceAttrs(), ...extra]))).toMatchObject({ hashAlgorithm: "sha256", udtTypeScript: RUSD_SCRIPT, allowsMpp: true });
    });

    it("reads an invoice whose attributes are each given in its own spelling once", () => {
      const attrs: WireAttr[] = [{ HashAlgorithm: "sha256" }, { expiry_time: hex(QUOTE_TTL_SECONDS) }];
      expect(toParsedInvoice(invoice(attrs))).toMatchObject({ hashAlgorithm: "sha256", expiresAt: T0 + QUOTE_TTL_SECONDS * MS_PER_SECOND });
    });
  });
});

describe("FiberRpcAdapter.parseInvoice: a repeated attribute (security review H1)", () => {
  it("is the user's invalid invoice: 400 invoice_invalid, naming the attribute", async () => {
    const rpc = new ScriptedFiberRpc();
    const adapter = new FiberRpcAdapter(rpc, "testnet");
    rpc.on("parse_invoice", () => ({ invoice: wireInvoiceResult({ attrs: repeating("hash_algorithm", "ckb_hash") }).invoice }));

    const error = await adapter.parseInvoice(INVOICE_ADDRESS).then(
      () => null,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(FiberInvoiceInvalidError);
    expect(error).toMatchObject({ status: HttpStatus.BAD_REQUEST, code: API_ERROR_CODE.INVOICE_INVALID });
    expect((error as Error).message).toContain("hash_algorithm");
  });
});
