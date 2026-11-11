import { randomBytes } from "node:crypto";
import { LN_PAYMENT_REFUSAL_REASON } from "../../src/common/constants/lnd.constants";
import { LND_BLOCK_PADDING_BLOCKS, LND_DEFAULT_HOLD_EXPIRY_DELTA_BLOCKS, MSAT_PER_SAT } from "../../src/common/constants/protocol.constants";
import { sha256Hex } from "../../src/common/utils/hex.util";
import type {
  DecodedLnInvoice,
  LightningPort,
  LnBalances,
  LnInvoiceStatus,
  LnNodeInfo,
  LnPaymentStatus,
} from "../../src/application/ports/lightning.port";
import type { BtcNetwork, Hex32 } from "../../src/domain/types";
import { FakeClock } from "./fake-clock";
import { decodeFake, encodeFake, FAKE_LN_PREFIX } from "./fake-invoice";

/**
 * An in-memory Lightning network of fake nodes that behaves like LND where the hub relies on it:
 * - hold invoices go OPEN -> ACCEPTED (HTLC held at height + cltvExpiry) -> SETTLED or CANCELED;
 * - ACCEPTED hold invoices are auto-cancelled `holdExpiryDeltaBlocks` (LND's invoices.holdexpirydelta, 18 by default)
 *   before the HTLC expires (mineBlocks);
 * - paying a regular invoice succeeds with its preimage unless the test sets another outcome;
 * - paying a hold invoice stays IN_FLIGHT until its owner settles (SUCCEEDED) or cancels (FAILED);
 * - a payment LND refuses to start resolves FAILED and leaves no record (getPayment stays null): a cltv_limit not above
 *   the invoice's CLTV plus LND's 3 padding blocks (routing.ValidateCLTVLimit), or the "refuse" behaviour;
 * - payments are idempotent per hash.
 */

type InvoicePayload = {
  hash: Hex32;
  amountMsat: bigint | null;
  network: BtcNetwork;
  createdAt: number;
  expiresAt: number;
  cltvExpiry: number;
  destination: string;
  description: string;
};

type InvoiceRecord = {
  owner: FakeLightningNode;
  payload: InvoicePayload;
  paymentRequest: string;
  hold: boolean;
  preimage: Hex32 | null;
  state: LnInvoiceStatus["state"];
  amountPaidMsat: bigint;
  htlcExpiryHeights: number[];
  payer: FakeLightningNode | null;
};

/** "refuse": the paying node refuses to start the payment, so nothing is sent and it keeps no record of it. */
export type PayoutBehavior = "succeed" | "fail" | "hang" | "refuse";

export class FakeLightningNetwork {
  blockHeight: number;
  /** invoices.holdexpirydelta of every node: how many blocks before the earliest HTLC expiry it auto-cancels. */
  holdExpiryDeltaBlocks = LND_DEFAULT_HOLD_EXPIRY_DELTA_BLOCKS;
  readonly invoices = new Map<Hex32, InvoiceRecord>();
  private readonly nodes = new Map<string, FakeLightningNode>();
  private readonly behaviors = new Map<Hex32, PayoutBehavior>();

  constructor(
    readonly network: BtcNetwork = "regtest",
    readonly clock = new FakeClock(),
    startHeight = 100,
  ) {
    this.blockHeight = startHeight;
  }

  node(name: string, balances?: Partial<LnBalances>): FakeLightningNode {
    let n = this.nodes.get(name);
    if (!n) {
      n = new FakeLightningNode(this, name, balances);
      this.nodes.set(name, n);
    }
    return n;
  }

  /** What happens when someone pays the regular invoice with this hash. Default: succeed. */
  setPayoutBehavior(paymentHash: Hex32, behavior: PayoutBehavior): void {
    this.behaviors.set(paymentHash, behavior);
  }

  behaviorFor(paymentHash: Hex32): PayoutBehavior {
    return this.behaviors.get(paymentHash) ?? "succeed";
  }

  /** Mines blocks and applies LND's auto-cancel to accepted hold invoices near their HTLC expiry. */
  mineBlocks(count: number): void {
    this.blockHeight += count;
    for (const rec of this.invoices.values()) {
      if (rec.state !== "ACCEPTED" || rec.htlcExpiryHeights.length === 0) continue;
      const earliest = Math.min(...rec.htlcExpiryHeights);
      if (this.blockHeight >= earliest - this.holdExpiryDeltaBlocks) rec.owner.cancelHeld(rec, "auto-cancelled near HTLC expiry");
    }
  }

  /** Finishes a payment left hanging by setPayoutBehavior(hash, "hang"). */
  resolveHanging(paymentHash: Hex32, outcome: "succeed" | "fail"): void {
    for (const n of this.nodes.values()) n.resolveHanging(paymentHash, outcome);
  }

  notify(paymentHash: Hex32): void {
    for (const n of this.nodes.values()) n.emit(paymentHash);
  }
}

export class FakeLightningNode implements LightningPort {
  readonly pubkey: string;
  /** Every call, in order, for assertions: e.g. expect(node.calls).toContain("settleInvoice"). */
  readonly calls: string[] = [];
  private readonly payments = new Map<Hex32, LnPaymentStatus>();
  private readonly listeners = new Set<(paymentHash: Hex32) => void>();
  private balances: LnBalances;
  /** Make the next call to `method` throw, to test transport errors. */
  failNext: string | null = null;
  /** What getInfo reports as `synced`: false plays a node that lags the chain (after a restart, a stalled backend). */
  synced = true;
  /**
   * What getInfo reports as the node's own `network`; undefined reports the fake network's. Another network plays an LND
   * on the wrong chain, null one on a chain the hub does not know.
   */
  reportedNetwork: BtcNetwork | null | undefined = undefined;

  constructor(
    private readonly net: FakeLightningNetwork,
    readonly name: string,
    balances?: Partial<LnBalances>,
  ) {
    this.pubkey = `02${sha256Hex(Buffer.from(name).toString("hex").padEnd(64, "0").slice(0, 64)).slice(0, 64)}`;
    this.balances = { channelLocalSats: 1_000_000n, channelRemoteSats: 1_000_000n, onchainSats: 0n, ...balances };
  }

  private enter(method: string): void {
    this.calls.push(method);
    if (this.failNext === method) {
      this.failNext = null;
      throw new Error(`${method}: simulated transport error`);
    }
  }

  emit(paymentHash: Hex32): void {
    for (const l of this.listeners) l(paymentHash);
  }

  async getInfo(): Promise<LnNodeInfo> {
    this.enter("getInfo");
    const network = this.reportedNetwork === undefined ? this.net.network : this.reportedNetwork;
    return { pubkey: this.pubkey, network, blockHeight: this.net.blockHeight, synced: this.synced, version: "fake-lnd", uris: [] };
  }

  async decodeInvoice(paymentRequest: string): Promise<DecodedLnInvoice> {
    this.enter("decodeInvoice");
    const p = decodeFake<InvoicePayload>(FAKE_LN_PREFIX, paymentRequest);
    return {
      paymentHash: p.hash,
      amountMsat: p.amountMsat,
      network: p.network,
      createdAt: p.createdAt,
      expiresAt: p.expiresAt,
      cltvExpiry: p.cltvExpiry,
      destination: p.destination,
      description: p.description,
    };
  }

  private register(hash: Hex32, amountSats: bigint | null, expirySeconds: number, cltvExpiry: number, memo: string, hold: boolean, preimage: Hex32 | null) {
    if (this.net.invoices.has(hash)) throw new Error("invoice with that hash already exists");
    const now = this.net.clock.now();
    const payload: InvoicePayload = {
      hash,
      amountMsat: amountSats === null ? null : amountSats * MSAT_PER_SAT,
      network: this.net.network,
      createdAt: now,
      expiresAt: now + expirySeconds * 1_000,
      cltvExpiry,
      destination: this.pubkey,
      description: memo,
    };
    const paymentRequest = encodeFake(FAKE_LN_PREFIX, payload);
    this.net.invoices.set(hash, {
      owner: this,
      payload,
      paymentRequest,
      hold,
      preimage,
      state: "OPEN",
      amountPaidMsat: 0n,
      htlcExpiryHeights: [],
      payer: null,
    });
    return paymentRequest;
  }

  async createHoldInvoice(args: { paymentHash: Hex32; amountSats: bigint; expirySeconds: number; cltvExpiry: number; memo: string }) {
    this.enter("createHoldInvoice");
    return { paymentRequest: this.register(args.paymentHash, args.amountSats, args.expirySeconds, args.cltvExpiry, args.memo, true, null) };
  }

  async createInvoice(args: { amountSats: bigint; expirySeconds: number; memo: string }) {
    this.enter("createInvoice");
    const preimage = randomBytes(32).toString("hex");
    const paymentHash = sha256Hex(preimage);
    return { paymentRequest: this.register(paymentHash, args.amountSats, args.expirySeconds, 40, args.memo, false, preimage), paymentHash };
  }

  /** Test helper: a regular invoice with a preimage the test chose. */
  createInvoiceWithPreimage(preimage: Hex32, amountSats: bigint | null, opts: { expirySeconds?: number; cltvExpiry?: number } = {}): string {
    return this.register(sha256Hex(preimage), amountSats, opts.expirySeconds ?? 3_600, opts.cltvExpiry ?? 40, "test", false, preimage);
  }

  async lookupInvoice(paymentHash: Hex32): Promise<LnInvoiceStatus | null> {
    this.enter("lookupInvoice");
    const rec = this.net.invoices.get(paymentHash);
    if (!rec || rec.owner !== this) return null;
    if (rec.state === "OPEN" && this.net.clock.now() > rec.payload.expiresAt) rec.state = "CANCELED";
    return {
      paymentHash,
      state: rec.state,
      amountMsat: rec.payload.amountMsat ?? 0n,
      amountPaidMsat: rec.amountPaidMsat,
      htlcExpiryHeights: rec.state === "ACCEPTED" ? [...rec.htlcExpiryHeights] : [],
    };
  }

  async settleInvoice(preimage: Hex32): Promise<void> {
    this.enter("settleInvoice");
    const hash = sha256Hex(preimage);
    const rec = this.net.invoices.get(hash);
    if (!rec || rec.owner !== this) throw new Error("unable to locate invoice");
    if (rec.state === "SETTLED") return;
    if (rec.state !== "ACCEPTED") throw new Error(`invoice is ${rec.state}, cannot settle`);
    rec.state = "SETTLED";
    rec.preimage = preimage;
    rec.payer?.finishPayment(hash, { state: "SUCCEEDED", preimage });
    this.net.notify(hash);
  }

  async cancelInvoice(paymentHash: Hex32): Promise<void> {
    this.enter("cancelInvoice");
    const rec = this.net.invoices.get(paymentHash);
    if (!rec || rec.owner !== this) throw new Error("unable to locate invoice");
    if (rec.state === "CANCELED") return;
    if (rec.state === "SETTLED") throw new Error("invoice already settled");
    this.cancelHeld(rec, "cancelled by the receiver");
  }

  cancelHeld(rec: InvoiceRecord, reason: string): void {
    rec.state = "CANCELED";
    rec.htlcExpiryHeights = [];
    rec.payer?.finishPayment(rec.payload.hash, { state: "FAILED", failureReason: reason });
    this.net.notify(rec.payload.hash);
  }

  async payInvoice(args: { paymentRequest: string; maxFeeSats: bigint; cltvLimit: number; timeoutSeconds: number }): Promise<LnPaymentStatus> {
    this.enter("payInvoice");
    const p = decodeFake<InvoicePayload>(FAKE_LN_PREFIX, args.paymentRequest);
    const existing = this.payments.get(p.hash);
    if (existing) return { ...existing };
    const refusal = this.refusalOf(p, args.cltvLimit);
    if (refusal) return { paymentHash: p.hash, state: "FAILED", preimage: null, feeMsat: 0n, failureReason: refusal };
    const rec = this.net.invoices.get(p.hash);
    const status: LnPaymentStatus = { paymentHash: p.hash, state: "IN_FLIGHT", preimage: null, feeMsat: 0n, failureReason: null };
    this.payments.set(p.hash, status);

    const fail = (reason: string) => this.finishPayment(p.hash, { state: "FAILED", failureReason: reason });
    if (!rec || rec.state !== "OPEN") fail("FAILURE_REASON_INCORRECT_PAYMENT_DETAILS");
    else if (this.net.clock.now() > rec.payload.expiresAt) fail("FAILURE_REASON_INCORRECT_PAYMENT_DETAILS");
    else if (rec.payload.cltvExpiry > args.cltvLimit) fail("FAILURE_REASON_NO_ROUTE");
    else if (rec.hold) {
      // The receiver holds the HTLC; our payment stays in flight until it settles or cancels.
      rec.state = "ACCEPTED";
      rec.payer = this;
      rec.amountPaidMsat = rec.payload.amountMsat ?? 0n;
      rec.htlcExpiryHeights = [this.net.blockHeight + rec.payload.cltvExpiry];
      this.net.notify(p.hash);
    } else {
      const behavior = this.net.behaviorFor(p.hash);
      if (behavior === "fail") fail("FAILURE_REASON_NO_ROUTE");
      else if (behavior === "succeed") this.succeedRegular(rec);
      // "hang": stays IN_FLIGHT until resolveHanging.
    }
    return { ...this.payments.get(p.hash)! };
  }

  /** Why LND would refuse to start paying this invoice, or null when it sends it. */
  private refusalOf(invoice: InvoicePayload, cltvLimit: number): string | null {
    if (cltvLimit <= invoice.cltvExpiry + LND_BLOCK_PADDING_BLOCKS) return LN_PAYMENT_REFUSAL_REASON.CLTV_LIMIT_TOO_LOW;
    return this.net.behaviorFor(invoice.hash) === "refuse" ? LN_PAYMENT_REFUSAL_REASON.UNSUPPORTED_INVOICE_FEATURE : null;
  }

  private succeedRegular(rec: InvoiceRecord): void {
    rec.state = "SETTLED";
    rec.amountPaidMsat = rec.payload.amountMsat ?? 0n;
    this.finishPayment(rec.payload.hash, { state: "SUCCEEDED", preimage: rec.preimage });
  }

  resolveHanging(paymentHash: Hex32, outcome: "succeed" | "fail"): void {
    const pay = this.payments.get(paymentHash);
    if (!pay || pay.state !== "IN_FLIGHT") return;
    const rec = this.net.invoices.get(paymentHash);
    if (outcome === "succeed" && rec) this.succeedRegular(rec);
    else this.finishPayment(paymentHash, { state: "FAILED", failureReason: "FAILURE_REASON_TIMEOUT" });
  }

  finishPayment(paymentHash: Hex32, patch: Partial<LnPaymentStatus>): void {
    const pay = this.payments.get(paymentHash);
    if (!pay) return;
    Object.assign(pay, patch);
    this.emit(paymentHash);
  }

  async getPayment(paymentHash: Hex32): Promise<LnPaymentStatus | null> {
    this.enter("getPayment");
    const pay = this.payments.get(paymentHash);
    return pay ? { ...pay } : null;
  }

  async getBalances(): Promise<LnBalances> {
    this.enter("getBalances");
    return { ...this.balances };
  }

  setBalances(patch: Partial<LnBalances>): void {
    this.balances = { ...this.balances, ...patch };
  }

  onUpdate(listener: (paymentHash: Hex32) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
