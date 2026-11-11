import type { BtcNetwork, Hex32 } from "../../domain/types";

/**
 * What the hub needs from a Lightning node. Implemented on LND (src/infrastructure/lightning) and by
 * FakeLightningNode (test/fakes). All amounts are bigint; all hashes Hex32.
 *
 * Errors every implementation keeps to:
 * - "Not found" is not an error: lookups resolve null.
 * - A user-supplied invoice the node cannot use (unreadable, or for a network the node cannot pay) throws a HubError
 *   subclass with code `invoice_invalid` and a plain sentence for the user.
 * - A node that cannot be reached, or a call whose outcome is unknown (connection lost, deadline), throws a HubError with
 *   status 503 and code `upstream_unavailable`: re-read the state before acting on it.
 * - Anything else the node answers unexpectedly throws a plain Error, for the logs.
 * - payInvoice never throws for a payment the node refuses for good (no route can fit the CLTV limit, an unsupported
 *   invoice feature): it resolves FAILED, because nothing was sent.
 */

export interface LnNodeInfo {
  pubkey: string;
  /**
   * The Bitcoin network the node really runs on, from the chain its getinfo names; null for a chain the hub does not
   * know. Not the hub's configuration: the health check compares the two. Every signet reads as signet.
   */
  network: BtcNetwork | null;
  blockHeight: number;
  synced: boolean;
  version: string;
  /** pubkey@host:port for each address the node announces (LND's getinfo `uris`); empty when it announces none. */
  uris: string[];
}

export interface DecodedLnInvoice {
  paymentHash: Hex32;
  /** null for an invoice without an amount. */
  amountMsat: bigint | null;
  /** Network the invoice is for, from its prefix (lnbc, lntb, lntbs, lnbcrt). */
  network: BtcNetwork;
  createdAt: number;
  expiresAt: number;
  /** min_final_cltv_expiry the payee requires, in blocks. */
  cltvExpiry: number;
  destination: string;
  description: string;
}

/** LND invoice states. ACCEPTED = an HTLC set that pays the hold invoice is held. */
export type LnInvoiceState = "OPEN" | "ACCEPTED" | "SETTLED" | "CANCELED";

export interface LnInvoiceStatus {
  paymentHash: Hex32;
  state: LnInvoiceState;
  amountMsat: bigint;
  amountPaidMsat: bigint;
  /** Expiry heights of the HTLCs currently held (ACCEPTED). The earliest one is the deadline. */
  htlcExpiryHeights: number[];
}

export type LnPaymentState = "IN_FLIGHT" | "SUCCEEDED" | "FAILED";

export interface LnPaymentStatus {
  paymentHash: Hex32;
  state: LnPaymentState;
  /** Set once SUCCEEDED. */
  preimage: Hex32 | null;
  feeMsat: bigint;
  /** Set once FAILED: LND's failure reason. Only a FAILED state is terminal; a timeout reason alone is not. */
  failureReason: string | null;
}

export interface LnBalances {
  channelLocalSats: bigint;
  channelRemoteSats: bigint;
  onchainSats: bigint;
}

export interface LightningPort {
  getInfo(): Promise<LnNodeInfo>;
  decodeInvoice(paymentRequest: string): Promise<DecodedLnInvoice>;

  /** Hold invoice: the node accepts HTLCs for `paymentHash` and holds them until settleInvoice or cancelInvoice. */
  createHoldInvoice(args: {
    paymentHash: Hex32;
    amountSats: bigint;
    /** Seconds until an unpaid invoice is cancelled by the node: the quote's remaining validity. */
    expirySeconds: number;
    /** cltv_expiry in blocks: how long an accepted HTLC can be held (minus LND's auto-cancel margin, holdexpirydelta). */
    cltvExpiry: number;
    memo: string;
  }): Promise<{ paymentRequest: string }>;

  /** Regular invoice with a node-generated preimage. Used by the demo wallet and tests, not by swaps. */
  createInvoice(args: { amountSats: bigint; expirySeconds: number; memo: string }): Promise<{ paymentRequest: string; paymentHash: Hex32 }>;

  lookupInvoice(paymentHash: Hex32): Promise<LnInvoiceStatus | null>;
  /** Idempotent: settling an already settled invoice is not an error. */
  settleInvoice(preimage: Hex32): Promise<void>;
  /** Idempotent: cancelling an already cancelled invoice is not an error. */
  cancelInvoice(paymentHash: Hex32): Promise<void>;

  /**
   * Starts paying a BOLT11 invoice and resolves with the first known status (usually IN_FLIGHT).
   * Idempotent per payment hash: if a payment for that hash already exists, returns its status and pays nothing.
   * Resolves FAILED for a permanent refusal (nothing was sent); throws only when the invoice is invalid or the outcome is
   * unknown. The invoice must carry its amount.
   */
  payInvoice(args: { paymentRequest: string; maxFeeSats: bigint; cltvLimit: number; timeoutSeconds: number }): Promise<LnPaymentStatus>;
  /** null when this node never tried to pay that hash. */
  getPayment(paymentHash: Hex32): Promise<LnPaymentStatus | null>;

  getBalances(): Promise<LnBalances>;

  /** Optional push hint: called with a payment hash whenever an invoice or payment for it changes. The engine also polls. */
  onUpdate?(listener: (paymentHash: Hex32) => void): () => void;
}
