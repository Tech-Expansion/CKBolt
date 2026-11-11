import { MS_PER_SECOND } from "@/lib/hub/constants";
import { fromHexQuantity, normalizeNodeId, with0x } from "./hex";
import { decodeMoleculeScript } from "./molecule";
import type { ParsedInvoice } from "./node-port";
import type { RpcCkbInvoice } from "./rpc-types";
import { FIBER_CURRENCY, FIBER_DEFAULT_HASH_ALGORITHM, FIBER_INVOICE_ATTR } from "./constants";

/**
 * An invoice as parse_invoice returns it (fnn 0.9.1), in the app's terms. fnn writes attribute keys in snake_case and
 * fiber-js's typings in PascalCase, so keys are compared without case or "_", as the hub does.
 */

const attrKey = (key: string): string => key.replace(/_/g, "").toLowerCase();

const NETWORK_BY_CURRENCY: ReadonlyMap<string, ParsedInvoice["network"]> = new Map(
  (Object.entries(FIBER_CURRENCY) as [NonNullable<ParsedInvoice["network"]>, string][]).map(([network, currency]) => [currency.toLowerCase(), network]),
);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** The answer is not an invoice fnn would write. */
export class UnreadableInvoiceError extends Error {
  constructor(detail: string) {
    super(`The Fiber node sent an unreadable invoice: ${detail}.`);
    this.name = "UnreadableInvoiceError";
  }
}

/** Every attribute, by its key without case or "_"; the first of each wins. */
function attributes(invoice: RpcCkbInvoice): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const attr of invoice.data.attrs ?? []) {
    if (!isRecord(attr)) continue;
    for (const [key, value] of Object.entries(attr)) if (!out.has(attrKey(key))) out.set(attrKey(key), value);
  }
  return out;
}

function stringAttribute(attrs: Map<string, unknown>, key: string): string | null {
  const value = attrs.get(attrKey(key));
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new UnreadableInvoiceError(`${key} is not a string`);
  return value;
}

const HEX_QUANTITY = /^0x[0-9a-f]+$/i;

function quantity(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !HEX_QUANTITY.test(value)) throw new UnreadableInvoiceError(`${field} is not a hex quantity`);
  return fromHexQuantity(value);
}

function safeNumber(value: bigint, field: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new UnreadableInvoiceError(`${field} is too large`);
  return Number(value);
}

/** parse_invoice's `invoice` as a ParsedInvoice; throws UnreadableInvoiceError for an answer fnn would not give. */
export function readParsedInvoice(invoice: unknown): ParsedInvoice {
  if (!isRecord(invoice) || !isRecord(invoice.data) || typeof invoice.currency !== "string") throw new UnreadableInvoiceError("no invoice data");
  const rpc = invoice as unknown as RpcCkbInvoice;
  if (typeof rpc.data.payment_hash !== "string") throw new UnreadableInvoiceError("no payment hash");
  const attrs = attributes(rpc);
  const createdAtMs = safeNumber(quantity(rpc.data.timestamp, "timestamp"), "timestamp");
  const expiry = stringAttribute(attrs, FIBER_INVOICE_ATTR.EXPIRY_TIME);
  const udt = stringAttribute(attrs, FIBER_INVOICE_ATTR.UDT_SCRIPT);
  const payee = stringAttribute(attrs, FIBER_INVOICE_ATTR.PAYEE_PUBLIC_KEY);
  let udtTypeScript = null;
  if (udt !== null) {
    try {
      udtTypeScript = decodeMoleculeScript(udt);
    } catch (e) {
      throw new UnreadableInvoiceError(`its token script is malformed (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  return {
    network: NETWORK_BY_CURRENCY.get(rpc.currency.toLowerCase()) ?? null,
    paymentHash: with0x(rpc.data.payment_hash),
    amount: rpc.amount === undefined || rpc.amount === null ? null : quantity(rpc.amount, "amount"),
    udtTypeScript,
    createdAtMs,
    expiresAtMs: expiry === null ? null : createdAtMs + safeNumber(quantity(expiry, FIBER_INVOICE_ATTR.EXPIRY_TIME), "expiry") * MS_PER_SECOND,
    payee: payee === null ? null : normalizeNodeId(payee),
    description: stringAttribute(attrs, FIBER_INVOICE_ATTR.DESCRIPTION),
    hashAlgorithm: stringAttribute(attrs, FIBER_INVOICE_ATTR.HASH_ALGORITHM) ?? FIBER_DEFAULT_HASH_ALGORITHM,
  };
}
