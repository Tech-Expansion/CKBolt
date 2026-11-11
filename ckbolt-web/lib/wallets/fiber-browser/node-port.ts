import type { Script } from "@/lib/hub/contract";

/**
 * What the app needs from a running Fiber node, in the app's own terms (camelCase, bigint amounts). The fiber-js
 * adapter (./fiber-js-adapter.ts) implements it; so does anything a test injects through it.
 */

export interface BrowserNodeInfo {
  /** Public key, 66 lower-case hex characters, no 0x (the hub contract's form). */
  nodeId: string;
  version: string;
  /** The lock of the node's on-chain wallet: send CKB here to fund it. */
  fundingLockScript: Script;
}

export interface NodeChannel {
  channelId: string;
  /** The other side's node id (normalized). */
  peerId: string;
  /** null for a CKB channel. */
  udtTypeScript: Script | null;
  /** Fiber's state name, such as ChannelReady. */
  state: string;
  isPublic: boolean;
  enabled: boolean;
  /** What this node can send, in the channel asset's base units. */
  localBalance: bigint;
  /** What this node can receive. */
  remoteBalance: bigint;
}

export type NodePaymentStatus = "Created" | "Inflight" | "Success" | "Failed";

export interface NodePayment {
  /** 0x-prefixed. */
  paymentHash: string;
  status: NodePaymentStatus;
  failedError: string | null;
  fee: bigint;
}

export type NodeInvoiceStatus = "Open" | "Cancelled" | "Expired" | "Received" | "Paid";

export interface NewInvoiceArgs {
  amount: bigint;
  currency: "Fibb" | "Fibt" | "Fibd";
  /** 0x-prefixed 32 bytes; the node keeps it and settles the invoice by itself when paid. */
  preimage: string;
  expirySeconds: number;
  description: string;
  udtTypeScript: Script | null;
}

/** A Fiber invoice as the node reads it (parse_invoice). */
export interface ParsedInvoice {
  /** The network its currency names, or null for a currency this app does not know. */
  network: "mainnet" | "testnet" | "devnet" | null;
  /** 0x-prefixed. */
  paymentHash: string;
  /** Base units of its token, or null when it names no amount. */
  amount: bigint | null;
  /** The token it asks for; null for CKB. */
  udtTypeScript: Script | null;
  createdAtMs: number;
  /** When it stops being payable; null when it never expires. */
  expiresAtMs: number | null;
  /** The node it pays (normalized node id), or null when it names none. */
  payee: string | null;
  description: string | null;
  hashAlgorithm: string;
}

/** Limits of one payment. */
export interface SendPaymentOptions {
  /** The most the payment may spend on routing fees, in base units of its token (send_payment `max_fee_amount`). */
  maxFeeAmount?: bigint;
  /**
   * Trampoline routing (send_payment `trampoline_hops`): node ids (normalized) the payment goes through, in order. The
   * node needs a route to the first one only; that node finds the rest. fnn requires `maxFeeAmount` with it.
   */
  trampolineHops?: readonly string[];
  /** send_payment `dry_run`: fnn builds the route and its fee without sending; no payment session is kept. */
  dryRun?: boolean;
}

/**
 * The node's raw node_info and list_channels answers, in fnn's wire form, for the node page's diagnostics
 * (./diagnostics.ts keeps only the fields that are safe to share).
 */
export interface NodeDiagnosticsRaw {
  nodeInfo: Record<string, unknown>;
  channels: Record<string, unknown>[];
  /** Whether list_channels took `include_closed` (closed channels are in `channels`). */
  includesClosed: boolean;
}

export interface OpenChannelArgs {
  /** The connected peer's node id (normalized). */
  peerId: string;
  /** Shannons, or base units of the token. */
  fundingAmount: bigint;
  isPublic: boolean;
  /** The token of the channel; null or absent for CKB. */
  udtTypeScript?: Script | null;
}

/** A channel another node asked this node to open, which waits for this node's accept_channel. */
export interface AcceptChannelArgs {
  /** The opener's temporary channel id (0x-prefixed), as its open_channel answered it. */
  temporaryChannelId: string;
  /** What this node puts in, in shannons, its channel reserve included (accept_channel `funding_amount`). */
  fundingAmount: bigint;
  /**
   * Where this node's share goes when the channel closes (accept_channel `shutdown_script`). Absent: the node's own
   * funding lock, as for the channels it opens; a cooperative close can still send it elsewhere (`close_script`).
   */
  shutdownScript?: Script | null;
}

export interface CreatedInvoice {
  /** The encoded invoice ("fibt1..."). */
  invoice: string;
  /** 0x-prefixed. */
  paymentHash: string;
}

export interface BrowserFiberNode {
  info(): Promise<BrowserNodeInfo>;
  connectPeer(address: string): Promise<void>;
  /** Node ids of the connected peers (normalized). */
  listPeers(): Promise<string[]>;
  openChannel(args: OpenChannelArgs): Promise<{ temporaryChannelId: string }>;
  /**
   * accept_channel: accepts a channel a peer asked to open, putting in `fundingAmount`. fnn answers "No channel with
   * temp id ... found" until the peer's open_channel message has arrived. Resolves with the channel's final id.
   */
  acceptChannel(args: AcceptChannelArgs): Promise<{ channelId: string }>;
  listChannels(): Promise<NodeChannel[]>;
  /**
   * Cooperative close. The node's share goes to `closeScript` (a lock script, such as the visitor's wallet), or to the
   * node's own CKB address without one.
   */
  shutdownChannel(channelId: string, closeScript?: Script | null): Promise<void>;
  newInvoice(args: NewInvoiceArgs): Promise<CreatedInvoice>;
  getInvoiceStatus(paymentHash: string): Promise<NodeInvoiceStatus>;
  /**
   * cancel_invoice: an invoice of this node nobody has paid yet (Open, or Expired) stops being payable; its status reads
   * Cancelled. fnn refuses once a payment for it arrived (Received with its preimage, or Paid) or it is cancelled already.
   */
  cancelInvoice(paymentHash: string): Promise<NodeInvoiceStatus>;
  /** Reads an invoice without paying it. */
  parseInvoice(invoice: string): Promise<ParsedInvoice>;
  sendPayment(invoice: string, options?: SendPaymentOptions): Promise<NodePayment>;
  getPayment(paymentHash: string): Promise<NodePayment>;
  /**
   * node_info and list_channels (closed ones too, where the node allows it), unmapped, for diagnostics. Optional, so a
   * stand-in node need not answer it; the fiber-js adapter does.
   */
  readDiagnostics?(): Promise<NodeDiagnosticsRaw>;
  stop(): Promise<void>;
}
