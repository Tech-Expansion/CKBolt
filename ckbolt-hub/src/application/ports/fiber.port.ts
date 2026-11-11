import type { FIBER_CHANNEL_STATUS } from "../../common/constants/fiber-node.constants";
import type { CkbNetwork, Hex32, Script } from "../../domain/types";

/**
 * What the hub needs from a Fiber node (fnn v0.9.1+). Implemented over JSON-RPC (src/infrastructure/fiber) and by
 * FakeFiberNode (test/fakes). See docs/research/fiber-node.md for the RPC semantics each method maps to.
 *
 * Errors every implementation keeps to:
 * - "Not found" is not an error: lookups resolve null.
 * - A user-supplied invoice the node cannot parse throws a HubError subclass with code `invoice_invalid` and a plain
 *   sentence for the user.
 * - A node that cannot be reached, a call whose outcome is unknown (network, timeout) or an answer the hub cannot read
 *   throws a HubError with status 503 and code `upstream_unavailable`: re-read the state before acting on it.
 * - A JSON-RPC error the node answers with throws a plain Error, for the logs.
 * - payInvoice never throws for a payment the node refuses to start: it resolves Failed, because nothing was sent.
 */

export interface FiberNodeInfo {
  nodeId: string;
  /**
   * The CKB network the node really runs on, from its chain (node_info `chain_hash`): mainnet or testnet by genesis hash,
   * devnet for any other chain. Not the hub's configuration: the health check compares the two.
   */
  network: CkbNetwork;
  version: string;
}

export type FiberHashAlgorithm = "sha256" | "ckb_hash";

export interface ParsedFiberInvoice {
  paymentHash: Hex32;
  /** Base units of the asset (shannons for CKB). null if the invoice has no amount. */
  amount: bigint | null;
  network: CkbNetwork;
  hashAlgorithm: FiberHashAlgorithm;
  /** null for a CKB invoice. */
  udtTypeScript: Script | null;
  createdAt: number;
  /** null when the invoice never expires. */
  expiresAt: number | null;
  /** final_htlc_minimum_expiry_delta in ms, null if absent. */
  finalExpiryDeltaMs: number | null;
  payee: string | null;
  /** The invoice lets a payer split the payment into parts (made with `allow_mpp`: a basic MPP feature is set). */
  allowsMpp: boolean;
}

/** `Expired` is only reported for an Open invoice past its expiry. `Received` = a held TLC set pays the hold invoice. */
export type FiberInvoiceState = "Open" | "Received" | "Paid" | "Cancelled" | "Expired";

export interface FiberInvoiceStatus {
  paymentHash: Hex32;
  state: FiberInvoiceState;
  amount: bigint;
}

export type FiberPaymentState = "Created" | "Inflight" | "Success" | "Failed";

export interface FiberPaymentStatus {
  paymentHash: Hex32;
  state: FiberPaymentState;
  /** Set once Success (fnn v0.9.0+ returns payment_preimage). */
  preimage: Hex32 | null;
  fee: bigint;
  failedError: string | null;
}

/** A TLC this node has received and still holds for a payment hash. */
export interface FiberHeldTlc {
  paymentHash: Hex32;
  amount: bigint;
  /**
   * Absolute expiry, ms. fnn fails a held TLC 2/3 of its channel's commitment delay + 60 s before this: 160 minutes +
   * 60 s on a channel with the default delay, up to 224 hours + 60 s on one a peer opened with the maximum.
   */
  expiresAt: number;
  channelId: string;
  /**
   * The channel the TLC arrived on was opened by the peer (list_channels `is_acceptor`), so the peer chose its
   * commitment delay; true as well when the node does not say. false: this node opened it with its own delay.
   */
  channelOpenedByPeer: boolean;
}

/** A TLC this node offered (sent) for a payment hash and that is not resolved yet, with what the hub needs of its channel. */
export interface FiberOfferedTlc {
  paymentHash: Hex32;
  /** Absolute expiry, ms. */
  expiresAt: number;
  channelId: string;
  /** The channel's peer: the TLC's next hop (the payee itself on a private channel). */
  peer: string;
  /** Announced to the network. A private channel pays only its own peer. */
  channelPublic: boolean;
  /** As FiberHeldTlc.channelOpenedByPeer: the peer chose the commitment delay; true when the node does not say. */
  channelOpenedByPeer: boolean;
}

export interface FiberChannelBalance {
  channelId: string;
  peer: string;
  /** null for a CKB channel. */
  udtTypeScript: Script | null;
  ready: boolean;
  localBalance: bigint;
  remoteBalance: bigint;
}

/** Where a channel is in its life: every state fnn goes through before ChannelReady is `opening`. */
export type FiberChannelStatus = (typeof FIBER_CHANNEL_STATUS)[keyof typeof FIBER_CHANNEL_STATUS];

/** A channel in any state, with who opened it: what the hub needs to manage the channels it opens to other nodes. */
export interface FiberChannel extends FiberChannelBalance {
  status: FiberChannelStatus;
  /** Announced to the network (open_channel `public`). Unknown counts as private. */
  public: boolean;
  /** The peer opened (and funded) the channel (list_channels `is_acceptor`); true as well when the node does not say. */
  openedByPeer: boolean;
  /**
   * Set only on a channel this node asked the peer to open that the peer has not accepted yet: when it asked, in ms
   * since the epoch (list_channels `created_at`). Nothing is funded until the peer accepts.
   */
  awaitingAcceptSince?: number;
  /**
   * fnn is still negotiating the channel's funding (NegotiatingFunding): nothing is funded or locked yet. For a channel
   * a peer asked to open, this includes a request this node has not accepted yet (fnn v0.9.1 lists such requests with
   * `only_pending`, `is_acceptor` true). Absent for every later state.
   */
  negotiating?: true;
}

/** A channel this node opens to a peer, funded from the node's own wallet. */
export interface OpenChannelArgs {
  /** The peer's node id; the peer must be connected to this node. */
  peer: string;
  /** Base units of the asset: shannons for CKB (fnn's channel reserve included), the UDT's base units otherwise. */
  fundingAmount: bigint;
  /** null for a CKB channel. */
  udtTypeScript: Script | null;
  /** Announce the channel to the network. A channel only for payments between the two nodes stays private. */
  public: boolean;
}

export interface FiberPort {
  getInfo(): Promise<FiberNodeInfo>;
  parseInvoice(invoice: string): Promise<ParsedFiberInvoice>;

  /** Hold invoice: `new_invoice` with payment_hash and hash_algorithm sha256. */
  createHoldInvoice(args: {
    paymentHash: Hex32;
    amount: bigint;
    udtTypeScript: Script | null;
    /** Seconds until an unpaid invoice expires: the quote's remaining validity. */
    expirySeconds: number;
    /** final_expiry_delta in ms (minimum 160 minutes in release fnn). */
    finalExpiryDeltaMs: number;
    description: string;
  }): Promise<{ invoice: string }>;

  /** Regular sha256 invoice with a known preimage. Used by the demo wallet and tests, not by swaps. */
  createInvoice(args: {
    preimage: Hex32;
    amount: bigint;
    udtTypeScript: Script | null;
    expirySeconds: number;
    description: string;
  }): Promise<{ invoice: string; paymentHash: Hex32 }>;

  getInvoice(paymentHash: Hex32): Promise<FiberInvoiceStatus | null>;
  /** Idempotent on an already settled invoice. Only valid while Received. */
  settleInvoice(paymentHash: Hex32, preimage: Hex32): Promise<void>;
  /** Idempotent on an already cancelled invoice. Fails once a preimage is stored. */
  cancelInvoice(paymentHash: Hex32): Promise<void>;
  /**
   * TLCs held for this hash right now (from list_channels pending_tlcs) on ready channels in the given asset
   * (`udtTypeScript`, null for CKB). A `Received` invoice whose TLC timed out still says Received, so the hub must check
   * this before relying on a hold. A TLC on a channel of another asset is never counted, whatever its amount: the
   * invoice's asset is what the hub was promised.
   */
  heldTlcs(paymentHash: Hex32, udtTypeScript: Script | null): Promise<FiberHeldTlc[]>;
  /**
   * True while the node is removing an inbound TLC for this hash (settling it with the preimage, or failing it back)
   * and the peer has not acknowledged it yet. Right after settleInvoice the invoice still says Received with nothing
   * held: the outcome (Paid, or a payment that is gone) is known only once nothing is being removed.
   */
  hasRemovingTlcs(paymentHash: Hex32): Promise<boolean>;
  /**
   * True while any channel still has a TLC this node offered for this hash whose removal is not acknowledged yet (a
   * payment part it sent that the payee may still claim). A payment can read Failed while such a part is out.
   */
  hasOfferedTlcs(paymentHash: Hex32): Promise<boolean>;
  /** The unresolved TLCs this node offered for the hash, on its ready channels. */
  offeredTlcs(paymentHash: Hex32): Promise<FiberOfferedTlc[]>;

  /**
   * Starts paying an invoice in a single part; resolves with the first status. Idempotent per payment hash (see
   * send_payment). Resolves Failed when fnn refuses to start the payment (nothing was sent), which it does for an
   * invoice that allows MPP; throws only when the invoice cannot be parsed or the outcome is unknown. The invoice must
   * carry its amount.
   */
  payInvoice(args: { invoice: string; maxFeeAmount: bigint; tlcExpiryLimitMs: number }): Promise<FiberPaymentStatus>;
  /** null when this node never tried to pay that hash. */
  getPayment(paymentHash: Hex32): Promise<FiberPaymentStatus | null>;

  listChannels(): Promise<FiberChannelBalance[]>;

  /**
   * Every channel that is not closed, ready or still opening (one the peer has not accepted yet included, under its
   * temporary id), with its status and who opened it (list_channels); only the channels with `peer` when it is given.
   */
  listChannelDetails(peer?: string): Promise<FiberChannel[]>;

  /** True while the node has a live connection with `nodeId` (list_peers): only then can it open a channel to it. */
  isConnected(nodeId: string): Promise<boolean>;

  /**
   * Starts opening a channel to a connected peer (open_channel) and resolves with fnn's temporary channel id once the node
   * has begun; the channel then shows in listChannelDetails as `opening`, under its final id once the peer accepts. The
   * hub's own channels keep fnn's default commitment delay. A refusal the node answers with (the peer is not connected,
   * a UDT the node does not accept) throws a plain Error and opened nothing; an unknown outcome throws a 503
   * `upstream_unavailable` HubError (the channel may be opening).
   */
  openChannel(args: OpenChannelArgs): Promise<{ temporaryChannelId: string }>;

  /**
   * Gives up a channel that is not funded yet (abandon_channel), such as one the peer never accepted: it stops showing in
   * listChannelDetails. fnn refuses a channel whose funding is signed or confirmed; that refusal throws.
   */
  abandonChannel(channelId: string): Promise<void>;
  /**
   * shutdown_channel with `force`: closes a ready channel on chain with this node's latest commitment, whatever the peer
   * does. Its pending TLCs are then settled on chain once the channel's commitment delay has passed (fnn's watchtower).
   */
  forceCloseChannel(channelId: string): Promise<void>;

  /** Optional push hint (subscribe_store_changes). The engine also polls. */
  onUpdate?(listener: (paymentHash: Hex32) => void): () => void;
}
