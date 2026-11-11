import { randomBytes } from "node:crypto";
import { sha256Hex } from "../../../src/common/utils/hex.util";
import type { BtcNetwork, Hex32 } from "../../../src/domain/types";
import type { LndAdapterSettings } from "../../../src/infrastructure/lightning/lnd-lightning.adapter";

/**
 * Shared data for the LND adapter tests: hashes, node keys, real BOLT11 invoices and the error shapes the `lightning`
 * package (13.1.7) and @grpc/grpc-js produce.
 */

export const PREIMAGE: Hex32 = "11".repeat(32);
export const PAYMENT_HASH: Hex32 = sha256Hex(PREIMAGE);
export const HUB_PUBKEY = `02${"ab".repeat(32)}`;
export const START_HEIGHT = 500;
export const LND_VERSION = "0.21.4-beta commit=v0.21.4-beta";
export const REGTEST_SETTINGS: LndAdapterSettings = { network: "regtest", name: "hub-lnd:10009", maxPaymentParts: 16, invoiceRouteHints: false };

/** gRPC status codes as @grpc/grpc-js reports them (grpc/doc/statuscodes.md). */
export const GRPC_CODE = {
  CANCELLED: 1,
  UNKNOWN: 2,
  DEADLINE_EXCEEDED: 4,
  NOT_FOUND: 5,
  PERMISSION_DENIED: 7,
  UNAVAILABLE: 14,
  UNAUTHENTICATED: 16,
} as const;

/** Error texts LND v0.21.4 puts in gRPC status details. */
export const LND_DETAILS = {
  INVOICE_NOT_FOUND: "unable to locate invoice",
  NO_INVOICES: "there are no existing invoices",
  ALREADY_SETTLED: "invoice already settled",
  ALREADY_CANCELED: "invoice already canceled",
  DUPLICATE: "invoice with payment hash already exists",
  WRONG_NETWORK: "invoice not for current active network 'regtest'",
  CONNECT_FAILED: "failed to connect to all addresses",
  DEADLINE: "Deadline exceeded",
  PERMISSION: "permission denied",
  PAYMENT_NOT_INITIATED: "payment isn't initiated",
  BAD_BECH32: "invalid index of 1",
} as const;

export interface GrpcError extends Error {
  code: number;
  details: string;
}

/** An error as @grpc/grpc-js hands it to a callback. */
export function grpcError(code: number, details: string): GrpcError {
  return Object.assign(new Error(`${code} ${details}`), { code, details });
}

/** The `[httpLikeCode, name, { err }]` array the `lightning` package rejects with when LND answered with an error. */
export const libError = (name: string, code: number, details: string, httpCode = 503): unknown[] => [httpCode, name, { err: grpcError(code, details) }];

/** A package error with no gRPC error inside (the package's own checks and mappings). */
export const libOnlyError = (name: string, httpCode = 503): unknown[] => [httpCode, name];

export function newPreimage(): { preimage: Hex32; hash: Hex32 } {
  const preimage = randomBytes(32).toString("hex");
  return { preimage, hash: sha256Hex(preimage) };
}

/** Lets every already-resolved promise chain run (the simulators answer immediately). */
export const flushPromises = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/* -------------------------------------------------------------------------------------------- real BOLT11 */

interface UnsignedRequest {
  hash: string;
  hrp: string;
  tags: number[];
}

interface InvoicesLib {
  createUnsignedRequest(args: Record<string, unknown>): UnsignedRequest;
  createSignedRequest(args: { destination: string; hrp: string; signature: string; tags: number[] }): { request: string };
}

interface Secp256k1 {
  pointFromScalar(secret: Uint8Array, compressed?: boolean): Uint8Array | null;
  sign(hash: Uint8Array, secret: Uint8Array): Uint8Array;
}

/* The BOLT11 tooling the `lightning` package itself depends on; loaded with require because it ships no typings. */
const invoicesLib = require("invoices") as InvoicesLib;
const secp256k1 = require("tiny-secp256k1") as Secp256k1;

const PAYEE_SECRET = Buffer.alloc(32, 7);
export const PAYEE_PUBKEY = Buffer.from(secp256k1.pointFromScalar(PAYEE_SECRET, true) ?? []).toString("hex");

/** Network names of the `invoices` package. */
const INVOICES_NETWORK: Record<Exclude<BtcNetwork, "testnet4">, string> = {
  regtest: "regtest",
  signet: "signet",
  testnet: "testnet",
  mainnet: "bitcoin",
};

export interface Bolt11Options {
  hash?: Hex32;
  network?: Exclude<BtcNetwork, "testnet4">;
  /** Omitted for an invoice without an amount. */
  mtokens?: string;
  cltvDelta?: number;
  description?: string;
  createdAtMs?: number;
  expirySeconds?: number;
}

/** A real, signed BOLT11 invoice: the `lightning` package parses requests itself before paying them. */
export function makeBolt11(options: Bolt11Options = {}): string {
  const createdAtMs = options.createdAtMs ?? Date.now();
  const unsigned = invoicesLib.createUnsignedRequest({
    cltv_delta: options.cltvDelta ?? 40,
    created_at: new Date(createdAtMs).toISOString(),
    description: options.description ?? "ckbolt payout",
    destination: PAYEE_PUBKEY,
    expires_at: new Date(createdAtMs + (options.expirySeconds ?? 3_600) * 1_000).toISOString(),
    features: [{ bit: 9 }, { bit: 15 }, { bit: 17 }],
    id: options.hash ?? PAYMENT_HASH,
    mtokens: options.mtokens,
    network: INVOICES_NETWORK[options.network ?? "regtest"],
    payment: "cd".repeat(32),
  });
  const signature = Buffer.from(secp256k1.sign(Buffer.from(unsigned.hash, "hex"), PAYEE_SECRET)).toString("hex");
  return invoicesLib.createSignedRequest({ destination: PAYEE_PUBKEY, hrp: unsigned.hrp, signature, tags: unsigned.tags }).request;
}
