import { createHash } from "node:crypto";
import { HttpStatus } from "@nestjs/common";
import { API_ERROR_CODE } from "../../src/common/constants/api.constants";
import { FIBER_CHANNEL_STATUS } from "../../src/common/constants/fiber-node.constants";
import { HubError } from "../../src/common/errors/hub.error";
import {
  FIBER_DEFAULT_COMMITMENT_DELAY_EPOCHS,
  FIBER_DEFAULT_HOP_EXPIRY_DELTA_MS,
  FIBER_HELD_TLC_CHECK_INTERVAL_MS,
  FIBER_MIN_FINAL_EXPIRY_DELTA_MS,
} from "../../src/common/constants/protocol.constants";
import { sha256Hex } from "../../src/common/utils/hex.util";
import { toNodeId } from "../../src/common/utils/node-id.util";
import { sameAssetScript } from "../../src/common/utils/script.util";
import { fiberHeldTlcEarlyFailMs } from "../../src/common/utils/timing.util";
import type {
  FiberChannel,
  FiberChannelBalance,
  FiberHashAlgorithm,
  FiberHeldTlc,
  FiberInvoiceStatus,
  FiberNodeInfo,
  FiberOfferedTlc,
  FiberPaymentStatus,
  FiberPort,
  OpenChannelArgs,
  ParsedFiberInvoice,
} from "../../src/application/ports/fiber.port";
import type { CkbNetwork, Hex32, Script } from "../../src/domain/types";
import { FakeClock } from "./fake-clock";
import { decodeFake, encodeFake, FAKE_FIBER_PREFIX } from "./fake-invoice";
import type { PayoutBehavior } from "./fake-lightning";

/**
 * An in-memory Fiber network of fake fnn nodes, faithful to the behaviour the hub depends on (fnn v0.9.1):
 * - hold invoices: Open -> Received (TLC held) -> Paid after settle_invoice, or Cancelled;
 * - an Open invoice past its expiry reads as Expired;
 * - the payer's TLC expiry = now + invoice final_expiry_delta + one hop delta, capped by the payer's tlc_expiry_limit;
 * - the TLC arrives over a channel the payee opened (default delay), or one the payer opened with its own commitment
 *   delay (`opensPaymentChannel`); the channel is in the invoice's asset unless the payer sets `paysOverChannelOf`, and
 *   heldTlcs() counts only TLCs on channels in the asset asked for;
 * - like fnn's check_tlc_expiry, a TLC whose expiry is less than 2/3 of its channel's commitment delay away is never
 *   added: the payment fails at the payer with ExpiryTooSoon and the invoice stays Open;
 * - tick() fails held TLCs within their channel's early-fail margin of expiry (FIBER_HELD_TLC_EARLY_FAIL_MS by
 *   default), and, like fnn, leaves the invoice saying Received with no TLC held (heldTlcs() is then empty);
 * - a payment can read Failed while a part it sent is still out (failLeavingPartOut), until the part resolves;
 * - an invoice made with allowMpp says so when parsed;
 * - with `settleInSteps`, settle_invoice behaves like fnn on the wire: the invoice keeps saying Received with nothing
 *   held while its TLC is being removed (hasRemovingTlcs() true) until completeRemovals() makes it Paid;
 * - settle checks sha256(preimage) for sha256 invoices; payments are idempotent per hash and return the preimage;
 * - with the "refuse" behaviour, send_payment fails before any session exists: payInvoice resolves Failed and
 *   getPayment keeps no record (or the earlier, failed one);
 * - channels have a status and an opener: setChannels() channels default to ones this node opened, public, ready or
 *   opening by their `ready` flag; listChannels() shows their balances, listChannelDetails() all of it;
 * - open_channel needs a connected peer (connectPeer() plays a node that dialled this one) and otherwise throws a plain
 *   Error like fnn's answer; the new channel is private or public as asked, opened by this node, `opening` with the whole
 *   funding on this node's side and `awaitingAcceptSince` set (the peer has not accepted) until completeChannelOpenings();
 *   `loseNextOpenChannelAnswer` plays a call that started the channel but timed out (a 503 HubError);
 * - abandon_channel removes a channel that is not funded yet (opening) and refuses any other, or an unknown id, with a
 *   plain Error, as fnn does.
 */

/** A channel for setChannels(): its balances, and optionally its status and opener (see FakeFiberNode.setChannels). */
export type FakeChannel = FiberChannelBalance & Partial<Pick<FiberChannel, "status" | "public" | "openedByPeer" | "awaitingAcceptSince">>;

/** What setChannels() assumes for a channel that does not say: the node's own public channel, ready or opening. */
const withChannelDefaults = (channel: FakeChannel): FiberChannel => ({
  status: channel.ready ? FIBER_CHANNEL_STATUS.READY : FIBER_CHANNEL_STATUS.OPENING,
  public: true,
  openedByPeer: false,
  ...channel,
});

const toBalance = ({ channelId, peer, udtTypeScript, ready, localBalance, remoteBalance }: FiberChannel): FiberChannelBalance => ({
  channelId,
  peer,
  udtTypeScript,
  ready,
  localBalance,
  remoteBalance,
});

/** What fnn answers open_channel with when the peer is not connected. */
const FAKE_PEER_NOT_CONNECTED = "Peer not found";
/** What fnn answers abandon_channel with for an id it does not know. */
const FAKE_CHANNEL_NOT_FOUND = "Channel not found";
/** What fnn answers abandon_channel with for a channel whose funding has started. */
const FAKE_CHANNEL_NOT_ABANDONABLE = "Channel cannot be abandoned, please shutdown the channel instead";
/** Length in bytes of a fake temporary channel id. */
const FAKE_CHANNEL_ID_BYTES = 32;

type InvoicePayload = {
  hash: Hex32;
  amount: bigint | null;
  network: CkbNetwork;
  hashAlgorithm: FiberHashAlgorithm;
  udt: Script | null;
  createdAt: number;
  expiresAt: number | null;
  finalExpiryDeltaMs: number;
  payee: string;
  allowMpp?: boolean;
};

type InvoiceRecord = {
  owner: FakeFiberNode;
  payload: InvoicePayload;
  invoice: string;
  hold: boolean;
  preimage: Hex32 | null;
  state: "Open" | "Received" | "Paid" | "Cancelled";
  heldTlc: FiberHeldTlc | null;
  /** The asset (UDT type script, null for CKB) of the channel the held TLC came over. */
  heldTlcChannelUdt: Script | null;
  /** How long before its expiry fnn fails the held TLC: set by the commitment delay of the channel it came over. */
  heldTlcEarlyFailMs: number;
  /** settle_invoice has removed the held TLC, and the peer has not acknowledged it yet (settleInSteps only). */
  removingTlc: boolean;
  payer: FakeFiberNode | null;
};

/** What a payment fails with when its channel refuses a TLC that expires too soon for the channel's commitment delay. */
const FAKE_TLC_EXPIRY_TOO_SOON = "ExpiryTooSoon";

/** What fnn answers send_payment with when it cannot even start a session (no route at all). */
const FAKE_SEND_REFUSAL = "Send payment error: Failed to build route";

export class FakeFiberNetwork {
  readonly invoices = new Map<Hex32, InvoiceRecord>();
  /** Settle in two steps like fnn (Received while the TLC is removed, then Paid on completeRemovals()); off: at once. */
  settleInSteps = false;
  private readonly nodes = new Map<string, FakeFiberNode>();
  private readonly behaviors = new Map<Hex32, PayoutBehavior>();

  constructor(
    readonly network: CkbNetwork = "devnet",
    readonly clock = new FakeClock(),
  ) {}

  node(name: string): FakeFiberNode {
    let n = this.nodes.get(name);
    if (!n) {
      n = new FakeFiberNode(this, name);
      this.nodes.set(name, n);
    }
    return n;
  }

  setPayoutBehavior(paymentHash: Hex32, behavior: PayoutBehavior): void {
    this.behaviors.set(paymentHash, behavior);
  }

  behaviorFor(paymentHash: Hex32): PayoutBehavior {
    return this.behaviors.get(paymentHash) ?? "succeed";
  }

  /** Applies fnn's early fail of held TLCs close to expiry. Call after clock.advance(). */
  tick(): void {
    const now = this.clock.now();
    for (const rec of this.invoices.values()) {
      if (rec.heldTlc && rec.heldTlc.expiresAt - now < rec.heldTlcEarlyFailMs) {
        rec.heldTlc = null; // invoice stays "Received", as in fnn
        rec.payer?.finishPayment(rec.payload.hash, { state: "Failed", failedError: "ExpiryTooSoon" });
        this.notify(rec.payload.hash);
      }
    }
  }

  /** Finishes every settlement settleInSteps left halfway: the invoices become Paid and their payers succeed. */
  completeRemovals(): void {
    for (const rec of this.invoices.values()) {
      if (!rec.removingTlc || !rec.preimage) continue;
      rec.removingTlc = false;
      rec.state = "Paid";
      rec.payer?.finishPayment(rec.payload.hash, { state: "Success", preimage: rec.preimage });
      this.notify(rec.payload.hash);
    }
  }

  resolveHanging(paymentHash: Hex32, outcome: "succeed" | "fail"): void {
    for (const n of this.nodes.values()) n.resolveHanging(paymentHash, outcome);
  }

  notify(paymentHash: Hex32): void {
    for (const n of this.nodes.values()) n.emit(paymentHash);
  }
}

export class FakeFiberNode implements FiberPort {
  readonly nodeId: string;
  readonly calls: string[] = [];
  private readonly payments = new Map<Hex32, FiberPaymentStatus>();
  private readonly listeners = new Set<(paymentHash: Hex32) => void>();
  private channels: FiberChannel[] = [];
  /** Node ids with a live connection to this node. */
  private readonly peers = new Set<string>();
  private openedChannelCount = 0;
  /** Set: the next openChannel starts the channel, then throws a 503 HubError as a call whose answer was lost. */
  loseNextOpenChannelAnswer = false;
  /** Payment parts this node sent that are still out although their payment already reads Failed. */
  private readonly strandedParts = new Set<Hex32>();
  /** What offeredTlcs() reports per hash; tests set it (setOfferedTlcs). None by default. */
  private readonly offered = new Map<Hex32, FiberOfferedTlc[]>();
  /** Channel ids forceCloseChannel() was called with, in order. */
  readonly forceClosedChannels: string[] = [];
  failNext: string | null = null;
  /**
   * As a payer: null pays over a channel the payee opened (fnn's default commitment delay); set, over a channel this
   * node opened to the payee with that commitment delay, which the payee sees as opened by its peer.
   */
  opensPaymentChannel: { commitmentDelayEpochs: number } | null = null;
  /**
   * As a payer: the asset (UDT type script, null for CKB) of the channel its TLC goes over; undefined uses the invoice's
   * asset. Another asset plays a TLC fnn has committed but not rejected yet: the invoice still reads Received.
   */
  paysOverChannelOf: Script | null | undefined = undefined;

  constructor(
    private readonly net: FakeFiberNetwork,
    readonly name: string,
  ) {
    this.nodeId = `03${createHash("sha256").update(name).digest("hex")}`;
    this.setChannels([{ channelId: `0x${"11".repeat(32)}`, peer: "peer", udtTypeScript: null, ready: true, localBalance: 100_000n * 10n ** 8n, remoteBalance: 100_000n * 10n ** 8n }]);
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

  /** Replaces the node's channels; status and opener default to this node's own public channel (FakeChannel). */
  setChannels(channels: FakeChannel[]): void {
    this.channels = channels.map(withChannelDefaults);
  }

  /** Test helper: a node dialled this one (the hub's fnn can then open a channel to it). */
  connectPeer(nodeId: string): void {
    this.peers.add(toNodeId(nodeId));
  }

  disconnectPeer(nodeId: string): void {
    this.peers.delete(toNodeId(nodeId));
  }

  /** Test helper: every channel still opening is accepted by its peer and ready. */
  completeChannelOpenings(): void {
    for (const channel of this.channels) {
      if (channel.status !== FIBER_CHANNEL_STATUS.OPENING) continue;
      channel.status = FIBER_CHANNEL_STATUS.READY;
      channel.ready = true;
      delete channel.awaitingAcceptSince;
    }
  }

  /** Test helper: the peer accepted every channel still waiting for it; they stay opening (funding) until completed. */
  acceptChannelOpenings(): void {
    for (const channel of this.channels) delete channel.awaitingAcceptSince;
  }

  async getInfo(): Promise<FiberNodeInfo> {
    this.enter("getInfo");
    return { nodeId: this.nodeId, network: this.net.network, version: "fake-fnn" };
  }

  async parseInvoice(invoice: string): Promise<ParsedFiberInvoice> {
    this.enter("parseInvoice");
    const p = decodeFake<InvoicePayload>(FAKE_FIBER_PREFIX, invoice);
    return {
      paymentHash: p.hash,
      amount: p.amount,
      network: p.network,
      hashAlgorithm: p.hashAlgorithm,
      udtTypeScript: p.udt,
      createdAt: p.createdAt,
      expiresAt: p.expiresAt,
      finalExpiryDeltaMs: p.finalExpiryDeltaMs,
      payee: p.payee,
      allowsMpp: p.allowMpp ?? false,
    };
  }

  private register(
    hash: Hex32,
    opts: {
      amount: bigint | null;
      udt: Script | null;
      expirySeconds: number | null;
      finalExpiryDeltaMs: number;
      hold: boolean;
      preimage: Hex32 | null;
      hashAlgorithm: FiberHashAlgorithm;
      allowMpp?: boolean;
    },
  ): string {
    if (this.net.invoices.has(hash)) throw new Error("invoice already exists");
    if (opts.finalExpiryDeltaMs < FIBER_MIN_FINAL_EXPIRY_DELTA_MS) throw new Error("final_expiry_delta below the minimum");
    const now = this.net.clock.now();
    const payload: InvoicePayload = {
      hash,
      amount: opts.amount,
      network: this.net.network,
      hashAlgorithm: opts.hashAlgorithm,
      udt: opts.udt,
      createdAt: now,
      expiresAt: opts.expirySeconds === null ? null : now + opts.expirySeconds * 1_000,
      finalExpiryDeltaMs: opts.finalExpiryDeltaMs,
      payee: this.nodeId,
      ...(opts.allowMpp ? { allowMpp: true } : {}),
    };
    const invoice = encodeFake(FAKE_FIBER_PREFIX, payload);
    this.net.invoices.set(hash, {
      owner: this,
      payload,
      invoice,
      hold: opts.hold,
      preimage: opts.preimage,
      state: "Open",
      heldTlc: null,
      heldTlcChannelUdt: opts.udt,
      heldTlcEarlyFailMs: fiberHeldTlcEarlyFailMs(FIBER_DEFAULT_COMMITMENT_DELAY_EPOCHS),
      removingTlc: false,
      payer: null,
    });
    return invoice;
  }

  async createHoldInvoice(args: { paymentHash: Hex32; amount: bigint; udtTypeScript: Script | null; expirySeconds: number; finalExpiryDeltaMs: number; description: string }) {
    this.enter("createHoldInvoice");
    const invoice = this.register(args.paymentHash, {
      amount: args.amount,
      udt: args.udtTypeScript,
      expirySeconds: args.expirySeconds,
      finalExpiryDeltaMs: args.finalExpiryDeltaMs,
      hold: true,
      preimage: null,
      hashAlgorithm: "sha256",
    });
    return { invoice };
  }

  async createInvoice(args: { preimage: Hex32; amount: bigint; udtTypeScript: Script | null; expirySeconds: number; description: string }) {
    this.enter("createInvoice");
    const paymentHash = sha256Hex(args.preimage);
    const invoice = this.register(paymentHash, {
      amount: args.amount,
      udt: args.udtTypeScript,
      expirySeconds: args.expirySeconds,
      finalExpiryDeltaMs: FIBER_MIN_FINAL_EXPIRY_DELTA_MS,
      hold: false,
      preimage: args.preimage,
      hashAlgorithm: "sha256",
    });
    return { invoice, paymentHash };
  }

  /** Test helper: a regular invoice with chosen options, e.g. hashAlgorithm "ckb_hash" or no amount. */
  createInvoiceWithOptions(
    preimage: Hex32,
    opts: {
      amount?: bigint | null;
      udt?: Script | null;
      expirySeconds?: number | null;
      finalExpiryDeltaMs?: number;
      hashAlgorithm?: FiberHashAlgorithm;
      allowMpp?: boolean;
    } = {},
  ): string {
    const algorithm = opts.hashAlgorithm ?? "sha256";
    const hash = algorithm === "sha256" ? sha256Hex(preimage) : createHash("sha256").update(`ckb_hash:${preimage}`).digest("hex");
    return this.register(hash, {
      amount: opts.amount === undefined ? 100n * 10n ** 8n : opts.amount,
      udt: opts.udt ?? null,
      expirySeconds: opts.expirySeconds === undefined ? 3_600 : opts.expirySeconds,
      finalExpiryDeltaMs: opts.finalExpiryDeltaMs ?? FIBER_MIN_FINAL_EXPIRY_DELTA_MS,
      hold: false,
      preimage,
      hashAlgorithm: algorithm,
      allowMpp: opts.allowMpp,
    });
  }

  async getInvoice(paymentHash: Hex32): Promise<FiberInvoiceStatus | null> {
    this.enter("getInvoice");
    const rec = this.net.invoices.get(paymentHash);
    if (!rec || rec.owner !== this) return null;
    const expired = rec.state === "Open" && rec.payload.expiresAt !== null && this.net.clock.now() > rec.payload.expiresAt;
    return { paymentHash, state: expired ? "Expired" : rec.state, amount: rec.payload.amount ?? 0n };
  }

  async settleInvoice(paymentHash: Hex32, preimage: Hex32): Promise<void> {
    this.enter("settleInvoice");
    const rec = this.net.invoices.get(paymentHash);
    if (!rec || rec.owner !== this) throw new Error("Invoice not found");
    if (rec.state === "Paid") return;
    if (rec.payload.hashAlgorithm === "sha256" && sha256Hex(preimage) !== paymentHash) throw new Error("Hash mismatch");
    if (rec.state !== "Received") throw new Error(`Invoice is ${rec.state}`);
    rec.preimage = preimage;
    if (!rec.heldTlc) return; // fnn accepts the call, but there is nothing left to claim
    rec.heldTlc = null;
    if (this.net.settleInSteps) {
      rec.removingTlc = true;
      return;
    }
    rec.state = "Paid";
    rec.payer?.finishPayment(paymentHash, { state: "Success", preimage });
    this.net.notify(paymentHash);
  }

  async cancelInvoice(paymentHash: Hex32): Promise<void> {
    this.enter("cancelInvoice");
    const rec = this.net.invoices.get(paymentHash);
    if (!rec || rec.owner !== this) throw new Error("Invoice not found");
    if (rec.state === "Cancelled") return;
    if (rec.state === "Paid") throw new Error("Invoice already paid");
    if (rec.state === "Received" && rec.preimage) throw new Error("PaymentPreimageAlreadyExists");
    rec.state = "Cancelled";
    if (rec.heldTlc) {
      rec.heldTlc = null;
      rec.payer?.finishPayment(paymentHash, { state: "Failed", failedError: "InvoiceCancelled" });
    }
    this.net.notify(paymentHash);
  }

  async heldTlcs(paymentHash: Hex32, udtTypeScript: Script | null): Promise<FiberHeldTlc[]> {
    this.enter("heldTlcs");
    const rec = this.net.invoices.get(paymentHash);
    if (!rec || rec.owner !== this || !rec.heldTlc) return [];
    return sameAssetScript(rec.heldTlcChannelUdt, udtTypeScript) ? [{ ...rec.heldTlc }] : [];
  }

  async hasRemovingTlcs(paymentHash: Hex32): Promise<boolean> {
    this.enter("hasRemovingTlcs");
    const rec = this.net.invoices.get(paymentHash);
    return rec?.owner === this && rec.removingTlc;
  }

  /** A payment of this node that is in flight has a part out; so does one failLeavingPartOut left Failed. */
  async hasOfferedTlcs(paymentHash: Hex32): Promise<boolean> {
    this.enter("hasOfferedTlcs");
    return this.payments.get(paymentHash)?.state === "Inflight" || this.strandedParts.has(paymentHash);
  }

  /** Test helper: the payment reads Failed (one part failed for good) while another part is still out to the payee. */
  failLeavingPartOut(paymentHash: Hex32, failedError = "IncorrectOrUnknownPaymentDetails"): void {
    this.strandedParts.add(paymentHash);
    this.finishPayment(paymentHash, { state: "Failed", failedError });
  }

  /**
   * Test helper: the payee resolves the part failLeavingPartOut left out. Settled, the payment reports the preimage of
   * its successful part and still reads Failed; failed, nothing is out any more.
   */
  resolveStrandedPart(paymentHash: Hex32, outcome: "settle" | "fail"): void {
    if (!this.strandedParts.delete(paymentHash)) return;
    const rec = this.net.invoices.get(paymentHash);
    if (outcome === "settle" && rec?.preimage) {
      rec.state = "Paid";
      this.finishPayment(paymentHash, { preimage: rec.preimage });
    }
  }

  async payInvoice(args: { invoice: string; maxFeeAmount: bigint; tlcExpiryLimitMs: number }): Promise<FiberPaymentStatus> {
    this.enter("payInvoice");
    const p = decodeFake<InvoicePayload>(FAKE_FIBER_PREFIX, args.invoice);
    const existing = this.payments.get(p.hash);
    if (existing && existing.state !== "Failed") return { ...existing };
    if (this.net.behaviorFor(p.hash) === "refuse") return { paymentHash: p.hash, state: "Failed", preimage: null, fee: 0n, failedError: FAKE_SEND_REFUSAL };
    const status: FiberPaymentStatus = { paymentHash: p.hash, state: "Inflight", preimage: null, fee: 0n, failedError: null };
    this.payments.set(p.hash, status);
    const rec = this.net.invoices.get(p.hash);
    const now = this.net.clock.now();
    const fail = (error: string) => this.finishPayment(p.hash, { state: "Failed", failedError: error });

    if (!rec || rec.state !== "Open") fail("IncorrectOrUnknownPaymentDetails");
    else if (rec.payload.expiresAt !== null && now > rec.payload.expiresAt) fail("InvoiceExpired");
    else if (rec.payload.finalExpiryDeltaMs > args.tlcExpiryLimitMs) fail("Failed to build route: expiry limit");
    else if (rec.payload.allowMpp) fail("invalid max_parts, value should be in range [1, 24]");
    else if (rec.hold && this.tlcExpiresTooSoon(now, this.heldTlcExpiry(now, rec, args.tlcExpiryLimitMs))) fail(FAKE_TLC_EXPIRY_TOO_SOON);
    else if (rec.hold) {
      rec.state = "Received";
      rec.payer = this;
      rec.heldTlc = {
        paymentHash: p.hash,
        amount: rec.payload.amount ?? 0n,
        expiresAt: this.heldTlcExpiry(now, rec, args.tlcExpiryLimitMs),
        channelId: this.channels[0]?.channelId ?? "0x00",
        channelOpenedByPeer: this.opensPaymentChannel !== null,
      };
      rec.heldTlcEarlyFailMs = fiberHeldTlcEarlyFailMs(this.paymentChannelDelayEpochs());
      rec.heldTlcChannelUdt = this.paysOverChannelOf === undefined ? rec.payload.udt : this.paysOverChannelOf;
      this.net.notify(p.hash);
    } else {
      const behavior = this.net.behaviorFor(p.hash);
      if (behavior === "fail") fail("Failed to build route");
      else if (behavior === "succeed") this.succeedRegular(rec);
    }
    return { ...this.payments.get(p.hash)! };
  }

  /** The commitment delay of the channel this node pays over: its own choice when it opened it, else fnn's default. */
  private paymentChannelDelayEpochs(): number {
    return this.opensPaymentChannel?.commitmentDelayEpochs ?? FIBER_DEFAULT_COMMITMENT_DELAY_EPOCHS;
  }

  /** The payer's TLC expiry: the invoice's final delta plus one hop delta, capped by its tlc_expiry_limit. */
  private heldTlcExpiry(now: number, rec: InvoiceRecord, tlcExpiryLimitMs: number): number {
    return now + Math.min(rec.payload.finalExpiryDeltaMs + FIBER_DEFAULT_HOP_EXPIRY_DELTA_MS, tlcExpiryLimitMs);
  }

  /** fnn refuses to add a TLC that expires within 2/3 of its channel's commitment delay (the early-fail margin less the check interval). */
  private tlcExpiresTooSoon(now: number, expiresAt: number): boolean {
    return expiresAt < now + fiberHeldTlcEarlyFailMs(this.paymentChannelDelayEpochs()) - FIBER_HELD_TLC_CHECK_INTERVAL_MS;
  }

  private succeedRegular(rec: InvoiceRecord): void {
    rec.state = "Paid";
    this.finishPayment(rec.payload.hash, { state: "Success", preimage: rec.preimage });
  }

  resolveHanging(paymentHash: Hex32, outcome: "succeed" | "fail"): void {
    const pay = this.payments.get(paymentHash);
    if (!pay || pay.state !== "Inflight") return;
    const rec = this.net.invoices.get(paymentHash);
    if (outcome === "succeed" && rec) this.succeedRegular(rec);
    else this.finishPayment(paymentHash, { state: "Failed", failedError: "Failed to build route" });
  }

  finishPayment(paymentHash: Hex32, patch: Partial<FiberPaymentStatus>): void {
    const pay = this.payments.get(paymentHash);
    if (!pay) return;
    Object.assign(pay, patch);
    this.emit(paymentHash);
  }

  async getPayment(paymentHash: Hex32): Promise<FiberPaymentStatus | null> {
    this.enter("getPayment");
    const pay = this.payments.get(paymentHash);
    return pay ? { ...pay } : null;
  }

  async listChannels(): Promise<FiberChannelBalance[]> {
    this.enter("listChannels");
    return this.channels.map(toBalance);
  }

  async listChannelDetails(peer?: string): Promise<FiberChannel[]> {
    this.enter("listChannelDetails");
    const wanted = peer === undefined ? null : toNodeId(peer);
    return this.channels.filter((c) => wanted === null || c.peer === wanted).map((c) => ({ ...c }));
  }

  async isConnected(nodeId: string): Promise<boolean> {
    this.enter("isConnected");
    return this.peers.has(toNodeId(nodeId));
  }

  async openChannel(args: OpenChannelArgs): Promise<{ temporaryChannelId: string }> {
    this.enter("openChannel");
    const peer = toNodeId(args.peer);
    if (!this.peers.has(peer)) throw new Error(FAKE_PEER_NOT_CONNECTED);
    this.openedChannelCount += 1;
    const temporaryChannelId = `0x${this.openedChannelCount.toString(16).padStart(FAKE_CHANNEL_ID_BYTES * 2, "0")}`;
    this.channels.push({
      channelId: temporaryChannelId,
      peer,
      udtTypeScript: args.udtTypeScript,
      ready: false,
      localBalance: args.fundingAmount,
      remoteBalance: 0n,
      status: FIBER_CHANNEL_STATUS.OPENING,
      public: args.public,
      openedByPeer: false,
      awaitingAcceptSince: this.net.clock.now(),
    });
    if (this.loseNextOpenChannelAnswer) {
      this.loseNextOpenChannelAnswer = false;
      throw new HubError("openChannel: simulated timeout", HttpStatus.SERVICE_UNAVAILABLE, API_ERROR_CODE.UPSTREAM_UNAVAILABLE);
    }
    return { temporaryChannelId };
  }

  async offeredTlcs(paymentHash: Hex32): Promise<FiberOfferedTlc[]> {
    this.enter("offeredTlcs");
    // fnn lists offered TLCs of ready channels only: a channel this node force-closed drops out.
    return (this.offered.get(paymentHash) ?? []).filter((tlc) => !this.forceClosedChannels.includes(tlc.channelId));
  }

  /** Test helper: the unresolved TLCs this node offered for the hash (what list_channels' pending_tlcs would show). */
  setOfferedTlcs(paymentHash: Hex32, tlcs: Omit<FiberOfferedTlc, "paymentHash">[]): void {
    this.offered.set(paymentHash, tlcs.map((tlc) => ({ paymentHash, ...tlc })));
  }

  /** Records the call; a known channel reads closing from then on, as fnn's would once the commitment is broadcast. */
  async forceCloseChannel(channelId: string): Promise<void> {
    this.enter("forceCloseChannel");
    this.forceClosedChannels.push(channelId);
    this.channels = this.channels.map((c) => (c.channelId === channelId ? { ...c, ready: false, status: FIBER_CHANNEL_STATUS.CLOSING } : c));
  }

  async abandonChannel(channelId: string): Promise<void> {
    this.enter("abandonChannel");
    const channel = this.channels.find((c) => c.channelId === channelId);
    if (!channel) throw new Error(FAKE_CHANNEL_NOT_FOUND);
    if (channel.status !== FIBER_CHANNEL_STATUS.OPENING) throw new Error(FAKE_CHANNEL_NOT_ABANDONABLE);
    this.channels = this.channels.filter((c) => c !== channel);
  }

  onUpdate(listener: (paymentHash: Hex32) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
