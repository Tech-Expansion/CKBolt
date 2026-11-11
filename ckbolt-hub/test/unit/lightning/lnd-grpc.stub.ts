import { EventEmitter } from "node:events";
import type { AuthenticatedLnd } from "lightning";
import type { Hex32 } from "../../../src/domain/types";
import { HUB_PUBKEY, LND_VERSION, PAYEE_PUBKEY, START_HEIGHT, grpcError, type GrpcError } from "./lightning.fixtures";

/**
 * A wire-level stand-in for LND v0.21.4's gRPC services, as @grpc/grpc-js exposes them to the `lightning` package:
 * unary calls take `(request, callback)`, server streams are EventEmitters with `cancel()`. Messages use the proto
 * field names and the types grpc-js decodes them to (int64 as strings, bytes as Buffers). Tests drive the real
 * `lightning` package through it, so the adapter is checked against the package's actual parsing and errors.
 */

export class GrpcStream extends EventEmitter {
  readonly cancel = jest.fn();
}

type Callback = (error: GrpcError | null, response?: unknown) => void;
type UnaryHandler = (request: Record<string, unknown>) => unknown;

/** Turns a handler into a grpc-js unary method: a thrown GrpcError becomes the callback error. */
function unary(handler: UnaryHandler): jest.Mock {
  return jest.fn((request: Record<string, unknown>, callback: Callback) => {
    setImmediate(() => {
      try {
        callback(null, handler(request));
      } catch (error) {
        callback(error as GrpcError);
      }
    });
  });
}

const notImplemented = (rpc: string) => () => {
  throw grpcError(12, `${rpc} is not stubbed`);
};

export interface LndGrpcStub {
  lnd: AuthenticatedLnd;
  height: number;
  default: Record<"getInfo" | "decodePayReq" | "lookupInvoice" | "channelBalance" | "walletBalance" | "addInvoice" | "subscribeInvoices" | "close", jest.Mock>;
  invoices: Record<"addHoldInvoice" | "settleInvoice" | "cancelInvoice" | "close", jest.Mock>;
  router: Record<"sendPaymentV2" | "trackPaymentV2" | "close", jest.Mock>;
  chain: Record<"registerBlockEpochNtfn" | "close", jest.Mock>;
  sendStreams: GrpcStream[];
  trackStreams: GrpcStream[];
  /** What trackPaymentV2 streams do once opened; by default LND says the payment was never initiated. */
  onTrack: (stream: GrpcStream, request: Record<string, unknown>) => void;
  /** What a sendPaymentV2 stream does once opened. */
  onSend: (stream: GrpcStream, request: Record<string, unknown>) => void;
}

export function createGrpcStub(): LndGrpcStub {
  const stub: LndGrpcStub = {
    height: START_HEIGHT,
    sendStreams: [],
    trackStreams: [],
    onTrack: (stream) => stream.emit("error", grpcError(5, "payment isn't initiated")),
    onSend: () => undefined,
    default: {
      getInfo: unary(() => rawGetInfo(stub.height)),
      decodePayReq: unary(notImplemented("DecodePayReq")),
      lookupInvoice: unary(notImplemented("LookupInvoice")),
      channelBalance: unary(notImplemented("ChannelBalance")),
      walletBalance: unary(notImplemented("WalletBalance")),
      addInvoice: unary(notImplemented("AddInvoice")),
      subscribeInvoices: jest.fn(() => new GrpcStream()),
      close: jest.fn(),
    },
    invoices: {
      addHoldInvoice: unary(notImplemented("AddHoldInvoice")),
      settleInvoice: unary(() => ({})),
      cancelInvoice: unary(() => ({})),
      close: jest.fn(),
    },
    router: {
      sendPaymentV2: jest.fn((request: Record<string, unknown>) => {
        const stream = new GrpcStream();
        stub.sendStreams.push(stream);
        setImmediate(() => stub.onSend(stream, request));
        return stream;
      }),
      trackPaymentV2: jest.fn((request: Record<string, unknown>) => {
        const stream = new GrpcStream();
        stub.trackStreams.push(stream);
        setImmediate(() => stub.onTrack(stream, request));
        return stream;
      }),
      close: jest.fn(),
    },
    chain: {
      registerBlockEpochNtfn: jest.fn(() => {
        const stream = new GrpcStream();
        setImmediate(() => stream.emit("data", { hash: Buffer.alloc(32, 1), height: stub.height }));
        return stream;
      }),
      close: jest.fn(),
    },
    lnd: undefined as unknown as AuthenticatedLnd,
  };
  stub.lnd = { default: stub.default, invoices: stub.invoices, router: stub.router, chain: stub.chain } as unknown as AuthenticatedLnd;
  return stub;
}

/** Replaces a unary method's answer. */
export const answer = (method: jest.Mock, handler: UnaryHandler): void => {
  method.mockImplementation((request: Record<string, unknown>, callback: Callback) => {
    setImmediate(() => {
      try {
        callback(null, handler(request));
      } catch (error) {
        callback(error as GrpcError);
      }
    });
  });
};

/** Makes a unary method fail with a gRPC error. */
export const fail = (method: jest.Mock, code: number, details: string): void => {
  answer(method, () => {
    throw grpcError(code, details);
  });
};

/* -------------------------------------------------------------------------------------------- raw messages */

const UNIX_NOW = "1761220800";
const CHANNEL_ID = "123456789012345";

export const rawGetInfo = (height: number): Record<string, unknown> => ({
  alias: "hub",
  best_header_timestamp: UNIX_NOW,
  block_hash: "00".repeat(32),
  block_height: height,
  chains: [{ chain: "bitcoin", network: "regtest" }],
  color: "#3399ff",
  features: {},
  identity_pubkey: HUB_PUBKEY,
  num_active_channels: 1,
  num_peers: 1,
  num_pending_channels: 0,
  synced_to_chain: true,
  uris: [],
  version: LND_VERSION,
});

export const rawPayReq = (args: { hash: Hex32; msat: bigint; cltv: number; timestamp: number; expiry: number; description: string }): Record<string, unknown> => ({
  destination: PAYEE_PUBKEY,
  payment_hash: args.hash,
  num_satoshis: (args.msat / 1_000n).toString(),
  num_msat: args.msat.toString(),
  timestamp: String(args.timestamp),
  expiry: String(args.expiry),
  description: args.description,
  description_hash: "",
  fallback_addr: "",
  cltv_expiry: String(args.cltv),
  route_hints: [],
  payment_addr: Buffer.alloc(32, 0xcd),
  features: {},
});

export const rawHtlc = (state: "ACCEPTED" | "SETTLED" | "CANCELED", expiryHeight: number, amtMsat: string): Record<string, unknown> => ({
  accept_height: START_HEIGHT,
  accept_time: UNIX_NOW,
  amt_msat: amtMsat,
  chan_id: CHANNEL_ID,
  custom_records: {},
  expiry_height: expiryHeight,
  htlc_index: "1",
  mpp_total_amt_msat: amtMsat,
  resolve_time: "0",
  state,
});

export const rawInvoice = (args: {
  hash: Hex32;
  state: "OPEN" | "ACCEPTED" | "SETTLED" | "CANCELED";
  valueMsat: string;
  amtPaidMsat: string;
  htlcs?: Record<string, unknown>[];
}): Record<string, unknown> => ({
  add_index: "1",
  amt_paid_msat: args.amtPaidMsat,
  amt_paid_sat: (BigInt(args.amtPaidMsat) / 1_000n).toString(),
  cltv_expiry: "144",
  creation_date: UNIX_NOW,
  description_hash: Buffer.alloc(0),
  expiry: "180",
  features: {},
  htlcs: args.htlcs ?? [],
  is_amp: false,
  is_keysend: false,
  memo: "swap",
  payment_addr: Buffer.alloc(32, 2),
  payment_request: "lnbcrt250u1phold",
  private: false,
  r_hash: Buffer.from(args.hash, "hex"),
  r_preimage: Buffer.alloc(0),
  settle_date: "0",
  settle_index: "0",
  state: args.state,
  value: (BigInt(args.valueMsat) / 1_000n).toString(),
  value_msat: args.valueMsat,
});

const rawAttempt = (status: "IN_FLIGHT" | "SUCCEEDED" | "FAILED", feeMsat: string): Record<string, unknown> => ({
  attempt_time_ns: "1761220800000000000",
  resolve_time_ns: "1761220801000000000",
  status,
  route: {
    hops: [{ amt_to_forward_msat: "250000", chan_id: CHANNEL_ID, fee_msat: feeMsat, pub_key: PAYEE_PUBKEY, tlv_payload: true, expiry: 700 }],
    total_amt_msat: (250_000n + BigInt(feeMsat)).toString(),
    total_fees_msat: feeMsat,
    total_time_lock: 700,
  },
});

/** An lnrpc.Payment as SendPaymentV2 and TrackPaymentV2 stream it. */
export function rawPayment(
  hash: Hex32,
  status: "IN_FLIGHT" | "SUCCEEDED" | "FAILED",
  options: { preimage?: Hex32; feeMsat?: string; failureReason?: string } = {},
): Record<string, unknown> {
  const feeMsat = options.feeMsat ?? "1500";
  const attempts: Record<"IN_FLIGHT" | "SUCCEEDED" | "FAILED", Record<string, unknown>[]> = {
    IN_FLIGHT: [rawAttempt("IN_FLIGHT", feeMsat)],
    SUCCEEDED: [rawAttempt("SUCCEEDED", feeMsat)],
    FAILED: [],
  };
  return {
    creation_time_ns: "1761220800000000000",
    failure_reason: options.failureReason ?? "FAILURE_REASON_NONE",
    fee_msat: status === "FAILED" ? "0" : feeMsat,
    htlcs: attempts[status],
    payment_hash: hash,
    payment_index: "1",
    payment_preimage: options.preimage ?? "00".repeat(32),
    payment_request: "",
    status,
    value_msat: "250000",
    value_sat: "250",
  };
}
