import { HttpStatus } from "@nestjs/common";
import { API_ERROR_CODE } from "../../src/common/constants/api.constants";
import { HubError } from "../../src/common/errors/hub.error";

/**
 * Fake invoice strings for the fake nodes: a prefix plus base64url JSON. They only need to round-trip through the
 * fakes' decode/parse; real invoice formats are tested in the adapters.
 */

export const FAKE_LN_PREFIX = "fakeln1";
export const FAKE_FIBER_PREFIX = "fakefib1";

export function encodeFake(prefix: string, payload: object): string {
  const json = JSON.stringify(payload, (_k, v) => (typeof v === "bigint" ? `${v}n` : v));
  return prefix + Buffer.from(json, "utf8").toString("base64url");
}

/** Like the adapters, an invoice the node cannot read is the user's input error: 400 invoice_invalid. */
export function decodeFake<T>(prefix: string, invoice: string): T {
  if (!invoice.startsWith(prefix)) {
    throw new HubError(`This invoice cannot be read (not a fake invoice of ${prefix}).`, HttpStatus.BAD_REQUEST, API_ERROR_CODE.INVOICE_INVALID);
  }
  const json = Buffer.from(invoice.slice(prefix.length), "base64url").toString("utf8");
  return JSON.parse(json, (_k, v) => (typeof v === "string" && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v)) as T;
}
