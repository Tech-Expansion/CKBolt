/**
 * Minimal BOLT11 decoder (bech32 checksum + amount + common tagged fields).
 * It does NOT verify the payee signature, so a decoded invoice is not proof
 * that the invoice is payable. It exists to read the real amount and expiry.
 */

import { CHARSET, fromWords, hrpExpand, polymod, toWords } from "./bech32";

export type Network = "mainnet" | "testnet" | "signet" | "regtest";

export interface DecodedInvoice {
  network: Network;
  /** Exact amount in millisatoshis, or null for "any amount" invoices. */
  amountMsat: bigint | null;
  /** Amount in satoshis (may have a fractional part), or null. */
  amountSats: number | null;
  /** Unix seconds. */
  timestamp: number;
  /** Seconds after timestamp. BOLT11 default is 3600. */
  expirySeconds: number;
  description: string | null;
  paymentHash: string | null;
  /** True for an all-zero signature: a demo invoice no wallet will pay. */
  unsigned: boolean;
}

const PREFIXES: [string, Network][] = [
  ["lnbcrt", "regtest"],
  ["lntbs", "signet"],
  ["lnbc", "mainnet"],
  ["lntb", "testnet"],
];

function wordsToInt(words: number[]): number {
  return words.reduce((acc, w) => acc * 32 + w, 0);
}


/** BOLT11 amount (BTC with an optional multiplier) to millisatoshis, per the spec. */
function parseAmountMsat(amountStr: string): bigint | null {
  if (!amountStr) return null;
  const m = /^([1-9]\d*)([munp])?$/.exec(amountStr);
  if (!m) throw new Error("Invoice amount is malformed.");
  const value = BigInt(m[1]);
  const unit = m[2] ?? "";
  if (unit === "p") {
    // 1p = 0.1 msat; the spec requires a whole number of millisatoshis.
    if (value % BigInt(10) !== BigInt(0)) throw new Error("Invoice amount is below one millisatoshi.");
    return value / BigInt(10);
  }
  const msatPerUnit: Record<string, bigint> = {
    "": BigInt(100_000_000_000),
    m: BigInt(100_000_000),
    u: BigInt(100_000),
    n: BigInt(100),
  };
  return value * msatPerUnit[unit];
}

export function decodeBolt11(input: string): DecodedInvoice {
  let raw = input.trim().replace(/^lightning:/i, "");
  if (!raw) throw new Error("Paste a Lightning invoice to continue.");
  if (raw !== raw.toLowerCase() && raw !== raw.toUpperCase()) {
    throw new Error("Invoice mixes upper and lower case.");
  }
  raw = raw.toLowerCase();

  const sep = raw.lastIndexOf("1");
  if (sep < 1 || sep + 7 > raw.length) throw new Error("This does not look like a BOLT11 invoice.");
  const hrp = raw.slice(0, sep);
  const words: number[] = [];
  for (const c of raw.slice(sep + 1)) {
    const idx = CHARSET.indexOf(c);
    if (idx === -1) throw new Error("Invoice contains characters that are not valid bech32.");
    words.push(idx);
  }
  if (polymod([...hrpExpand(hrp), ...words]) !== 1) {
    throw new Error("Invoice checksum failed. Check that it was copied completely.");
  }

  const prefix = PREFIXES.find(([p]) => hrp.startsWith(p));
  if (!prefix) throw new Error("Unsupported invoice prefix. Expected lnbc, lntb, lntbs or lnbcrt.");
  const amountMsat = parseAmountMsat(hrp.slice(prefix[0].length));
  if (amountMsat !== null && amountMsat > BigInt(MAX_SATS) * BigInt(1000)) throw new Error("Invoice amount is larger than 21 million BTC.");
  const amountSats = amountMsat === null ? null : Number(amountMsat) / 1000;

  const data = words.slice(0, -6); // drop checksum
  if (data.length < 7 + 104) throw new Error("Invoice is too short.");
  const timestamp = wordsToInt(data.slice(0, 7));
  const body = data.slice(7, data.length - 104); // drop 65-byte signature
  const unsigned = data.slice(data.length - 104).every((w) => w === 0);

  let expirySeconds = 3600;
  let description: string | null = null;
  let paymentHash: string | null = null;

  let i = 0;
  while (i < body.length) {
    if (i + 3 > body.length) throw new Error("Invoice data is malformed.");
    const type = CHARSET[body[i]];
    const len = body[i + 1] * 32 + body[i + 2];
    if (i + 3 + len > body.length) throw new Error("Invoice data is truncated.");
    const field = body.slice(i + 3, i + 3 + len);
    i += 3 + len;
    if (type === "x") expirySeconds = wordsToInt(field);
    else if (type === "d") {
      try {
        description = new TextDecoder().decode(fromWords(field));
      } catch {
        description = null;
      }
    } else if (type === "p" && len === 52) {
      paymentHash = Array.from(fromWords(field))
        .slice(0, 32)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    }
  }

  return { network: prefix[1], amountMsat, amountSats, timestamp, expirySeconds, description, paymentHash, unsigned };
}

/* ------------------------------------------------------------------ encode */

function intToWords(n: number, len?: number): number[] {
  const out: number[] = [];
  let v = n;
  while (v > 0) {
    out.unshift(v % 32);
    v = Math.floor(v / 32);
  }
  if (len !== undefined) while (out.length < len) out.unshift(0);
  return out.length ? out : [0];
}


function taggedField(tag: string, words: number[]): number[] {
  // The length is two bech32 words, so a field holds at most 1023 words.
  if (words.length > 1023) throw new Error(`BOLT11 field "${tag}" is too long.`);
  return [CHARSET.indexOf(tag), ...intToWords(words.length, 2), ...words];
}

/** 21 million BTC. */
export const MAX_SATS = 2_100_000_000_000_000;

const NETWORK_PREFIX: Record<Network, string> = {
  mainnet: "lnbc",
  testnet: "lntb",
  signet: "lntbs",
  regtest: "lnbcrt",
};

/**
 * Builds a structurally valid BOLT11 string with an all-zero signature.
 * It decodes correctly but no wallet will pay it. Used only to illustrate
 * the invoice CKBolt would hand to a customer.
 */
export function encodeUnsignedBolt11(opts: {
  network: Network;
  amountSats: number;
  paymentHash: Uint8Array;
  description: string;
  expirySeconds: number;
  timestamp?: number;
}): string {
  if (opts.paymentHash.length !== 32) throw new Error("Payment hash must be 32 bytes.");
  const sats = Math.round(opts.amountSats);
  if (!(sats > 0)) throw new Error("Amount must be at least 1 sat.");
  if (sats > MAX_SATS) throw new Error("Amount is larger than 21 million BTC.");
  // 1u = 100 sats, 1n = 0.1 sat. BigInt keeps large amounts out of exponent notation.
  const big = BigInt(sats);
  const amount = big % BigInt(100) === BigInt(0) ? `${big / BigInt(100)}u` : `${big * BigInt(10)}n`;
  const hrp = NETWORK_PREFIX[opts.network] + amount;
  const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const data = [
    ...intToWords(timestamp, 7),
    ...taggedField("p", toWords(opts.paymentHash)),
    ...taggedField("d", toWords(new TextEncoder().encode(opts.description))),
    ...taggedField("x", intToWords(opts.expirySeconds)),
    ...new Array(104).fill(0), // placeholder signature
  ];
  const chk = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, i) => (chk >>> (5 * (5 - i))) & 31);
  return hrp + "1" + [...data, ...checksum].map((w) => CHARSET[w]).join("");
}
