import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { FIBER_MIN_FINAL_EXPIRY_DELTA_MS, FIBER_MAX_TLC_EXPIRY_LIMIT_MS } from "../../../src/common/constants/protocol.constants";
import { sha256Hex } from "../../../src/common/utils/hex.util";
import { sameAssetScript } from "../../../src/common/utils/script.util";
import type { Hex32, Script } from "../../../src/domain/types";
import type { HttpPost } from "../../../src/infrastructure/fiber/fiber-rpc.client";
import { FakeClock } from "../../fakes";
import { CHAIN_HASH_BY_CURRENCY, encodeMoleculeScript, hex, NODE_PUBKEY, wireChannel, wireNodeInfo } from "./fiber.fixtures";

/**
 * A wire-level stand-in for one fnn v0.9.1 node: JSON-RPC 2.0 text in, text out. It keeps the behaviour the hub relies
 * on (docs/research/fiber-node.md 2.0-2.3, 7.1) and is strict about the wire format: params must be a one-object
 * array (or [] for no params), quantities must be 0x hex strings, hashes 0x hex.
 */

const CALL_EXECUTION_FAILED = -32000;
const INVALID_PARAMS = -32602;
const METHOD_NOT_FOUND = -32601;
const DEFAULT_MAX_FEE_RATE_PER_MILLE = 5n;
const FEE_RATE_DENOMINATOR = 1_000n;

const HEX_QUANTITY = /^0x[0-9a-fA-F]+$/;
const HASH256 = /^(0x)?[0-9a-fA-F]{64}$/;

type InvoiceStatus = "Open" | "Received" | "Paid" | "Cancelled";
type PaymentStatus = "Created" | "Inflight" | "Success" | "Failed";
type HashAlgorithm = "sha256" | "ckb_hash";

interface SimInvoice {
  address: string;
  hash: Hex32;
  wire: Record<string, unknown>;
  amount: bigint | null;
  status: InvoiceStatus;
  hold: boolean;
  preimage: Hex32 | null;
  createdAt: number;
  expiresAt: number | null;
  finalExpiryDeltaMs: number;
  hashAlgorithm: HashAlgorithm;
  /** The invoice's asset: a UDT type script, null for CKB. */
  udt: Script | null;
  /** false for invoices of other nodes the hub may pay. */
  owned: boolean;
}

export interface SimPayment {
  hash: Hex32;
  status: PaymentStatus;
  preimage: Hex32 | null;
  fee: bigint;
  failedError: string | null;
  /** What fnn would really allow: min(max_fee_amount, amount x max_fee_rate / 1000). */
  effectiveMaxFee: bigint | null;
  params: Record<string, unknown>;
}

class SimRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const fail = (message: string): never => {
  throw new SimRpcError(CALL_EXECUTION_FAILED, message);
};
const invalidParams = (what: string): never => {
  throw new SimRpcError(INVALID_PARAMS, `Invalid params: ${what}`);
};

/** A stand-in for ckb_hash (blake2b-256 with a personalisation): anything that is not sha256 will do here. */
const ckbHash = (preimage: Hex32): Hex32 => createHash("blake2b512").update(Buffer.from(preimage, "hex")).digest("hex").slice(0, 64);
const hashWith = (algorithm: HashAlgorithm, preimage: Hex32): Hex32 => (algorithm === "sha256" ? sha256Hex(preimage) : ckbHash(preimage));

export interface ExternalInvoiceOptions {
  preimage: Hex32;
  amount?: bigint | null;
  currency?: string;
  hashAlgorithm?: HashAlgorithm;
  udt?: Script | null;
  expirySeconds?: number | null;
  finalExpiryDeltaMs?: number;
}

export class FnnSimulator {
  readonly requests: { id: unknown; method: string; params: unknown }[] = [];
  readonly invoices = new Map<Hex32, SimInvoice>();
  readonly payments = new Map<Hex32, SimPayment>();
  channels: Record<string, unknown>[] = [wireChannel()];
  /** fnn's text for a second invoice on one hash. */
  duplicateInvoiceMessage = "Duplicated invoice found";
  /** settle_invoice returns before the TLC is removed; false keeps the invoice Received with the preimage stored. */
  settleCompletesAtOnce = true;
  private readonly forcedErrors = new Map<string, { code: number; message: string }[]>();
  private readonly addresses = new Map<string, Hex32>();
  private nextTlcId = 0;

  constructor(
    readonly currency: "Fibb" | "Fibt" | "Fibd" = "Fibd",
    readonly clock = new FakeClock(),
    readonly pubkey = NODE_PUBKEY,
  ) {}

  /** HttpPost for FiberRpcClient: every POST is answered by this node, as fnn does (HTTP 200 for JSON-RPC errors too). */
  readonly httpPost: HttpPost = async (_url, init) => {
    const text = this.handle(init.body);
    return { ok: true, status: 200, text: async () => text };
  };

  methods(): string[] {
    return this.requests.map((request) => request.method);
  }

  countOf(method: string): number {
    return this.requests.filter((request) => request.method === method).length;
  }

  lastParams(method: string): Record<string, unknown> {
    const found = [...this.requests].reverse().find((request) => request.method === method);
    if (!found) throw new Error(`no ${method} request`);
    return (found.params as Record<string, unknown>[])[0] ?? {};
  }

  failNext(method: string, message: string, code = CALL_EXECUTION_FAILED): void {
    this.forcedErrors.set(method, [...(this.forcedErrors.get(method) ?? []), { code, message }]);
  }

  /* ------------------------------------------------------------------------------------- Test controls */

  /** An invoice of another node, so the hub can parse and pay it. */
  registerExternalInvoice(options: ExternalInvoiceOptions): { address: string; hash: Hex32 } {
    const algorithm = options.hashAlgorithm ?? "sha256";
    const invoice = this.storeInvoice({
      hash: hashWith(algorithm, options.preimage),
      preimage: options.preimage,
      amount: options.amount === undefined ? 100_000_000n : options.amount,
      currency: options.currency ?? this.currency,
      hashAlgorithm: algorithm,
      udt: options.udt ?? null,
      expirySeconds: options.expirySeconds === undefined ? 3_600 : options.expirySeconds,
      finalExpiryDeltaMs: options.finalExpiryDeltaMs ?? FIBER_MIN_FINAL_EXPIRY_DELTA_MS,
      hold: false,
      owned: false,
      payee: `03${"ef".repeat(32)}`,
      description: "merchant",
    });
    return { address: invoice.address, hash: invoice.hash };
  }

  hashOf(address: string): Hex32 {
    const hash = this.addresses.get(address);
    if (!hash) throw new Error(`unknown invoice ${address}`);
    return hash;
  }

  /**
   * A payer's TLC arrives and fully pays a hold invoice: Received, TLC held (Inbound, Committed) on the first channel in
   * the invoice's asset (opened here when the node has none), or in `channelUdt` to play a TLC of another asset that
   * fnn has committed but not rejected yet.
   */
  receiveHoldPayment(hash: Hex32, options: { amount?: bigint; expiresAt?: number; channelUdt?: Script | null } = {}): void {
    const invoice = this.ownedInvoice(hash);
    if (invoice.status !== "Open") throw new Error(`cannot receive on a ${invoice.status} invoice`);
    invoice.status = "Received";
    const tlc = {
      id: hex(this.nextTlcId++),
      amount: hex(options.amount ?? invoice.amount ?? 0n),
      payment_hash: `0x${hash}`,
      expiry: hex(options.expiresAt ?? this.clock.now() + 10 * 60 * 60 * 1_000),
      forwarding_channel_id: null,
      forwarding_tlc_id: null,
      status: { Inbound: "Committed" },
    };
    const index = this.channelIndexIn(options.channelUdt === undefined ? invoice.udt : options.channelUdt);
    this.channels = this.channels.map((channel, at) =>
      at === index ? { ...channel, pending_tlcs: [...(channel.pending_tlcs as unknown[]), tlc] } : channel,
    );
  }

  /** The first channel funded in `udt` (null for CKB); a new ready one when the node has none in that asset. */
  private channelIndexIn(udt: Script | null): number {
    const index = this.channels.findIndex((channel) => sameAssetScript(wireScript(channel.funding_udt_type_script), udt));
    if (index >= 0) return index;
    const channelId = `0x${createHash("sha256").update(`channel ${this.channels.length}`).digest("hex")}`;
    const udtScript = udt === null ? null : { code_hash: udt.codeHash, hash_type: udt.hashType, args: udt.args };
    this.channels = [...this.channels, wireChannel({ channelId, udtScript })];
    return this.channels.length - 1;
  }

  /** fnn fails a held TLC near its expiry but leaves the invoice Received (research 2.1 gotcha). */
  timeOutHeldTlc(hash: Hex32): void {
    this.removeTlcs(hash);
  }

  /** The fulfilling RemoveTlc applied: Paid. */
  completeSettlement(hash: Hex32): void {
    const invoice = this.ownedInvoice(hash);
    invoice.status = "Paid";
    this.removeTlcs(hash);
  }

  setPayment(hash: Hex32, patch: Partial<Omit<SimPayment, "hash">>): void {
    const payment = this.payments.get(hash);
    if (!payment) throw new Error(`no payment ${hash}`);
    Object.assign(payment, patch);
  }

  /* ------------------------------------------------------------------------------------- JSON-RPC */

  handle(body: string): string {
    const request = JSON.parse(body) as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
    const method = String(request.method);
    this.requests.push({ id: request.id, method, params: request.params });
    try {
      if (request.jsonrpc !== "2.0") invalidParams("jsonrpc must be 2.0");
      const forced = this.forcedErrors.get(method)?.shift();
      if (forced) throw new SimRpcError(forced.code, forced.message);
      const result = this.dispatch(method, request.params);
      return JSON.stringify({ jsonrpc: "2.0", id: request.id, result });
    } catch (error) {
      if (!(error instanceof SimRpcError)) throw error;
      return JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: error.code, message: error.message, data: request.params } });
    }
  }

  private dispatch(method: string, params: unknown): unknown {
    switch (method) {
      case "node_info":
        noParams(params);
        return wireNodeInfo(this.pubkey, CHAIN_HASH_BY_CURRENCY[this.currency]);
      case "new_invoice":
        return this.newInvoice(oneObject(params));
      case "parse_invoice":
        return { invoice: this.invoiceByAddress(stringField(oneObject(params), "invoice")).wire };
      case "get_invoice":
        return this.getInvoice(oneObject(params));
      case "settle_invoice":
        return this.settleInvoice(oneObject(params));
      case "cancel_invoice":
        return this.cancelInvoice(oneObject(params));
      case "send_payment":
        return this.sendPayment(oneObject(params));
      case "get_payment":
        return this.wirePayment(this.paymentFor(hashField(oneObject(params), "payment_hash")));
      case "list_channels":
        oneObject(params);
        return { channels: this.channels };
      default:
        throw new SimRpcError(METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  private newInvoice(p: Record<string, unknown>): unknown {
    const amount = quantityField(p, "amount", true) ?? 0n;
    const currency = stringField(p, "currency");
    if (currency !== this.currency) fail(`Currency must be ${this.currency} with the chain network`);
    if (p.payment_hash !== undefined && p.payment_preimage !== undefined) fail("Invalid parameter: BothPaymenthashAndPreimage");
    const algorithm = (p.hash_algorithm ?? "ckb_hash") as HashAlgorithm;
    if (algorithm !== "sha256" && algorithm !== "ckb_hash") invalidParams("hash_algorithm");
    const finalDelta = Number(quantityField(p, "final_expiry_delta", false) ?? BigInt(FIBER_MIN_FINAL_EXPIRY_DELTA_MS));
    if (finalDelta < FIBER_MIN_FINAL_EXPIRY_DELTA_MS || finalDelta > FIBER_MAX_TLC_EXPIRY_LIMIT_MS) {
      fail(`final_expiry_delta must be between ${FIBER_MIN_FINAL_EXPIRY_DELTA_MS} and ${FIBER_MAX_TLC_EXPIRY_LIMIT_MS}`);
    }
    const preimage = p.payment_preimage === undefined ? null : hashField(p, "payment_preimage");
    const hash = p.payment_hash !== undefined ? hashField(p, "payment_hash") : hashWith(algorithm, preimage ?? randomBytes(32).toString("hex"));
    if (this.invoices.has(hash)) fail(`${this.duplicateInvoiceMessage}: 0x${hash}`);
    const expiry = quantityField(p, "expiry", false);
    const invoice = this.storeInvoice({
      hash,
      preimage,
      amount,
      currency,
      hashAlgorithm: algorithm,
      udt: p.udt_type_script === undefined ? null : scriptField(p.udt_type_script),
      expirySeconds: expiry === null ? null : Number(expiry),
      finalExpiryDeltaMs: finalDelta,
      hold: p.payment_hash !== undefined,
      owned: true,
      payee: this.pubkey,
      description: typeof p.description === "string" ? p.description : null,
    });
    return { invoice_address: invoice.address, invoice: invoice.wire };
  }

  private getInvoice(p: Record<string, unknown>): unknown {
    const invoice = this.ownedInvoiceOrFail(hashField(p, "payment_hash"));
    return { invoice_address: invoice.address, invoice: invoice.wire, status: this.reportedStatus(invoice) };
  }

  /** research 2.1: hash check first, then status must be Received; returns before the TLC is removed. */
  private settleInvoice(p: Record<string, unknown>): unknown {
    const invoice = this.ownedInvoiceOrFail(hashField(p, "payment_hash"));
    const preimage = hashField(p, "payment_preimage");
    if (hashWith(invoice.hashAlgorithm, preimage) !== invoice.hash) fail("Hash mismatch");
    const status = this.reportedStatus(invoice);
    if (status === "Open") fail("Invoice is still open");
    if (status === "Expired") fail("Invoice is already expired");
    if (status === "Cancelled") fail("Invoice is already cancelled");
    if (status === "Paid") fail("Invoice is already paid");
    invoice.preimage = preimage;
    if (this.settleCompletesAtOnce) this.completeSettlement(invoice.hash);
    return null;
  }

  /** research 2.1: allowed on Open, Expired, and Received without a stored preimage. */
  private cancelInvoice(p: Record<string, unknown>): unknown {
    const invoice = this.ownedInvoiceOrFail(hashField(p, "payment_hash"));
    if (invoice.status === "Paid") fail("Invoice is already paid");
    if (invoice.status === "Cancelled") fail("Invoice is already cancelled");
    if (invoice.status === "Received" && invoice.preimage) fail("PaymentPreimageAlreadyExists");
    invoice.status = "Cancelled";
    this.removeTlcs(invoice.hash);
    return { invoice_address: invoice.address, invoice: invoice.wire, status: "Cancelled" };
  }

  /** research 2.2: one live session per hash; a retry only after Failed. max_fee_amount is clamped by max_fee_rate. */
  private sendPayment(p: Record<string, unknown>): unknown {
    const invoice = this.invoiceByAddress(stringField(p, "invoice"));
    const maxFeeAmount = quantityField(p, "max_fee_amount", false);
    const maxFeeRate = quantityField(p, "max_fee_rate", false) ?? DEFAULT_MAX_FEE_RATE_PER_MILLE;
    const tlcExpiryLimit = quantityField(p, "tlc_expiry_limit", false) ?? BigInt(FIBER_MAX_TLC_EXPIRY_LIMIT_MS);
    const existing = this.payments.get(invoice.hash);
    if (existing && existing.status !== "Failed") fail(`Payment session already exists: 0x${invoice.hash}`);
    if (invoice.expiresAt !== null && this.clock.now() > invoice.expiresAt) fail("invoice is expired");
    if (BigInt(invoice.finalExpiryDeltaMs) > tlcExpiryLimit) fail("Failed to build route: tlc_expiry_limit is below the final expiry delta");
    const rateCap = invoice.amount === null ? null : (invoice.amount * maxFeeRate) / FEE_RATE_DENOMINATOR;
    const payment: SimPayment = {
      hash: invoice.hash,
      status: "Created",
      preimage: null,
      fee: 0n,
      failedError: null,
      effectiveMaxFee: maxFeeAmount === null ? rateCap : rateCap === null ? maxFeeAmount : maxFeeAmount < rateCap ? maxFeeAmount : rateCap,
      params: p,
    };
    this.payments.set(invoice.hash, payment);
    return this.wirePayment(payment);
  }

  private wirePayment(payment: SimPayment): unknown {
    return {
      payment_hash: `0x${payment.hash}`,
      status: payment.status,
      created_at: hex(this.clock.now()),
      last_updated_at: hex(this.clock.now()),
      failed_error: payment.failedError,
      fee: hex(payment.fee),
      custom_records: null,
      ...(payment.preimage ? { payment_preimage: `0x${payment.preimage}` } : {}),
    };
  }

  /* ------------------------------------------------------------------------------------- Storage */

  private storeInvoice(o: {
    hash: Hex32;
    preimage: Hex32 | null;
    amount: bigint | null;
    currency: string;
    hashAlgorithm: HashAlgorithm;
    udt: Script | null;
    expirySeconds: number | null;
    finalExpiryDeltaMs: number;
    hold: boolean;
    owned: boolean;
    payee: string;
    description: string | null;
  }): SimInvoice {
    const createdAt = this.clock.now();
    const attrs: Record<string, unknown>[] = [
      ...(o.description === null ? [] : [{ description: o.description }]),
      ...(o.expirySeconds === null ? [] : [{ expiry_time: hex(o.expirySeconds) }]),
      { final_htlc_minimum_expiry_delta: hex(o.finalExpiryDeltaMs) },
      { hash_algorithm: o.hashAlgorithm },
      ...(o.udt ? [{ udt_script: encodeMoleculeScript(o.udt) }] : []),
      { payee_public_key: o.payee },
    ];
    const address = `${o.currency.toLowerCase()}1q${o.hash.slice(0, 48)}`;
    const invoice: SimInvoice = {
      address,
      hash: o.hash,
      wire: {
        currency: o.currency,
        ...(o.amount === null ? {} : { amount: hex(o.amount) }),
        signature: "3f2e1d0c",
        data: { timestamp: hex(createdAt), payment_hash: `0x${o.hash}`, attrs },
      },
      amount: o.amount,
      status: "Open",
      hold: o.hold,
      preimage: o.preimage,
      createdAt,
      expiresAt: o.expirySeconds === null ? null : createdAt + o.expirySeconds * 1_000,
      finalExpiryDeltaMs: o.finalExpiryDeltaMs,
      hashAlgorithm: o.hashAlgorithm,
      udt: o.udt,
      owned: o.owned,
    };
    this.invoices.set(o.hash, invoice);
    this.addresses.set(address, o.hash);
    return invoice;
  }

  private reportedStatus(invoice: SimInvoice): InvoiceStatus | "Expired" {
    const expired = invoice.status === "Open" && invoice.expiresAt !== null && this.clock.now() > invoice.expiresAt;
    return expired ? "Expired" : invoice.status;
  }

  private ownedInvoice(hash: Hex32): SimInvoice {
    const invoice = this.invoices.get(hash);
    if (!invoice?.owned) throw new Error(`no own invoice ${hash}`);
    return invoice;
  }

  private ownedInvoiceOrFail(hash: Hex32): SimInvoice {
    const invoice = this.invoices.get(hash);
    return invoice?.owned ? invoice : fail("invoice not found");
  }

  private invoiceByAddress(address: string): SimInvoice {
    const hash = this.addresses.get(address);
    const invoice = hash === undefined ? undefined : this.invoices.get(hash);
    return invoice ?? fail(`Failed to parse invoice: ${address}`);
  }

  private paymentFor(hash: Hex32): SimPayment {
    return this.payments.get(hash) ?? fail(`Payment session not found: 0x${hash}`);
  }

  private removeTlcs(hash: Hex32): void {
    this.channels = this.channels.map((channel) => ({
      ...channel,
      pending_tlcs: (channel.pending_tlcs as { payment_hash: string }[]).filter((tlc) => tlc.payment_hash !== `0x${hash}`),
    }));
  }
}

/* ----------------------------------------------------------------------------------------- Param checks */

function noParams(params: unknown): void {
  if (!Array.isArray(params) || params.length !== 0) invalidParams("expected []");
}

function oneObject(params: unknown): Record<string, unknown> {
  if (!Array.isArray(params) || params.length !== 1 || typeof params[0] !== "object" || params[0] === null) {
    return invalidParams("expected a one-object array");
  }
  return params[0] as Record<string, unknown>;
}

function stringField(p: Record<string, unknown>, field: string): string {
  const value = p[field];
  return typeof value === "string" ? value : invalidParams(field);
}

function quantityField(p: Record<string, unknown>, field: string, required: boolean): bigint | null {
  const value = p[field];
  if (value === undefined && !required) return null;
  return typeof value === "string" && HEX_QUANTITY.test(value) ? BigInt(value) : invalidParams(`${field} must be a 0x hex quantity`);
}

function hashField(p: Record<string, unknown>, field: string): Hex32 {
  const value = p[field];
  return typeof value === "string" && HASH256.test(value) ? value.replace(/^0x/, "").toLowerCase() : invalidParams(`${field} must be a Hash256`);
}

/** A channel's funding_udt_type_script as a Script; null for a CKB channel. */
const wireScript = (value: unknown): Script | null => (value === null || value === undefined ? null : scriptField(value));

function scriptField(value: unknown): Script {
  const s = value as Record<string, unknown>;
  const hashTypes = ["type", "data", "data1", "data2"];
  if (typeof s?.code_hash !== "string" || typeof s.args !== "string" || !hashTypes.includes(String(s.hash_type))) {
    return invalidParams("udt_type_script must be {code_hash, hash_type, args}");
  }
  return { codeHash: s.code_hash, hashType: s.hash_type as Script["hashType"], args: s.args };
}

/* ---------------------------------------------------------------------------------------- Local server */

export interface FakeFnnServer {
  rpcUrl: string;
  port: number;
  /** Headers of every HTTP request and WebSocket upgrade. */
  httpHeaders: IncomingHttpHeaders[];
  wsHeaders: IncomingHttpHeaders[];
  /** JSON-RPC requests received over WebSocket. */
  wsRequests: { method: string; params: unknown }[];
  subscribers(): number;
  /** Sends a store_changes notification to every subscribed socket. */
  push(change: Record<string, unknown>): void;
  /** Resolves once `count` sockets have subscribed. */
  waitForSubscribers(count: number): Promise<void>;
  close(): Promise<void>;
}

/**
 * fnn's RPC surface on 127.0.0.1: HTTP POST JSON-RPC answered by `sim`, and on the same port the WebSocket that serves
 * subscribe_store_changes (module pubsub).
 */
export async function startFakeFnnServer(sim: FnnSimulator, port = 0): Promise<FakeFnnServer> {
  const httpHeaders: IncomingHttpHeaders[] = [];
  const wsHeaders: IncomingHttpHeaders[] = [];
  const wsRequests: { method: string; params: unknown }[] = [];
  const subscribed = new Map<WebSocket, number>();
  const waiters: { count: number; resolve: () => void }[] = [];
  let nextSubscription = 1;

  const server: Server = createServer((req, res) => {
    httpHeaders.push(req.headers);
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(sim.handle(Buffer.concat(chunks).toString("utf8")));
    });
  });
  const wss = new WebSocketServer({ server });
  const settleWaiters = (): void => {
    for (const waiter of [...waiters]) {
      if (subscribed.size >= waiter.count) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  };
  wss.on("connection", (socket, req) => {
    wsHeaders.push(req.headers);
    socket.on("message", (data) => {
      const request = JSON.parse(String(data)) as { id: number; method: string; params: unknown };
      wsRequests.push({ method: request.method, params: request.params });
      if (request.method !== "subscribe_store_changes") {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: METHOD_NOT_FOUND, message: "Method not found" } }));
        return;
      }
      const subscription = nextSubscription++;
      subscribed.set(socket, subscription);
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: subscription }));
      settleWaiters();
    });
    socket.on("close", () => subscribed.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const actualPort = (server.address() as AddressInfo).port;

  return {
    rpcUrl: `http://127.0.0.1:${actualPort}`,
    port: actualPort,
    httpHeaders,
    wsHeaders,
    wsRequests,
    subscribers: () => subscribed.size,
    push: (change) => {
      for (const [socket, subscription] of subscribed) {
        socket.send(JSON.stringify({ jsonrpc: "2.0", method: "store_changes", params: { subscription, result: change } }));
      }
    },
    waitForSubscribers: (count) =>
      new Promise<void>((resolve) => {
        waiters.push({ count, resolve });
        settleWaiters();
      }),
    close: async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Polls `condition` until it holds or `timeoutMs` passes; for waiting on socket events in real time. */
export async function eventually(condition: () => boolean, timeoutMs = 3_000, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}
