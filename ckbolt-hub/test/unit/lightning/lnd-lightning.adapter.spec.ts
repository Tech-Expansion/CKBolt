import { HttpStatus, Logger } from "@nestjs/common";
import { API_ERROR_CODE } from "../../../src/common/constants/api.constants";
import { BOLT11_DEFAULT_MIN_FINAL_CLTV_EXPIRY, LND_PAYMENT_FAILURE_REASON } from "../../../src/common/constants/lnd.constants";
import { BOLT11_PREFIXES } from "../../../src/common/constants/protocol.constants";
import { DuplicateHashError, HubError } from "../../../src/common/errors/hub.error";
import { sha256Hex } from "../../../src/common/utils/hex.util";
import {
  LndRpcError,
  LndUnavailableError,
  LnInvoiceInvalidError,
  LnInvoiceWrongNetworkError,
} from "../../../src/infrastructure/lightning/lnd.errors";
import type { LndLightningAdapter } from "../../../src/infrastructure/lightning/lnd-lightning.adapter";
import { FakeClock } from "../../fakes";
import { GRPC_CODE, HUB_PUBKEY, LND_DETAILS, LND_VERSION, PAYMENT_HASH, PREIMAGE, REGTEST_SETTINGS, START_HEIGHT, libError, libOnlyError, newPreimage } from "./lightning.fixtures";
import type { BtcNetwork } from "../../../src/domain/types";
import {
  LndPackageSimulator,
  confirmedPaymentResult,
  createAdapter,
  failedPaymentResult,
  pendingPaymentResult,
} from "./lnd-package.simulator";

/** Asserts a rejection is a HubError the API maps to `status` and `code`. */
async function expectHubError(promise: Promise<unknown>, type: abstract new (...args: never[]) => HubError, status: number, code: string): Promise<void> {
  const error = await promise.then(
    () => {
      throw new Error("Expected a rejection");
    },
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(type);
  expect(error).toMatchObject({ status, code });
}

const unavailable = (name: string) => libError(name, GRPC_CODE.UNAVAILABLE, LND_DETAILS.CONNECT_FAILED);

describe("LndLightningAdapter", () => {
  let sim: LndPackageSimulator;
  let clock: FakeClock;
  let adapter: LndLightningAdapter;

  beforeEach(() => {
    sim = new LndPackageSimulator();
    clock = new FakeClock();
    adapter = createAdapter(sim, { clock });
  });

  afterEach(() => {
    adapter.close();
    jest.restoreAllMocks();
  });

  /* ---------------------------------------------------------------------------------------------- getInfo */

  describe("getInfo", () => {
    it("maps getWalletInfo and takes the network from the chain LND names, not from the config", async () => {
      sim.network = "signet";
      await expect(adapter.getInfo()).resolves.toEqual({
        pubkey: HUB_PUBKEY,
        network: "signet",
        blockHeight: START_HEIGHT,
        synced: true,
        version: LND_VERSION,
        uris: [],
      });
    });

    it("reports a node that is not synced to the chain", async () => {
      sim.synced = false;
      await expect(adapter.getInfo()).resolves.toMatchObject({ synced: false });
    });

    it("reports a gRPC UNAVAILABLE answer as LndUnavailableError (503 upstream_unavailable)", async () => {
      sim.rpc.getWalletInfo.mockRejectedValueOnce(unavailable("GetWalletInfoErr"));
      await expectHubError(adapter.getInfo(), LndUnavailableError, HttpStatus.SERVICE_UNAVAILABLE, API_ERROR_CODE.UPSTREAM_UNAVAILABLE);
    });

    it("reports an unreachable node, as the package says it (FailedToConnectToDaemon), as LndUnavailableError", async () => {
      sim.rpc.getWalletInfo.mockRejectedValueOnce(libOnlyError("FailedToConnectToDaemon"));
      await expectHubError(adapter.getInfo(), LndUnavailableError, HttpStatus.SERVICE_UNAVAILABLE, API_ERROR_CODE.UPSTREAM_UNAVAILABLE);
    });

    it("reports an unexpected LND error as LndRpcError naming the RPC", async () => {
      sim.rpc.getWalletInfo.mockRejectedValueOnce(libError("GetWalletInfoErr", GRPC_CODE.UNKNOWN, "boom"));
      const error = await adapter.getInfo().catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(LndRpcError);
      expect((error as Error).message).toContain("GetInfo");
      expect((error as Error).message).toContain("boom");
    });
  });

  /* ---------------------------------------------------------------------------------------- decodeInvoice */

  describe("decodeInvoice", () => {
    it("maps every field: hash, msat amount, network from the prefix, dates in ms, CLTV, payee and description", async () => {
      const expiresAtMs = Date.UTC(2026, 9, 23, 13, 0);
      const request = sim.addPayable({ hash: PAYMENT_HASH, mtokens: "250001", cltvDelta: 40, expiresAtMs, description: "BTC payout" });

      await expect(adapter.decodeInvoice(request)).resolves.toEqual({
        paymentHash: PAYMENT_HASH,
        amountMsat: 250_001n,
        network: "regtest",
        createdAt: Date.UTC(2026, 9, 23, 11, 55),
        expiresAt: expiresAtMs,
        cltvExpiry: 40,
        destination: `03${"cd".repeat(32)}`,
        description: "BTC payout",
      });
      expect(sim.rpc.decodePaymentRequest).toHaveBeenCalledWith({ lnd: sim.lnd, request });
    });

    it("returns a null amount for an invoice without one", async () => {
      const request = sim.addPayable({ hash: PAYMENT_HASH, mtokens: "0" });
      await expect(adapter.decodeInvoice(request)).resolves.toMatchObject({ amountMsat: null });
    });

    it("uses the BOLT11 default min_final_cltv_expiry (18) when the invoice has no `c` field", async () => {
      const request = sim.addPayable({ hash: PAYMENT_HASH });
      await expect(adapter.decodeInvoice(request)).resolves.toMatchObject({ cltvExpiry: BOLT11_DEFAULT_MIN_FINAL_CLTV_EXPIRY });
      expect(BOLT11_DEFAULT_MIN_FINAL_CLTV_EXPIRY).toBe(18);
    });

    it("returns the payment hash as Hex32 even when LND sends it in upper case", async () => {
      const request = sim.addPayable({ hash: PAYMENT_HASH });
      sim.decodable.get(request)!.id = PAYMENT_HASH.toUpperCase();
      await expect(adapter.decodeInvoice(request)).resolves.toMatchObject({ paymentHash: PAYMENT_HASH });
    });

    it("returns an empty description when the invoice has none", async () => {
      const request = sim.addPayable({ hash: PAYMENT_HASH });
      (sim.decodable.get(request) as { description?: string }).description = undefined;
      await expect(adapter.decodeInvoice(request)).resolves.toMatchObject({ description: "" });
    });

    const adapterOn = (network: BtcNetwork): LndLightningAdapter => createAdapter(sim, { clock, settings: { ...REGTEST_SETTINGS, network } });

    it.each(BOLT11_PREFIXES.map(({ prefix, network }) => [prefix, network]))("reads network of a %s invoice as %s", async (prefix, network) => {
      const request = sim.addPayable({ hash: PAYMENT_HASH, prefix });
      await expect(adapterOn(network).decodeInvoice(request)).resolves.toMatchObject({ network });
    });

    it("reads the prefix case-insensitively and ignores surrounding whitespace", async () => {
      const request = sim.addPayable({ hash: PAYMENT_HASH, prefix: "LNTBS" });
      await expect(adapterOn("signet").decodeInvoice(request)).resolves.toMatchObject({ network: "signet" });
      const padded = `  ${sim.addPayable({ hash: PAYMENT_HASH, prefix: "lnbc" })}`;
      sim.decodable.set(padded, sim.decodable.get(padded.trim())!);
      await expect(adapterOn("mainnet").decodeInvoice(padded)).resolves.toMatchObject({ network: "mainnet" });
    });

    it("on testnet4 decodes lntb invoices: testnet3 and testnet4 share the prefix", async () => {
      const request = sim.addPayable({ hash: PAYMENT_HASH, prefix: "lntb" });
      await expect(adapterOn("testnet4").decodeInvoice(request)).resolves.toMatchObject({ network: "testnet" });
    });

    it.each([
      ["regtest", "lntb", "testnet"],
      ["testnet4", "lntbs", "signet"],
      ["signet", "lntb", "testnet"],
      ["mainnet", "lnbcrt", "regtest"],
    ] as const)("on %s refuses a %s invoice (%s) with LnInvoiceWrongNetworkError (422) without asking LND", async (nodeNetwork, prefix, invoiceNetwork) => {
      const request = sim.addPayable({ hash: PAYMENT_HASH, prefix });
      const error = await adapterOn(nodeNetwork).decodeInvoice(request).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(LnInvoiceWrongNetworkError);
      expect(error).toMatchObject({ status: HttpStatus.UNPROCESSABLE_ENTITY, code: API_ERROR_CODE.INVOICE_INVALID, invoiceNetwork, nodeNetwork });
      expect(sim.rpc.decodePaymentRequest).not.toHaveBeenCalled();
    });

    it.each([
      ["a Fiber invoice", "fibt1qqqqqqq"],
      ["a simnet invoice", "lnsb1pqqqqqq"],
      ["an empty string", ""],
      ["a lightning: URI", "lightning:lnbc1pqqqqqq"],
    ])("rejects %s with LnInvoiceInvalidError (400 invoice_invalid) without asking LND", async (_name, request) => {
      await expectHubError(adapter.decodeInvoice(request), LnInvoiceInvalidError, HttpStatus.BAD_REQUEST, API_ERROR_CODE.INVOICE_INVALID);
      expect(sim.rpc.decodePaymentRequest).not.toHaveBeenCalled();
    });

    it("rejects an invoice LND cannot read with LnInvoiceInvalidError (400)", async () => {
      await expectHubError(adapter.decodeInvoice("lnbcrt1pgarbage"), LnInvoiceInvalidError, HttpStatus.BAD_REQUEST, API_ERROR_CODE.INVOICE_INVALID);
    });

    it("maps LND's own wrong-network answer to LnInvoiceWrongNetworkError (422) naming both networks", async () => {
      const request = sim.addPayable({ hash: PAYMENT_HASH, prefix: "lntb" });
      sim.rpc.decodePaymentRequest.mockRejectedValueOnce(libError("UnexpectedDecodePaymentRequestError", GRPC_CODE.UNKNOWN, LND_DETAILS.WRONG_NETWORK));
      const error = await adapterOn("testnet4").decodeInvoice(request).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(LnInvoiceWrongNetworkError);
      expect(error).toMatchObject({ status: HttpStatus.UNPROCESSABLE_ENTITY, code: API_ERROR_CODE.INVOICE_INVALID, invoiceNetwork: "testnet", nodeNetwork: "testnet4" });
      expect((error as Error).message).toContain("testnet");
      expect((error as Error).message).toContain("testnet4");
    });

    it.each([
      ["UNAVAILABLE", GRPC_CODE.UNAVAILABLE, LND_DETAILS.CONNECT_FAILED],
      ["DEADLINE_EXCEEDED", GRPC_CODE.DEADLINE_EXCEEDED, LND_DETAILS.DEADLINE],
    ])("reports a transport failure (%s) as LndUnavailableError, not as a bad invoice", async (_name, code, details) => {
      const request = sim.addPayable({ hash: PAYMENT_HASH });
      sim.rpc.decodePaymentRequest.mockRejectedValueOnce(libError("UnexpectedDecodePaymentRequestError", code, details));
      await expectHubError(adapter.decodeInvoice(request), LndUnavailableError, HttpStatus.SERVICE_UNAVAILABLE, API_ERROR_CODE.UPSTREAM_UNAVAILABLE);
    });

    it.each([
      ["PERMISSION_DENIED", GRPC_CODE.PERMISSION_DENIED],
      ["UNAUTHENTICATED", GRPC_CODE.UNAUTHENTICATED],
    ])("does not blame the user's invoice when the macaroon is refused (%s)", async (_name, code) => {
      const request = sim.addPayable({ hash: PAYMENT_HASH });
      sim.rpc.decodePaymentRequest.mockRejectedValueOnce(libError("UnexpectedDecodePaymentRequestError", code, LND_DETAILS.PERMISSION));
      const error = await adapter.decodeInvoice(request).catch((reason: unknown) => reason);
      expect(error).not.toBeInstanceOf(LnInvoiceInvalidError);
      expect(error).not.toBeInstanceOf(LnInvoiceWrongNetworkError);
      expect(error).toBeInstanceOf(LndRpcError);
    });
  });

  /* ------------------------------------------------------------------------------------ createHoldInvoice */

  describe("createHoldInvoice", () => {
    const holdArgs = { paymentHash: PAYMENT_HASH, amountSats: 25_000n, expirySeconds: 180, cltvExpiry: 144, memo: "CKBolt swap" };

    it("creates a hold invoice on the swap hash with the amount, expiry from the clock, cltv_delta and memo", async () => {
      const { paymentRequest } = await adapter.createHoldInvoice(holdArgs);

      expect(sim.rpc.createHodlInvoice).toHaveBeenCalledTimes(1);
      expect(sim.rpc.createHodlInvoice).toHaveBeenCalledWith({
        lnd: sim.lnd,
        id: PAYMENT_HASH,
        tokens: 25_000,
        expires_at: new Date(clock.now() + 180_000).toISOString(),
        cltv_delta: 144,
        description: "CKBolt swap",
        is_including_private_channels: false,
      });
      expect(paymentRequest).toBe(sim.requireInvoice(PAYMENT_HASH).request);
    });

    it("adds route hints for the node's private channels when configured (LN_INVOICE_ROUTE_HINTS)", async () => {
      const hinting = createAdapter(sim, { clock, settings: { ...REGTEST_SETTINGS, invoiceRouteHints: true } });
      await hinting.createHoldInvoice(holdArgs);
      expect(sim.rpc.createHodlInvoice.mock.calls[0]?.[0]).toMatchObject({ is_including_private_channels: true });
    });

    it("follows the injected clock for expires_at", async () => {
      clock.advance(42_000);
      await adapter.createHoldInvoice({ ...holdArgs, expirySeconds: 60 });
      expect(sim.rpc.createHodlInvoice.mock.calls[0]?.[0]).toMatchObject({ expires_at: new Date(clock.now() + 60_000).toISOString() });
    });

    it("sends the hash as lowercase hex without 0x", async () => {
      await adapter.createHoldInvoice({ ...holdArgs, paymentHash: `0x${PAYMENT_HASH.toUpperCase()}` });
      expect(sim.rpc.createHodlInvoice.mock.calls[0]?.[0]).toMatchObject({ id: PAYMENT_HASH });
    });

    it("never asks LND to generate a preimage: the id is always the given hash", async () => {
      await adapter.createHoldInvoice(holdArgs);
      const args = sim.rpc.createHodlInvoice.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(args.id).toBe(PAYMENT_HASH);
      expect(args).not.toHaveProperty("secret");
    });

    it("rejects a hash LND already has with DuplicateHashError (409 duplicate_hash)", async () => {
      await adapter.createHoldInvoice(holdArgs);
      await expectHubError(adapter.createHoldInvoice(holdArgs), DuplicateHashError, HttpStatus.CONFLICT, API_ERROR_CODE.DUPLICATE_HASH);
    });

    it("reports a transport failure as LndUnavailableError", async () => {
      sim.rpc.createHodlInvoice.mockRejectedValueOnce(unavailable("UnexpectedAddHodlInvoiceError"));
      await expectHubError(adapter.createHoldInvoice(holdArgs), LndUnavailableError, HttpStatus.SERVICE_UNAVAILABLE, API_ERROR_CODE.UPSTREAM_UNAVAILABLE);
    });

    it("reports other LND refusals (for example a CLTV delta below 24) as LndRpcError", async () => {
      sim.rpc.createHodlInvoice.mockRejectedValueOnce(libError("UnexpectedAddHodlInvoiceError", GRPC_CODE.UNKNOWN, "CLTV delta of 18 must be greater than minimum of 24"));
      await expect(adapter.createHoldInvoice({ ...holdArgs, cltvExpiry: 18 })).rejects.toBeInstanceOf(LndRpcError);
    });

    it.each([
      ["negative", -1n],
      ["beyond Number.MAX_SAFE_INTEGER", BigInt(Number.MAX_SAFE_INTEGER) + 1n],
    ])("refuses a %s amount without creating anything", async (_name, amountSats) => {
      await expect(adapter.createHoldInvoice({ ...holdArgs, amountSats })).rejects.toThrow();
      expect(sim.invoices.size).toBe(0);
    });
  });

  /* ---------------------------------------------------------------------------------------- createInvoice */

  describe("createInvoice", () => {
    it("creates a regular invoice and returns its request and the hash LND chose", async () => {
      const result = await adapter.createInvoice({ amountSats: 1_000n, expirySeconds: 600, memo: "demo" });

      expect(sim.rpc.createInvoice).toHaveBeenCalledWith({
        lnd: sim.lnd,
        tokens: 1_000,
        expires_at: new Date(clock.now() + 600_000).toISOString(),
        description: "demo",
      });
      const invoice = sim.requireInvoice(result.paymentHash);
      expect(result).toEqual({ paymentRequest: invoice.request, paymentHash: invoice.id });
      expect(sha256Hex(invoice.secret!)).toBe(result.paymentHash);
    });

    it("returns the hash as lowercase Hex32", async () => {
      const { hash } = newPreimage();
      sim.rpc.createInvoice.mockResolvedValueOnce({ id: hash.toUpperCase(), request: "lnbcrt10u1pdemo", secret: "00".repeat(32), created_at: "" });
      await expect(adapter.createInvoice({ amountSats: 1_000n, expirySeconds: 600, memo: "demo" })).resolves.toEqual({ paymentRequest: "lnbcrt10u1pdemo", paymentHash: hash });
    });

    it("reports a transport failure as LndUnavailableError", async () => {
      sim.rpc.createInvoice.mockRejectedValueOnce(unavailable("AddInvoiceError"));
      await expect(adapter.createInvoice({ amountSats: 1_000n, expirySeconds: 600, memo: "demo" })).rejects.toBeInstanceOf(LndUnavailableError);
    });
  });

  /* ---------------------------------------------------------------------------------------- lookupInvoice */

  describe("lookupInvoice", () => {
    const createHold = () => adapter.createHoldInvoice({ paymentHash: PAYMENT_HASH, amountSats: 25_000n, expirySeconds: 180, cltvExpiry: 144, memo: "swap" });

    it("returns null for a hash LND does not know (gRPC NOT_FOUND)", async () => {
      await expect(adapter.lookupInvoice(PAYMENT_HASH)).resolves.toBeNull();
    });

    it.each([
      ["unable to locate invoice", GRPC_CODE.UNKNOWN, LND_DETAILS.INVOICE_NOT_FOUND],
      ["there are no existing invoices", GRPC_CODE.UNKNOWN, LND_DETAILS.NO_INVOICES],
      ["NOT_FOUND without details", GRPC_CODE.NOT_FOUND, ""],
    ])("returns null when LND says %s", async (_name, code, details) => {
      sim.rpc.getInvoice.mockRejectedValueOnce(libError("UnexpectedLookupInvoiceErr", code, details));
      await expect(adapter.lookupInvoice(PAYMENT_HASH)).resolves.toBeNull();
    });

    it("throws LndUnavailableError on a transport failure instead of claiming the invoice is missing", async () => {
      sim.rpc.getInvoice.mockRejectedValueOnce(unavailable("UnexpectedLookupInvoiceErr"));
      await expect(adapter.lookupInvoice(PAYMENT_HASH)).rejects.toBeInstanceOf(LndUnavailableError);
    });

    it("throws on other errors (a refused macaroon is not a missing invoice)", async () => {
      sim.rpc.getInvoice.mockRejectedValueOnce(libError("UnexpectedLookupInvoiceErr", GRPC_CODE.PERMISSION_DENIED, LND_DETAILS.PERMISSION));
      await expect(adapter.lookupInvoice(PAYMENT_HASH)).rejects.toBeInstanceOf(LndRpcError);
    });

    it("reports an unpaid hold invoice as OPEN with nothing paid and no held HTLCs", async () => {
      await createHold();
      await expect(adapter.lookupInvoice(PAYMENT_HASH)).resolves.toEqual({
        paymentHash: PAYMENT_HASH,
        state: "OPEN",
        amountMsat: 25_000_000n,
        amountPaidMsat: 0n,
        htlcExpiryHeights: [],
      });
    });

    it("reports held HTLCs as ACCEPTED with the paid amount and every held HTLC's expiry height", async () => {
      await createHold();
      sim.acceptHtlcs(PAYMENT_HASH, [652, 648]);
      await expect(adapter.lookupInvoice(PAYMENT_HASH)).resolves.toEqual({
        paymentHash: PAYMENT_HASH,
        state: "ACCEPTED",
        amountMsat: 25_000_000n,
        amountPaidMsat: 25_000_000n,
        htlcExpiryHeights: [652, 648],
      });
    });

    it("lists only HTLCs that are still held (not cancelled ones of an earlier MPP attempt)", async () => {
      await createHold();
      sim.acceptHtlcs(PAYMENT_HASH, [652, 648]);
      sim.requireInvoice(PAYMENT_HASH).payments.push({ timeout: 600, mtokens: "1000", is_held: false, is_canceled: true, is_confirmed: false });
      await expect(adapter.lookupInvoice(PAYMENT_HASH)).resolves.toMatchObject({ htlcExpiryHeights: [652, 648] });
    });

    it("reports SETTLED after settle and CANCELED after cancel, with no held HTLCs", async () => {
      await createHold();
      sim.acceptHtlcs(PAYMENT_HASH, [652]);
      await adapter.settleInvoice(PREIMAGE);
      await expect(adapter.lookupInvoice(PAYMENT_HASH)).resolves.toMatchObject({ state: "SETTLED", htlcExpiryHeights: [] });

      const other = newPreimage();
      await adapter.createHoldInvoice({ paymentHash: other.hash, amountSats: 1_000n, expirySeconds: 180, cltvExpiry: 144, memo: "swap" });
      sim.acceptHtlcs(other.hash, [652]);
      await adapter.cancelInvoice(other.hash);
      await expect(adapter.lookupInvoice(other.hash)).resolves.toMatchObject({ state: "CANCELED", htlcExpiryHeights: [] });
    });

    it("keeps msat precision of the invoiced and paid amounts", async () => {
      await createHold();
      const invoice = sim.requireInvoice(PAYMENT_HASH);
      invoice.mtokens = "25000999";
      sim.acceptHtlcs(PAYMENT_HASH, [652]);
      await expect(adapter.lookupInvoice(PAYMENT_HASH)).resolves.toMatchObject({ amountMsat: 25_000_999n, amountPaidMsat: 25_000_999n });
    });

    it("asks LND with the hash as lowercase hex", async () => {
      await adapter.lookupInvoice(PAYMENT_HASH.toUpperCase());
      expect(sim.rpc.getInvoice).toHaveBeenCalledWith({ lnd: sim.lnd, id: PAYMENT_HASH });
    });
  });

  /* ------------------------------------------------------------------------------- settle and cancel */

  describe("settleInvoice", () => {
    beforeEach(async () => {
      await adapter.createHoldInvoice({ paymentHash: PAYMENT_HASH, amountSats: 25_000n, expirySeconds: 180, cltvExpiry: 144, memo: "swap" });
    });

    it("settles an accepted hold invoice with the preimage", async () => {
      sim.acceptHtlcs(PAYMENT_HASH, [652]);
      await adapter.settleInvoice(PREIMAGE);
      expect(sim.rpc.settleHodlInvoice).toHaveBeenCalledWith({ lnd: sim.lnd, secret: PREIMAGE });
      expect(sim.requireInvoice(PAYMENT_HASH).state).toBe("SETTLED");
    });

    it("is idempotent: settling a settled invoice again succeeds", async () => {
      sim.acceptHtlcs(PAYMENT_HASH, [652]);
      await adapter.settleInvoice(PREIMAGE);
      await expect(adapter.settleInvoice(PREIMAGE)).resolves.toBeUndefined();
    });

    it("treats LND's 'invoice already settled' answer as success", async () => {
      sim.rpc.settleHodlInvoice.mockRejectedValueOnce(libError("UnexpectedErrorWhenSettlingHodlInvoice", GRPC_CODE.UNKNOWN, LND_DETAILS.ALREADY_SETTLED));
      await expect(adapter.settleInvoice(PREIMAGE)).resolves.toBeUndefined();
    });

    it("fails when the invoice was cancelled: a lost incoming leg must never look settled", async () => {
      sim.acceptHtlcs(PAYMENT_HASH, [652]);
      await adapter.cancelInvoice(PAYMENT_HASH);
      await expect(adapter.settleInvoice(PREIMAGE)).rejects.toBeInstanceOf(LndRpcError);
    });

    it("fails while no HTLC is held yet", async () => {
      await expect(adapter.settleInvoice(PREIMAGE)).rejects.toThrow();
      expect(sim.requireInvoice(PAYMENT_HASH).state).toBe("OPEN");
    });

    it("fails for a preimage that matches no invoice", async () => {
      await expect(adapter.settleInvoice(newPreimage().preimage)).rejects.toThrow();
    });

    it("reports a transport failure as LndUnavailableError so the caller retries", async () => {
      sim.rpc.settleHodlInvoice.mockRejectedValueOnce(unavailable("UnexpectedErrorWhenSettlingHodlInvoice"));
      await expect(adapter.settleInvoice(PREIMAGE)).rejects.toBeInstanceOf(LndUnavailableError);
    });

    it("sends the preimage as lowercase hex and refuses a value that is not 32 bytes", async () => {
      sim.acceptHtlcs(PAYMENT_HASH, [652]);
      await adapter.settleInvoice(PREIMAGE.toUpperCase());
      expect(sim.rpc.settleHodlInvoice).toHaveBeenLastCalledWith({ lnd: sim.lnd, secret: PREIMAGE });
      await expect(adapter.settleInvoice("abcd")).rejects.toThrow();
      expect(sim.rpc.settleHodlInvoice).toHaveBeenCalledTimes(1);
    });
  });

  describe("cancelInvoice", () => {
    beforeEach(async () => {
      await adapter.createHoldInvoice({ paymentHash: PAYMENT_HASH, amountSats: 25_000n, expirySeconds: 180, cltvExpiry: 144, memo: "swap" });
    });

    it("cancels an open invoice", async () => {
      await adapter.cancelInvoice(PAYMENT_HASH);
      expect(sim.rpc.cancelHodlInvoice).toHaveBeenCalledWith({ lnd: sim.lnd, id: PAYMENT_HASH });
      expect(sim.requireInvoice(PAYMENT_HASH).state).toBe("CANCELED");
    });

    it("cancels an accepted invoice (the refund)", async () => {
      sim.acceptHtlcs(PAYMENT_HASH, [652]);
      await adapter.cancelInvoice(PAYMENT_HASH);
      expect(sim.requireInvoice(PAYMENT_HASH).state).toBe("CANCELED");
    });

    it("is idempotent: cancelling a cancelled invoice again succeeds", async () => {
      await adapter.cancelInvoice(PAYMENT_HASH);
      await expect(adapter.cancelInvoice(PAYMENT_HASH)).resolves.toBeUndefined();
    });

    it("treats LND's 'invoice already canceled' answer as success", async () => {
      sim.rpc.cancelHodlInvoice.mockRejectedValueOnce(libError("UnexpectedErrorCancelingHodlInvoice", GRPC_CODE.UNKNOWN, LND_DETAILS.ALREADY_CANCELED));
      await expect(adapter.cancelInvoice(PAYMENT_HASH)).resolves.toBeUndefined();
    });

    it("fails for a settled invoice: a settled swap is never reported as refunded", async () => {
      sim.acceptHtlcs(PAYMENT_HASH, [652]);
      await adapter.settleInvoice(PREIMAGE);
      await expect(adapter.cancelInvoice(PAYMENT_HASH)).rejects.toBeInstanceOf(LndRpcError);
      expect(sim.requireInvoice(PAYMENT_HASH).state).toBe("SETTLED");
    });

    it("fails for an unknown hash", async () => {
      await expect(adapter.cancelInvoice(newPreimage().hash)).rejects.toThrow();
    });

    it("reports a transport failure as LndUnavailableError", async () => {
      sim.rpc.cancelHodlInvoice.mockRejectedValueOnce(unavailable("UnexpectedErrorCancelingHodlInvoice"));
      await expect(adapter.cancelInvoice(PAYMENT_HASH)).rejects.toBeInstanceOf(LndUnavailableError);
    });
  });

  /* ------------------------------------------------------------------------------------------- getPayment */

  describe("getPayment", () => {
    it("returns null when this node never tried to pay the hash (SentPaymentNotFound)", async () => {
      await expect(adapter.getPayment(PAYMENT_HASH)).resolves.toBeNull();
      expect(sim.rpc.getPayment).toHaveBeenCalledWith({ lnd: sim.lnd, id: PAYMENT_HASH });
    });

    it("returns null on a gRPC NOT_FOUND answer", async () => {
      sim.rpc.getPayment.mockRejectedValueOnce(libError("UnexpectedGetPaymentError", GRPC_CODE.NOT_FOUND, "not found"));
      await expect(adapter.getPayment(PAYMENT_HASH)).resolves.toBeNull();
    });

    it("maps a pending payment to IN_FLIGHT", async () => {
      sim.setPayment(PAYMENT_HASH, pendingPaymentResult(PAYMENT_HASH));
      await expect(adapter.getPayment(PAYMENT_HASH)).resolves.toEqual({
        paymentHash: PAYMENT_HASH,
        state: "IN_FLIGHT",
        preimage: null,
        feeMsat: 0n,
        failureReason: null,
      });
    });

    it("maps a settled payment to SUCCEEDED with the preimage and the fee in msat", async () => {
      sim.setPayment(PAYMENT_HASH, confirmedPaymentResult(PAYMENT_HASH, PREIMAGE.toUpperCase(), "1234"));
      await expect(adapter.getPayment(PAYMENT_HASH)).resolves.toEqual({
        paymentHash: PAYMENT_HASH,
        state: "SUCCEEDED",
        preimage: PREIMAGE,
        feeMsat: 1_234n,
        failureReason: null,
      });
    });

    it.each([
      ["is_invalid_payment", LND_PAYMENT_FAILURE_REASON.INCORRECT_PAYMENT_DETAILS],
      ["is_insufficient_balance", LND_PAYMENT_FAILURE_REASON.INSUFFICIENT_BALANCE],
      ["is_route_not_found", LND_PAYMENT_FAILURE_REASON.NO_ROUTE],
      ["is_pathfinding_timeout", LND_PAYMENT_FAILURE_REASON.TIMEOUT],
      ["is_canceled", LND_PAYMENT_FAILURE_REASON.CANCELED],
    ])("maps a failed payment with %s to FAILED %s", async (flag, reason) => {
      sim.setPayment(PAYMENT_HASH, failedPaymentResult({ [flag]: true }));
      await expect(adapter.getPayment(PAYMENT_HASH)).resolves.toEqual({
        paymentHash: PAYMENT_HASH,
        state: "FAILED",
        preimage: null,
        feeMsat: 0n,
        failureReason: reason,
      });
    });

    it("maps a failure without a known flag to FAILURE_REASON_ERROR", async () => {
      sim.setPayment(PAYMENT_HASH, failedPaymentResult());
      await expect(adapter.getPayment(PAYMENT_HASH)).resolves.toMatchObject({ state: "FAILED", failureReason: LND_PAYMENT_FAILURE_REASON.ERROR });
    });

    it("reports a transport failure as LndUnavailableError, never as 'no payment'", async () => {
      sim.rpc.getPayment.mockRejectedValueOnce(unavailable("UnexpectedGetPaymentError"));
      await expect(adapter.getPayment(PAYMENT_HASH)).rejects.toBeInstanceOf(LndUnavailableError);
    });

    it("reports the package's UnknownStatusOfPayment as an error, never as 'no payment'", async () => {
      sim.rpc.getPayment.mockRejectedValueOnce(libOnlyError("UnknownStatusOfPayment"));
      await expect(adapter.getPayment(PAYMENT_HASH)).rejects.toBeInstanceOf(LndRpcError);
    });

    it("asks LND with the hash as lowercase hex", async () => {
      await adapter.getPayment(PAYMENT_HASH.toUpperCase());
      expect(sim.rpc.getPayment).toHaveBeenCalledWith({ lnd: sim.lnd, id: PAYMENT_HASH });
    });
  });

  /* ------------------------------------------------------------------------------------------ getBalances */

  describe("getBalances", () => {
    it("adds channel local, channel remote (inbound) and on-chain balances as bigint sats", async () => {
      await expect(adapter.getBalances()).resolves.toEqual({ channelLocalSats: 700_000n, channelRemoteSats: 300_000n, onchainSats: 50_000n });
    });

    it("reports zero remote balance when LND leaves `inbound` out", async () => {
      sim.inboundSats = undefined;
      await expect(adapter.getBalances()).resolves.toMatchObject({ channelRemoteSats: 0n });
    });

    it("counts on-chain funds as zero, warns once and stops asking when the macaroon lacks onchain:read", async () => {
      const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
      sim.rpc.getChainBalance.mockRejectedValue(libError("UnexpectedGetChainBalanceError", GRPC_CODE.PERMISSION_DENIED, LND_DETAILS.PERMISSION));

      await expect(adapter.getBalances()).resolves.toEqual({ channelLocalSats: 700_000n, channelRemoteSats: 300_000n, onchainSats: 0n });
      await expect(adapter.getBalances()).resolves.toMatchObject({ onchainSats: 0n });

      expect(sim.rpc.getChainBalance).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it("does not hide a transport failure of the on-chain balance as zero", async () => {
      sim.rpc.getChainBalance.mockRejectedValueOnce(unavailable("UnexpectedGetChainBalanceError"));
      await expect(adapter.getBalances()).rejects.toBeInstanceOf(LndUnavailableError);
      await expect(adapter.getBalances()).resolves.toMatchObject({ onchainSats: 50_000n });
    });

    it("fails when the channel balance cannot be read", async () => {
      sim.rpc.getChannelBalance.mockRejectedValueOnce(unavailable("UnexpectedGetChannelBalanceError"));
      await expect(adapter.getBalances()).rejects.toBeInstanceOf(LndUnavailableError);
    });
  });

  /* ------------------------------------------------------------------------------------------------ close */

  describe("close", () => {
    it("closes every gRPC service of the node", () => {
      adapter.close();
      for (const service of Object.values(sim.services)) expect(service.close).toHaveBeenCalled();
    });

    it("stops the invoice stream and stops notifying listeners", () => {
      const listener = jest.fn();
      adapter.onUpdate(listener);
      const stream = sim.invoiceStreams[0]!;

      adapter.close();
      stream.emit("invoice_updated", { id: PAYMENT_HASH });

      expect(stream.listenerCount("invoice_updated")).toBe(0);
      expect(listener).not.toHaveBeenCalled();
    });
  });
});
