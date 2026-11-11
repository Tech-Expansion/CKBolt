import { decodeBech32, encodeBech32, fromWords } from "./bech32";
import { decodeBolt11, type DecodedInvoice } from "./bolt11";

export type FiberNetwork = "mainnet" | "testnet" | "devnet";

export type PaymentRequest =
  | { kind: "lightning"; raw: string; invoice: DecodedInvoice }
  | {
      kind: "fiber";
      raw: string;
      network: FiberNetwork;
      /** Amount in the invoice's base unit (shannons for CKB), or null if open. */
      amount: bigint | null;
    }
  | { kind: "ckb-address"; raw: string; network: "mainnet" | "testnet" };

const FIBER_PREFIXES: [string, FiberNetwork][] = [
  ["fibb", "mainnet"],
  ["fibt", "testnet"],
  ["fibd", "devnet"],
];

/** Pulls the payable string out of URIs such as BIP21 and `lightning:`. */
function unwrap(input: string): string {
  const text = input.trim();
  const lower = text.toLowerCase();
  if (lower.startsWith("bitcoin:")) {
    // BIP21/BIP321 QR codes are often fully upper case, keys included.
    const query = text.includes("?") ? text.slice(text.indexOf("?") + 1) : "";
    let ln: string | null = null;
    for (const [key, value] of new URLSearchParams(query)) if (key.toLowerCase() === "lightning") ln = value;
    if (!ln) throw new Error("This BIP21 link has no Lightning invoice. CKBolt works on L2, so it needs the lightning= part.");
    return ln.trim();
  }
  if (lower.startsWith("lightning:")) return text.slice("lightning:".length).trim();
  return text;
}

/**
 * Decodes a Fiber invoice as far as the browser can: network, amount and a
 * valid bech32m checksum. The payment hash sits in an arcode-compressed
 * molecule payload, which a Fiber node reads with its `parse_invoice` RPC.
 */
export function decodeFiberInvoice(raw: string): Extract<PaymentRequest, { kind: "fiber" }> {
  const { hrp, variant } = decodeBech32(raw);
  if (variant !== "bech32m") throw new Error("Fiber invoices use bech32m; this one uses bech32.");
  const prefix = FIBER_PREFIXES.find(([p]) => hrp.startsWith(p));
  if (!prefix) throw new Error("Unknown Fiber invoice prefix. Expected fibb, fibt or fibd.");
  const amountPart = hrp.slice(prefix[0].length);
  if (amountPart && !/^\d+$/.test(amountPart)) throw new Error("Fiber invoice amount is malformed.");
  const amount = amountPart ? BigInt(amountPart) : null;
  if (amount === BigInt(0)) throw new Error("This Fiber invoice asks for 0. Ask for an invoice with an amount.");
  // 1e12 whole units at 8 decimals: far above any CKB or token supply.
  if (amount !== null && amount > BigInt("100000000000000000000")) throw new Error("This Fiber invoice asks for more than the prototype quotes.");
  return { kind: "fiber", raw, network: prefix[1], amount };
}

/**
 * Checks a CKB address beyond its checksum (RFC 0021): the payload must be one
 * of the known formats with the right length. Returns the network.
 */
export function validateCkbAddress(text: string): "mainnet" | "testnet" {
  const { hrp, words, variant } = decodeBech32(text);
  if (hrp !== "ckb" && hrp !== "ckt") throw new Error("A CKB address starts with ckb1 (mainnet) or ckt1 (testnet).");
  const bytes = fromWords(words);
  const [format] = bytes;
  const ok =
    format === 0x00
      ? variant === "bech32m" && bytes.length >= 34 && [0, 1, 2, 4].includes(bytes[33])
      : format === 0x01
        ? variant === "bech32" && bytes.length === 22 && bytes[1] <= 0x02 // code hash index: secp256k1, multisig, anyone-can-pay
        : format === 0x02 || format === 0x04
          ? variant === "bech32" && bytes.length >= 33
          : false;
  if (!ok) throw new Error("This is not a complete CKB address. Check that it was copied in full.");
  return hrp === "ckb" ? "mainnet" : "testnet";
}

const BOLT12 = /^ln[oir]1/;

export function parsePaymentRequest(input: string): PaymentRequest {
  const text = unwrap(input);
  if (!text) throw new Error("Paste or scan an invoice to continue.");
  const lower = text.toLowerCase();
  if (lower.startsWith("lnurl")) {
    throw new Error("This is an LNURL. CKBolt reads BOLT11 invoices for now; ask for an invoice (lnbc… or lntb…).");
  }
  if (/^[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(lower)) {
    throw new Error("This looks like a Lightning address. CKBolt reads BOLT11 invoices for now; ask for an invoice (lnbc… or lntb…).");
  }
  if (BOLT12.test(lower)) {
    throw new Error("This is a BOLT12 offer. CKBolt reads BOLT11 invoices for now; ask for a BOLT11 invoice (lnbc… or lntb…).");
  }
  if (lower.startsWith("ln")) return { kind: "lightning", raw: text, invoice: decodeBolt11(text) };
  if (lower.startsWith("fib")) return decodeFiberInvoice(text);
  if (lower.startsWith("ckb1") || lower.startsWith("ckt1")) {
    return { kind: "ckb-address", raw: text, network: validateCkbAddress(text) };
  }
  throw new Error("Not recognised. Paste a Lightning invoice (lnbc… or lntb…), a Fiber invoice (fibb… or fibt…) or a CKB address.");
}

/**
 * A string shaped like a Fiber invoice (right prefix, amount and bech32m
 * checksum) with random payload. Only for showing how detection works.
 */
export function demoFiberInvoice(network: FiberNetwork, shannons: bigint | null): string {
  const prefix = FIBER_PREFIXES.find(([, n]) => n === network)![0];
  const words = Array.from(crypto.getRandomValues(new Uint8Array(160)), (b) => b & 31);
  return encodeBech32(`${prefix}${shannons ?? ""}`, words, "bech32m");
}
