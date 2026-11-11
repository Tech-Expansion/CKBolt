import type { DecodePaymentRequestResult, GetChannelBalanceResult, GetInvoiceResult, GetPaymentResult, GetWalletInfoResult } from "lightning";
import { BOLT11_DEFAULT_MIN_FINAL_CLTV_EXPIRY, LND_PAYMENT_FAILURE_REASON } from "../../../src/common/constants/lnd.constants";
import {
  failedPayment,
  failureReasonOf,
  inFlightPayment,
  invoiceStateOf,
  succeededPayment,
  toBalances,
  toDecodedInvoice,
  toInvoiceStatus,
  toNodeInfo,
  toPaymentStatus,
} from "../../../src/infrastructure/lightning/lnd.mappers";
import { HUB_PUBKEY, LND_VERSION, PAYMENT_HASH, PREIMAGE } from "./lightning.fixtures";

const decoded = (patch: Record<string, unknown> = {}) =>
  ({
    id: PAYMENT_HASH,
    mtokens: "1000",
    tokens: 1,
    cltv_delta: 40,
    created_at: "2026-10-23T12:00:00.000Z",
    expires_at: "2026-10-23T13:00:00.000Z",
    destination: HUB_PUBKEY,
    description: "memo",
    ...patch,
  }) as unknown as DecodePaymentRequestResult;

const invoice = (patch: Record<string, unknown> = {}) =>
  ({
    id: PAYMENT_HASH,
    tokens: 25,
    mtokens: "25000",
    received_mtokens: "0",
    is_confirmed: false,
    payments: [],
    ...patch,
  }) as unknown as GetInvoiceResult;

describe("toNodeInfo", () => {
  it("maps the wallet info and uses the configured network", () => {
    const info = { public_key: HUB_PUBKEY, current_block_height: 812, is_synced_to_chain: true, version: LND_VERSION } as GetWalletInfoResult;
    expect(toNodeInfo(info, "testnet4")).toEqual({ pubkey: HUB_PUBKEY, network: "testnet4", blockHeight: 812, synced: true, version: LND_VERSION, uris: [] });
  });

  it("copies the URIs the node announces (pubkey@host:port), empty when it announces none", () => {
    const uris = [`${HUB_PUBKEY}@203.0.113.7:9735`, `${HUB_PUBKEY}@[2001:db8::7]:9735`];
    const info = { public_key: HUB_PUBKEY, current_block_height: 812, is_synced_to_chain: true, version: LND_VERSION, uris } as GetWalletInfoResult;
    const mapped = toNodeInfo(info, "signet");
    expect(mapped.uris).toEqual(uris);
    expect(mapped.uris).not.toBe(uris);
  });
});

describe("toDecodedInvoice", () => {
  it("converts ISO dates to epoch ms", () => {
    expect(toDecodedInvoice(decoded(), "regtest")).toMatchObject({ createdAt: Date.UTC(2026, 9, 23, 12), expiresAt: Date.UTC(2026, 9, 23, 13) });
  });

  it("treats a zero amount as 'no amount' and keeps msat precision otherwise", () => {
    expect(toDecodedInvoice(decoded({ mtokens: "0" }), "regtest").amountMsat).toBeNull();
    expect(toDecodedInvoice(decoded({ mtokens: "123456789012345678" }), "regtest").amountMsat).toBe(123_456_789_012_345_678n);
  });

  it("defaults a missing CLTV to the BOLT11 default and a missing description to empty", () => {
    expect(toDecodedInvoice(decoded({ cltv_delta: undefined, description: undefined }), "regtest")).toMatchObject({
      cltvExpiry: BOLT11_DEFAULT_MIN_FINAL_CLTV_EXPIRY,
      description: "",
    });
  });

  it.each([
    ["created_at", { created_at: undefined }],
    ["created_at", { created_at: "not a date" }],
    ["expires_at", { expires_at: "not a date" }],
  ])("throws on an unreadable %s rather than inventing a date", (_field, patch) => {
    expect(() => toDecodedInvoice(decoded(patch), "regtest")).toThrow(/unreadable/);
  });

  it("throws when the payment hash is not 32 bytes of hex", () => {
    expect(() => toDecodedInvoice(decoded({ id: "abcd" }), "regtest")).toThrow();
  });
});

describe("invoiceStateOf", () => {
  it.each([
    [{ is_confirmed: false }, "OPEN"],
    [{ is_confirmed: false, is_held: true }, "ACCEPTED"],
    [{ is_confirmed: true }, "SETTLED"],
    [{ is_confirmed: false, is_canceled: true }, "CANCELED"],
    [{ is_confirmed: true, is_held: true }, "SETTLED"],
    [{ is_confirmed: false, is_canceled: true, is_held: true }, "CANCELED"],
  ])("maps %p to %s", (flags, state) => {
    expect(invoiceStateOf(flags as Parameters<typeof invoiceStateOf>[0])).toBe(state);
  });
});

describe("toInvoiceStatus", () => {
  it("uses the msat amount, and falls back to tokens x 1000 when the package leaves it out", () => {
    expect(toInvoiceStatus(invoice({ mtokens: "25001" })).amountMsat).toBe(25_001n);
    expect(toInvoiceStatus(invoice({ mtokens: undefined })).amountMsat).toBe(25_000n);
  });

  it("lists the expiry height of every held HTLC and only of held ones", () => {
    const payments = [
      { is_held: true, timeout: 640 },
      { is_held: false, is_canceled: true, timeout: 600 },
      { is_held: true, timeout: 655 },
    ];
    expect(toInvoiceStatus(invoice({ is_held: true, received_mtokens: "25000", payments }))).toEqual({
      paymentHash: PAYMENT_HASH,
      state: "ACCEPTED",
      amountMsat: 25_000n,
      amountPaidMsat: 25_000n,
      htlcExpiryHeights: [640, 655],
    });
  });

  it("normalises the hash to Hex32", () => {
    expect(toInvoiceStatus(invoice({ id: PAYMENT_HASH.toUpperCase() })).paymentHash).toBe(PAYMENT_HASH);
  });
});

describe("payment status mapping", () => {
  it("failureReasonOf maps each failure flag to LND's reason and defaults to FAILURE_REASON_ERROR", () => {
    expect(failureReasonOf({ is_route_not_found: true })).toBe(LND_PAYMENT_FAILURE_REASON.NO_ROUTE);
    expect(failureReasonOf({ is_canceled: true })).toBe(LND_PAYMENT_FAILURE_REASON.CANCELED);
    expect(failureReasonOf({ is_route_not_found: false })).toBe(LND_PAYMENT_FAILURE_REASON.ERROR);
    expect(failureReasonOf({})).toBe(LND_PAYMENT_FAILURE_REASON.ERROR);
  });

  it("builds the three statuses with the fields the port promises", () => {
    expect(inFlightPayment(PAYMENT_HASH)).toEqual({ paymentHash: PAYMENT_HASH, state: "IN_FLIGHT", preimage: null, feeMsat: 0n, failureReason: null });
    expect(succeededPayment(PAYMENT_HASH, { secret: PREIMAGE, fee_mtokens: "7" })).toEqual({
      paymentHash: PAYMENT_HASH,
      state: "SUCCEEDED",
      preimage: PREIMAGE,
      feeMsat: 7n,
      failureReason: null,
    });
    expect(failedPayment(PAYMENT_HASH, "WHY")).toEqual({ paymentHash: PAYMENT_HASH, state: "FAILED", preimage: null, feeMsat: 0n, failureReason: "WHY" });
  });

  it("refuses a settled payment whose preimage is not 32 bytes of hex", () => {
    expect(() => succeededPayment(PAYMENT_HASH, { secret: "zz", fee_mtokens: "0" })).toThrow();
  });

  it("toPaymentStatus maps pending, confirmed and failed results", () => {
    expect(toPaymentStatus({ is_pending: true } as GetPaymentResult, PAYMENT_HASH).state).toBe("IN_FLIGHT");
    expect(toPaymentStatus({ is_confirmed: true, payment: { secret: PREIMAGE, fee_mtokens: "0" } } as GetPaymentResult, PAYMENT_HASH)).toMatchObject({
      state: "SUCCEEDED",
      preimage: PREIMAGE,
    });
    expect(toPaymentStatus({ is_failed: true } as GetPaymentResult, PAYMENT_HASH)).toMatchObject({ state: "FAILED", failureReason: LND_PAYMENT_FAILURE_REASON.ERROR });
  });
});

describe("toBalances", () => {
  it("returns bigint sats and treats a missing inbound as zero", () => {
    expect(toBalances({ channel_balance: 10, inbound: 20 } as GetChannelBalanceResult, 30n)).toEqual({ channelLocalSats: 10n, channelRemoteSats: 20n, onchainSats: 30n });
    expect(toBalances({ channel_balance: 10 } as GetChannelBalanceResult, 0n).channelRemoteSats).toBe(0n);
  });
});
