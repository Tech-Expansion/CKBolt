import { EventEmitter } from "node:events";
import type { AuthenticatedLnd } from "lightning";
import type { Clock } from "../../../src/application/ports/clock.port";
import { MSAT_PER_SAT } from "../../../src/common/constants/protocol.constants";
import { sha256Hex } from "../../../src/common/utils/hex.util";
import type { BtcNetwork, Hex32 } from "../../../src/domain/types";
import { LndLightningAdapter, type LndAdapterSettings } from "../../../src/infrastructure/lightning/lnd-lightning.adapter";
import type { LndRpc } from "../../../src/infrastructure/lightning/lnd.rpc";
import { FakeClock } from "../../fakes";
import { GRPC_CODE, HUB_PUBKEY, LND_DETAILS, LND_VERSION, REGTEST_SETTINGS, START_HEIGHT, libError, libOnlyError, newPreimage } from "./lightning.fixtures";

/**
 * A stand-in for the `lightning` package (13.1.7) on one LND v0.21.4 node, at the level the adapter calls it (lnd.rpc.ts):
 * same argument names, same result fields, and errors in the package's `[code, name, { err }]` shape with LND's gRPC
 * status details. Invoices keep LND's hold-invoice states; payment streams are EventEmitters the tests drive.
 */

type InvoiceState = "OPEN" | "ACCEPTED" | "SETTLED" | "CANCELED";

export interface SimHtlc {
  timeout: number;
  mtokens: string;
  is_held: boolean;
  is_canceled: boolean;
  is_confirmed: boolean;
}

export interface SimInvoice {
  id: Hex32;
  request: string;
  tokens: number;
  mtokens: string;
  description: string;
  created_at: string;
  expires_at: string;
  cltv_delta: number;
  state: InvoiceState;
  received_mtokens: string;
  payments: SimHtlc[];
  secret: Hex32 | null;
}

/** What decodePaymentRequest resolves with (the package also returns `created_at`, which its typings omit). */
export interface DecodedRequest {
  id: string;
  mtokens: string;
  tokens: number;
  cltv_delta?: number;
  created_at: string;
  expires_at: string;
  destination: string;
  description: string;
  chain_address?: string;
  description_hash?: string;
  features: unknown[];
  routes: unknown[];
  safe_tokens: number;
}

export interface PayCall {
  args: Record<string, unknown>;
  stream: EventEmitter;
}

export interface PastPaymentCall {
  id: string;
  stream: EventEmitter;
}

export type FailureFlags = Partial<
  Record<"is_canceled" | "is_insufficient_balance" | "is_invalid_payment" | "is_pathfinding_timeout" | "is_route_not_found", boolean>
>;

const NO_FAILURE_FLAGS = {
  is_canceled: false,
  is_insufficient_balance: false,
  is_invalid_payment: false,
  is_pathfinding_timeout: false,
  is_route_not_found: false,
};

/* ------------------------------------------------------------------------------ payment results and events */

/** getPayment result of a payment still in flight. */
export const pendingPaymentResult = (id: string): Record<string, unknown> => ({
  is_confirmed: false,
  is_failed: false,
  is_pending: true,
  pending: { id, mtokens: "250000", paths: [], safe_tokens: 250, tokens: 250, destination: HUB_PUBKEY, created_at: new Date(0).toISOString() },
});

/** getPayment result of a settled payment. */
export const confirmedPaymentResult = (id: string, secret: string, feeMtokens = "1500"): Record<string, unknown> => ({
  is_confirmed: true,
  is_failed: false,
  is_pending: false,
  payment: { id, secret, fee_mtokens: feeMtokens, fee: Number(BigInt(feeMtokens) / MSAT_PER_SAT), mtokens: "251500", tokens: 251, hops: [], paths: [] },
});

/** getPayment result of a failed payment (getPayment's `failed` has no is_canceled flag in the typings, but sends it). */
export const failedPaymentResult = (flags: FailureFlags = {}): Record<string, unknown> => ({
  is_confirmed: false,
  is_failed: true,
  is_pending: false,
  failed: { ...NO_FAILURE_FLAGS, ...flags },
});

export const payingEvent = (id: string): Record<string, unknown> => ({ id, mtokens: "250000", paths: [], tokens: 250 });
export const confirmedEvent = (id: string, secret: string, feeMtokens = "1500"): Record<string, unknown> => ({
  id,
  secret,
  fee_mtokens: feeMtokens,
  fee: Number(BigInt(feeMtokens) / MSAT_PER_SAT),
  mtokens: "251500",
  tokens: 251,
  hops: [],
  paths: [],
});
export const failedEvent = (id: string, flags: FailureFlags = {}): Record<string, unknown> => ({ id, ...NO_FAILURE_FLAGS, ...flags });

/* ----------------------------------------------------------------------------------------------- simulator */

type RpcName = keyof LndRpc;
export type RpcMocks = Record<RpcName, jest.Mock>;

type ServiceName = "default" | "invoices" | "router" | "chain";

/** The `lightning` package's own chain id helper (bolt02/chain_id.js): the id getWalletInfo lists for a chain. */
const lightningChainId = require("lightning/bolt02/chain_id") as (args: { chain: string; network: string }) => { chain?: string };

/** The bitcoin chain ids getWalletInfo lists for a node on `network`, as the package writes them. */
const chainIdsOf = (network: BtcNetwork): string[] => {
  const { chain } = lightningChainId({ chain: "bitcoin", network });
  return chain === undefined ? [] : [chain];
};

export class LndPackageSimulator {
  /** The Bitcoin network the simulated LND runs on: getWalletInfo names its chain. */
  network: BtcNetwork = REGTEST_SETTINGS.network;
  height = START_HEIGHT;
  synced = true;
  channelBalanceSats = 700_000;
  inboundSats: number | undefined = 300_000;
  chainBalanceSats = 50_000;
  readonly invoices = new Map<Hex32, SimInvoice>();
  readonly decodable = new Map<string, DecodedRequest>();
  readonly payments = new Map<string, Record<string, unknown>>();
  readonly payCalls: PayCall[] = [];
  readonly pastPaymentCalls: PastPaymentCall[] = [];
  readonly invoiceStreams: EventEmitter[] = [];
  /** Runs on the next tick after a payment stream opens, as the package emits asynchronously. */
  onPay: ((stream: EventEmitter, args: Record<string, unknown>) => void) | null = null;
  /** Runs on the next tick after a past-payment stream opens. */
  onPastPayment: ((stream: EventEmitter, id: string) => void) | null = null;
  readonly services: Record<ServiceName, { close: jest.Mock }>;
  readonly lnd: AuthenticatedLnd;
  readonly rpc: RpcMocks;
  private requestCount = 0;

  constructor() {
    this.services = {
      default: { close: jest.fn() },
      invoices: { close: jest.fn() },
      router: { close: jest.fn() },
      chain: { close: jest.fn() },
    };
    this.lnd = this.services as unknown as AuthenticatedLnd;
    this.rpc = {
      getWalletInfo: jest.fn(async () => this.walletInfo()),
      decodePaymentRequest: jest.fn(async ({ request }: { request: string }) => this.decode(request)),
      createHodlInvoice: jest.fn(async (args: HoldInvoiceArgs) => this.createHodl(args)),
      createInvoice: jest.fn(async (args: InvoiceArgs) => this.createRegular(args)),
      getInvoice: jest.fn(async ({ id }: { id: string }) => this.lookup(id)),
      settleHodlInvoice: jest.fn(async ({ secret }: { secret: string }) => this.settle(secret)),
      cancelHodlInvoice: jest.fn(async ({ id }: { id: string }) => this.cancel(id)),
      getPayment: jest.fn(async ({ id }: { id: string }) => this.payment(id)),
      subscribeToPayViaRequest: jest.fn((args: Record<string, unknown>) => this.openPayStream(args)),
      subscribeToPastPayment: jest.fn(({ id }: { id: string }) => this.openPastPaymentStream(id)),
      subscribeToInvoices: jest.fn(() => this.openInvoiceStream()),
      getChannelBalance: jest.fn(async () => ({ channel_balance: this.channelBalanceSats, inbound: this.inboundSats, pending_balance: 0 })),
      getChainBalance: jest.fn(async () => ({ chain_balance: this.chainBalanceSats })),
    };
  }

  asRpc(): LndRpc {
    return this.rpc as unknown as LndRpc;
  }

  /* ------------------------------------------------------------------------------------------ test helpers */

  /** An invoice of another node the hub can pay; decodePaymentRequest knows it. Returns the request. */
  addPayable(options: { hash: Hex32; mtokens?: string; cltvDelta?: number; prefix?: string; expiresAtMs?: number; description?: string }): string {
    const request = `${options.prefix ?? "lnbcrt"}2500n1psim${++this.requestCount}x${options.hash.slice(0, 12)}`;
    const mtokens = options.mtokens ?? "250000";
    this.decodable.set(request, {
      id: options.hash,
      mtokens,
      tokens: Number(BigInt(mtokens) / MSAT_PER_SAT),
      safe_tokens: Number(BigInt(mtokens) / MSAT_PER_SAT),
      cltv_delta: options.cltvDelta,
      created_at: new Date(Date.UTC(2026, 9, 23, 11, 55)).toISOString(),
      expires_at: new Date(options.expiresAtMs ?? Date.UTC(2026, 9, 23, 12, 55)).toISOString(),
      destination: `03${"cd".repeat(32)}`,
      description: options.description ?? "payout",
      features: [],
      routes: [],
    });
    return request;
  }

  /** HTLCs that pay the whole invoice arrive and are held: OPEN -> ACCEPTED. */
  acceptHtlcs(hash: Hex32, timeouts: number[]): void {
    const invoice = this.requireInvoice(hash);
    const share = BigInt(invoice.mtokens) / BigInt(timeouts.length);
    invoice.state = "ACCEPTED";
    invoice.payments = timeouts.map((timeout) => ({ timeout, mtokens: share.toString(), is_held: true, is_canceled: false, is_confirmed: false }));
    invoice.received_mtokens = invoice.mtokens;
    this.emitInvoiceUpdate(hash);
  }

  setPayment(id: string, result: Record<string, unknown>): void {
    this.payments.set(id, result);
  }

  lastPayCall(): PayCall {
    const call = this.payCalls.at(-1);
    if (!call) throw new Error("No payment stream was opened");
    return call;
  }

  emitInvoiceUpdate(id: string): void {
    for (const stream of this.invoiceStreams) stream.emit("invoice_updated", { id, is_confirmed: false });
  }

  requireInvoice(hash: string): SimInvoice {
    const invoice = this.invoices.get(hash);
    if (!invoice) throw new Error(`No simulated invoice ${hash}`);
    return invoice;
  }

  /* ------------------------------------------------------------------------------------ package behaviour */

  private walletInfo() {
    return {
      public_key: HUB_PUBKEY,
      current_block_height: this.height,
      current_block_hash: "00".repeat(32),
      is_synced_to_chain: this.synced,
      version: LND_VERSION,
      alias: "hub",
      chains: chainIdsOf(this.network),
      color: "#3399ff",
      features: [],
      active_channels_count: 1,
      peers_count: 1,
      pending_channels_count: 0,
      latest_block_at: new Date(0).toISOString(),
    };
  }

  private decode(request: string): DecodedRequest {
    const decoded = this.decodable.get(request);
    if (!decoded) throw libError("UnexpectedDecodePaymentRequestError", GRPC_CODE.UNKNOWN, LND_DETAILS.BAD_BECH32);
    return decoded;
  }

  private register(id: Hex32, tokens: number, args: { expires_at: string; description: string; cltv_delta?: number }, secret: Hex32 | null): SimInvoice {
    const request = `lnbcrt${tokens}n1psimhold${++this.requestCount}x${id.slice(0, 12)}`;
    const invoice: SimInvoice = {
      id,
      request,
      tokens,
      mtokens: (BigInt(tokens) * MSAT_PER_SAT).toString(),
      description: args.description,
      created_at: new Date(Date.UTC(2026, 9, 23, 12)).toISOString(),
      expires_at: args.expires_at,
      cltv_delta: args.cltv_delta ?? 80,
      state: "OPEN",
      received_mtokens: "0",
      payments: [],
      secret,
    };
    this.invoices.set(id, invoice);
    return invoice;
  }

  private createHodl(args: HoldInvoiceArgs) {
    if (this.invoices.has(args.id)) throw libError("UnexpectedAddHodlInvoiceError", GRPC_CODE.UNKNOWN, LND_DETAILS.DUPLICATE);
    const invoice = this.register(args.id, args.tokens, args, null);
    return { created_at: invoice.created_at, description: args.description, id: args.id, mtokens: args.tokens * 1_000, request: invoice.request, tokens: args.tokens };
  }

  private createRegular(args: InvoiceArgs) {
    const { preimage, hash } = newPreimage();
    const invoice = this.register(hash, args.tokens, args, preimage);
    return { created_at: invoice.created_at, description: args.description, id: hash, mtokens: invoice.mtokens, request: invoice.request, secret: preimage, tokens: args.tokens };
  }

  private lookup(id: string) {
    const invoice = this.invoices.get(id);
    if (!invoice) throw libError("UnexpectedLookupInvoiceErr", GRPC_CODE.NOT_FOUND, LND_DETAILS.INVOICE_NOT_FOUND);
    return {
      id: invoice.id,
      request: invoice.request,
      description: invoice.description,
      created_at: invoice.created_at,
      expires_at: invoice.expires_at,
      cltv_delta: invoice.cltv_delta,
      tokens: invoice.tokens,
      mtokens: invoice.mtokens,
      received: Number(BigInt(invoice.received_mtokens) / MSAT_PER_SAT),
      received_mtokens: invoice.received_mtokens,
      is_confirmed: invoice.state === "SETTLED",
      is_held: invoice.state === "ACCEPTED" || undefined,
      is_canceled: invoice.state === "CANCELED" || undefined,
      payments: invoice.payments.map((htlc) => ({ ...htlc })),
      secret: invoice.secret ?? "00".repeat(32),
      features: [],
      index: 1,
      is_private: false,
    };
  }

  private settle(secret: string): void {
    const invoice = this.invoices.get(sha256Hex(secret));
    if (!invoice) throw libOnlyError("SecretDoesNotMatchAnyExistingHodlInvoice", 404);
    if (invoice.state === "SETTLED") return;
    if (invoice.state === "CANCELED") throw libError("UnexpectedErrorWhenSettlingHodlInvoice", GRPC_CODE.UNKNOWN, LND_DETAILS.ALREADY_CANCELED);
    if (invoice.state === "OPEN") throw libOnlyError("CannotSettleHtlcBeforeHtlcReceived", 402);
    invoice.state = "SETTLED";
    invoice.secret = secret;
    invoice.payments = invoice.payments.map((htlc) => ({ ...htlc, is_held: false, is_confirmed: true }));
    this.emitInvoiceUpdate(invoice.id);
  }

  private cancel(id: string): void {
    const invoice = this.invoices.get(id);
    if (!invoice) throw libError("UnexpectedErrorCancelingHodlInvoice", GRPC_CODE.UNKNOWN, LND_DETAILS.INVOICE_NOT_FOUND);
    if (invoice.state === "SETTLED") throw libError("UnexpectedErrorCancelingHodlInvoice", GRPC_CODE.UNKNOWN, LND_DETAILS.ALREADY_SETTLED);
    if (invoice.state === "CANCELED") return;
    invoice.state = "CANCELED";
    invoice.payments = invoice.payments.map((htlc) => ({ ...htlc, is_held: false, is_canceled: true }));
    this.emitInvoiceUpdate(id);
  }

  private payment(id: string): Record<string, unknown> {
    const payment = this.payments.get(id);
    if (!payment) throw libOnlyError("SentPaymentNotFound", 404);
    return payment;
  }

  private openPayStream(args: Record<string, unknown>): EventEmitter {
    const stream = new EventEmitter();
    this.payCalls.push({ args, stream });
    const script = this.onPay;
    if (script) setImmediate(() => script(stream, args));
    return stream;
  }

  private openPastPaymentStream(id: string): EventEmitter {
    const stream = new EventEmitter();
    this.pastPaymentCalls.push({ id, stream });
    const script = this.onPastPayment;
    if (script) setImmediate(() => script(stream, id));
    return stream;
  }

  private openInvoiceStream(): EventEmitter {
    const stream = new EventEmitter();
    this.invoiceStreams.push(stream);
    return stream;
  }
}

interface HoldInvoiceArgs {
  id: Hex32;
  tokens: number;
  expires_at: string;
  cltv_delta: number;
  description: string;
}

interface InvoiceArgs {
  tokens: number;
  expires_at: string;
  description: string;
}

/** The adapter under test, wired to a simulator. */
export function createAdapter(
  sim: LndPackageSimulator,
  options: { clock?: Clock; settings?: LndAdapterSettings } = {},
): LndLightningAdapter {
  return new LndLightningAdapter(sim.lnd, options.settings ?? REGTEST_SETTINGS, options.clock ?? new FakeClock(), sim.asRpc());
}
