import { expect, test } from "@playwright/test";
import { decodeBech32, encodeBech32 } from "../../lib/bech32";
import { decodeBolt11, encodeUnsignedBolt11, MAX_SATS } from "../../lib/bolt11";
import { decodeFiberInvoice, demoFiberInvoice, parsePaymentRequest } from "../../lib/payment-request";
import { formatBaseUnits, parseAmountInput, parseSatsInput } from "../../lib/amount";
import { formatAsset, HUB_COST_FACTOR, quoteSwap, satsForUsd, type RateSnapshot } from "../../lib/quote";
import { PAY_TOKENS } from "../../lib/tokens";

/**
 * An unsigned demo invoice: 21,000 sats on Bitcoin testnet, valid for ten years so the tests do not age out. It carries
 * a fixed payment hash and an all-zero signature, so it decodes but can never be paid.
 */
const DEMO_INVOICE = encodeUnsignedBolt11({
  network: "testnet",
  amountSats: 21_000,
  paymentHash: Uint8Array.from({ length: 32 }, (_, i) => i),
  description: "CKBolt demo invoice (unsigned, not payable)",
  expirySeconds: 10 * 365 * 24 * 3600,
  timestamp: 1_790_000_000,
});

const RATE: RateSnapshot = { btcUsd: 80_000, ethUsd: 2_500, ckbUsd: 0.002, source: "fixture", updatedAt: 0 };
const token = (symbol: string) => PAY_TOKENS.find((t) => t.symbol === symbol)!;
const HASH = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);

/** Bytes to 5-bit words, padded (BIP-173 convertbits). */
function toWords(bytes: number[]): number[] {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = ((acc << 8) | b) & 0xfff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out.push((acc >> bits) & 31);
    }
  }
  if (bits) out.push((acc << (5 - bits)) & 31);
  return out;
}

// A full-format (RFC 0021) testnet address for the default secp256k1 lock.
const SECP_CODE_HASH = "9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8";
const CKB_ADDRESS = encodeBech32(
  "ckt",
  toWords([0x00, ...Buffer.from(SECP_CODE_HASH, "hex"), 0x01, ...new Array(20).fill(7)]),
  "bech32m",
);

// BOLT #11 test vectors (signed invoices from the specification).
const SPEC_DONATION =
  "lnbc1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq9qrsgq357wnc5r2ueh7ck6q93dj32dlqnls087fxdwk8qakdyafkq3yap9us6v52vjjsrvywa6rt52cm9r9zqt8r2t7mlcwspyetp5h2tztugp9lfyql";
const SPEC_COFFEE =
  "lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rh";
const SPEC_TESTNET =
  "lntb20m1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygshp58yjmdan79s6qqdhdzgynm4zwqd5d7xmw5fk98klysy043l2ahrqspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqfpp3x9et2e20v6pu37c5d9vax37wxq72un989qrsgqdj545axuxtnfemtpwkc45hx9d2ft7x04mt8q7y6t0k2dge9e7h8kpy9p34ytyslj3yu569aalz2xdk8xkd7ltxqld94u8h2esmsmacgpghe9k8";
const SPEC_HASH = "0001020304050607080900010203040506070809000102030405060708090102";

test.describe("bech32", () => {
  test("round-trips bech32 and bech32m", () => {
    const words = [0, 1, 2, 3, 31, 30, 29];
    for (const variant of ["bech32", "bech32m"] as const) {
      const s = encodeBech32("tb", words, variant);
      expect(decodeBech32(s)).toEqual({ hrp: "tb", words, variant });
    }
  });

  test("rejects a bad checksum and mixed case", () => {
    const s = encodeBech32("ckt", [1, 2, 3, 4, 5, 6], "bech32m");
    expect(() => decodeBech32(s.slice(0, -1) + (s.endsWith("q") ? "p" : "q"))).toThrow(/Checksum/);
    expect(() => decodeBech32(s.slice(0, 4).toUpperCase() + s.slice(4))).toThrow(/mixes/);
  });
});

test.describe("BOLT11", () => {
  test("decodes the demo invoice as an unsigned testnet invoice", () => {
    const d = decodeBolt11(DEMO_INVOICE);
    expect(d.network).toBe("testnet");
    expect(d.amountSats).toBe(21_000);
    expect(d.amountMsat).toBe(BigInt(21_000_000));
    expect(d.unsigned).toBe(true);
    expect(DEMO_INVOICE.startsWith("lntb210u1")).toBe(true);
  });

  test("round-trips amount, hash, description and expiry", () => {
    for (const sats of [1, 1263, 9_400, 21_000, 123_456_789]) {
      const inv = encodeUnsignedBolt11({ network: "signet", amountSats: sats, paymentHash: HASH, description: "coffee", expirySeconds: 120 });
      const d = decodeBolt11(inv);
      expect(d.amountSats).toBe(sats);
      expect(d.network).toBe("signet");
      expect(d.paymentHash).toBe(Buffer.from(HASH).toString("hex"));
      expect(d.description).toBe("coffee");
      expect(d.expirySeconds).toBe(120);
    }
  });

  test("follows the spec for amount multipliers", () => {
    const withAmount = (amount: string) => {
      // Re-use the demo invoice body with a different human-readable amount.
      const { words } = decodeBech32(DEMO_INVOICE);
      return encodeBech32(`lntb${amount}`, words, "bech32");
    };
    expect(decodeBolt11(withAmount("10p")).amountMsat).toBe(BigInt(1));
    expect(decodeBolt11(withAmount("10p")).amountSats).toBe(0.001);
    expect(decodeBolt11(withAmount("1m")).amountSats).toBe(100_000);
    expect(decodeBolt11(withAmount("2500n")).amountSats).toBe(250);
    expect(() => decodeBolt11(withAmount("1p"))).toThrow(/millisatoshi/);
    expect(() => decodeBolt11(withAmount("0"))).toThrow(/malformed/);
    expect(() => decodeBolt11(withAmount("010u"))).toThrow(/malformed/);
  });

  test("decodes the specification's test vectors", () => {
    const donation = decodeBolt11(SPEC_DONATION);
    expect(donation).toMatchObject({ network: "mainnet", amountMsat: null, timestamp: 1496314658, paymentHash: SPEC_HASH, unsigned: false });
    expect(donation.description).toBe("Please consider supporting this project");
    const coffee = decodeBolt11(SPEC_COFFEE);
    expect(coffee).toMatchObject({ amountSats: 250_000, expirySeconds: 60, description: "1 cup coffee", paymentHash: SPEC_HASH });
    const testnet = decodeBolt11(SPEC_TESTNET);
    expect(testnet).toMatchObject({ network: "testnet", amountSats: 2_000_000, paymentHash: SPEC_HASH });
  });

  test("rejects a tagged field that runs past the data", () => {
    const { words } = decodeBech32(encodeUnsignedBolt11({ network: "testnet", amountSats: 5, paymentHash: HASH, description: "abc", expirySeconds: 60 }));
    // Make the last field (x, expiry) claim more words than exist before the signature.
    const xAt = words.length - 104 - 4;
    const broken = [...words];
    broken[xAt + 1] = 31;
    expect(() => decodeBolt11(encodeBech32("lntb50n", broken, "bech32"))).toThrow(/truncated|malformed/);
  });

  test("refuses invoice amounts above 21 million BTC and bad prefixes", () => {
    const { words } = decodeBech32(DEMO_INVOICE);
    expect(() => decodeBolt11(encodeBech32("lntb99999999999", words, "bech32"))).toThrow(/21 million/);
    // BIP-173 invalid test vector: a character outside 33..126 in the prefix.
    expect(() => decodeBech32("\x7f" + "1axkwrx")).toThrow();
  });

  test("keeps large amounts out of exponent notation and caps them", () => {
    const inv = encodeUnsignedBolt11({ network: "testnet", amountSats: MAX_SATS, paymentHash: HASH, description: "", expirySeconds: 60 });
    expect(inv.startsWith("lntb21000000000000u1")).toBe(true);
    expect(decodeBolt11(inv).amountSats).toBe(MAX_SATS);
    expect(() => encodeUnsignedBolt11({ network: "testnet", amountSats: 1e20, paymentHash: HASH, description: "", expirySeconds: 60 })).toThrow(/21 million/);
  });

  test("refuses fields longer than BOLT11 allows", () => {
    expect(() =>
      encodeUnsignedBolt11({ network: "testnet", amountSats: 10, paymentHash: HASH, description: "x".repeat(700), expirySeconds: 60 }),
    ).toThrow(/too long/);
  });
});

test.describe("payment requests", () => {
  test("reads BIP21 links in any case and lightning: URIs", () => {
    for (const text of [
      `bitcoin:?lightning=${DEMO_INVOICE}`,
      `BITCOIN:?LIGHTNING=${DEMO_INVOICE.toUpperCase()}`,
      `bitcoin:tb1qexample?amount=0.0001&lightning=${DEMO_INVOICE}`,
      `lightning:${DEMO_INVOICE}`,
    ]) {
      const r = parsePaymentRequest(text);
      expect(r.kind).toBe("lightning");
    }
    expect(() => parsePaymentRequest("bitcoin:tb1qexample?amount=1")).toThrow(/no Lightning invoice/);
  });

  test("reads Fiber invoice network and amount", () => {
    const inv = demoFiberInvoice("testnet", BigInt(500 * 1e8));
    expect(decodeFiberInvoice(inv)).toMatchObject({ kind: "fiber", network: "testnet", amount: BigInt(50_000_000_000) });
    expect(() => decodeFiberInvoice(encodeBech32("fibt100", [1, 2, 3, 4, 5, 6, 7], "bech32"))).toThrow(/bech32m/);
  });

  test("recognises CKB addresses and rejects other text", () => {
    expect(parsePaymentRequest(CKB_ADDRESS)).toMatchObject({ kind: "ckb-address", network: "testnet" });
    // Right checksum, but far too short to hold a lock script.
    expect(() => parsePaymentRequest(encodeBech32("ckt", [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], "bech32m"))).toThrow(/not a complete CKB address/);
    expect(() => parsePaymentRequest("hello")).toThrow(/Not recognised/);
  });

  test("explains BOLT12 offers, LNURL, Lightning addresses and zero-amount Fiber invoices", () => {
    expect(() => parsePaymentRequest("lno1qcp4256ypq")).toThrow(/BOLT12/);
    expect(() => parsePaymentRequest("LNURL1DP68GURN8GHJ7UM9WFMXJCM99E3K7MF0V9CXJ0M385EKVCENXC6R2C35XVUKXEFCV5MKVV34X5EKZD3EV56NYD3HXQURZEPEXEJXXEPNXSCRVWFNV9NXZCN9XQ6XYEFHVGCXXCMYXYMNSERXFQ5FNS")).toThrow(/LNURL/);
    expect(() => parsePaymentRequest("satoshi@example.com")).toThrow(/Lightning address/);
    expect(() => parsePaymentRequest(demoFiberInvoice("testnet", BigInt(0)))).toThrow(/asks for 0/);
    expect(() => parsePaymentRequest(demoFiberInvoice("testnet", BigInt("100000000000000000000000000")))).toThrow(/more than the prototype quotes/);
  });
});

test.describe("amount input", () => {
  test("handles thousands separators and decimal commas", () => {
    expect(parseAmountInput("5,5")).toBe(5.5);
    expect(parseAmountInput("5.5")).toBe(5.5);
    expect(parseAmountInput("100,000")).toBe(100_000);
    expect(parseAmountInput("1,234,567.89")).toBe(1_234_567.89);
    expect(parseAmountInput("1.234,5")).toBe(1234.5);
    expect(parseAmountInput("1 000")).toBe(1000);
    expect(parseAmountInput("")).toBeNull();
    expect(parseAmountInput("1.2.3")).toBeNull();
    expect(parseAmountInput("5,5,5")).toBeNull();
    expect(parseAmountInput("abc")).toBeNull();
  });

  test("reads a leading zero as a decimal and rejects mixed grouping", () => {
    expect(parseAmountInput("0,001")).toBe(0.001);
    expect(parseAmountInput("0,500")).toBe(0.5);
    expect(parseAmountInput("1,500")).toBe(1500);
    expect(parseAmountInput("1.234.567")).toBe(1_234_567);
    expect(parseAmountInput("1.234.567,8")).toBe(1_234_567.8);
    expect(parseAmountInput("1,5.3")).toBeNull();
    expect(parseAmountInput("1.5,3")).toBeNull();
    expect(parseAmountInput("12.34,5")).toBeNull();
    expect(parseAmountInput("-5")).toBeNull();
    expect(parseAmountInput("1e5")).toBeNull();
  });

  test("reads the one ambiguous shape with the locale's decimal mark", () => {
    // "1,250" is $1,250 in English and $1.25 in Vietnamese or German.
    expect(parseAmountInput("1,250", ".")).toBe(1250);
    expect(parseAmountInput("1,250", ",")).toBe(1.25);
    expect(parseAmountInput("1.250", ".")).toBe(1.25);
    expect(parseAmountInput("1.250", ",")).toBe(1250);
    // Unambiguous shapes read the same everywhere.
    expect(parseAmountInput("1.234,5", ".")).toBe(1234.5);
    expect(parseAmountInput("1,234.5", ",")).toBe(1234.5);
    expect(parseAmountInput("0,001", ".")).toBe(0.001);
    expect(parseAmountInput("12,5", ".")).toBe(12.5);
    // Sats are whole: separators can only group thousands.
    expect(parseSatsInput("1.000")).toBe(1000);
    expect(parseSatsInput("50 000")).toBe(50_000);
    expect(parseSatsInput("1.5")).toBeNull();
  });

  test("prints base units exactly", () => {
    expect(formatBaseUnits(BigInt(50_000_000_000))).toBe("500");
    expect(formatBaseUnits(BigInt(1))).toBe("0.00000001");
    expect(formatBaseUnits(BigInt(123_456_789))).toBe("1.23456789");
  });

  test("accepts whole sats only", () => {
    expect(parseSatsInput("50,000")).toBe(50_000);
    expect(parseSatsInput("1,5")).toBeNull();
  });
});

test.describe("quote maths", () => {
  test("adds and removes the assumed 1% hub costs", () => {
    expect(HUB_COST_FACTOR).toBeCloseTo(1.01);
    expect(satsForUsd(5, RATE)).toEqual({ marketSats: 6250, sats: 6313 });
  });

  test("prices the landing page's swap examples", () => {
    expect(quoteSwap(100_000, token("CKB"), "BTC", RATE)!.receiveAmount).toBeCloseTo(0.002475, 9);
    expect(quoteSwap(100_000, token("CKB"), "ETH", RATE)!.receiveAmount).toBeCloseTo(0.0792, 9);
    expect(quoteSwap(100, token("RUSD"), "BTC", RATE)!.receiveAmount).toBeCloseTo(0.0012375, 9);
  });

  test("never shows a small output as zero", () => {
    // 10 CKB = $0.02 = 0.00000025 BTC after costs.
    expect(formatAsset(quoteSwap(10, token("CKB"), "BTC", RATE)!.receiveAmount, "BTC")).toBe("0.00000025");
    expect(formatAsset(0.0792, "ETH")).toBe("0.0792");
    expect(formatAsset(0.0000079, "ETH")).toBe("0.00000790");
    expect(formatAsset(0.002475, "BTC")).toBe("0.002475");
  });

  test("refuses tokens without a price source", () => {
    expect(quoteSwap(1, token("STB"), "BTC", RATE)).toBeNull();
    expect(quoteSwap(1, token("Seal"), "BTC", RATE)).toBeNull();
  });
});
