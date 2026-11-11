import type {
  DecodePaymentRequestResult,
  GetChannelBalanceResult,
  GetInvoiceResult,
  GetPaymentResult,
  GetWalletInfoResult,
  SubscribeToPayViaRequestFailedEvent,
} from "lightning";
import type {
  DecodedLnInvoice,
  LnBalances,
  LnInvoiceState,
  LnInvoiceStatus,
  LnNodeInfo,
  LnPaymentStatus,
} from "../../application/ports/lightning.port";
import { BOLT11_DEFAULT_MIN_FINAL_CLTV_EXPIRY, LND_PAYMENT_FAILURE_REASON } from "../../common/constants/lnd.constants";
import { MSAT_PER_SAT } from "../../common/constants/protocol.constants";
import { toHex32 } from "../../common/utils/hex.util";
import type { BtcNetwork, Hex32 } from "../../domain/types";

/**
 * Pure mapping from `lightning` package results to LightningPort types. Amounts become bigint msat or sats, hashes and
 * preimages Hex32, dates epoch milliseconds.
 */

/** decodePaymentRequest also returns `created_at`, which the package's typings leave out. */
type DecodedPaymentRequest = DecodePaymentRequestResult & { created_at?: string };

/** getInvoice also returns the invoiced `mtokens`, which the package's typings leave out. */
type LookedUpInvoice = GetInvoiceResult & { mtokens?: string };

/** The failure flags of a failed payment; LND's CANCELED reason arrives as `is_canceled`. */
export type PaymentFailureFlags = Partial<
  Pick<SubscribeToPayViaRequestFailedEvent, "is_canceled" | "is_insufficient_balance" | "is_invalid_payment" | "is_pathfinding_timeout" | "is_route_not_found">
>;

/** What a settled payment reports: its preimage and the routing fee paid. */
export interface SettledPayment {
  secret: string;
  fee_mtokens: string;
}

const FAILURE_REASON_BY_FLAG: readonly (readonly [keyof PaymentFailureFlags, string])[] = [
  ["is_invalid_payment", LND_PAYMENT_FAILURE_REASON.INCORRECT_PAYMENT_DETAILS],
  ["is_insufficient_balance", LND_PAYMENT_FAILURE_REASON.INSUFFICIENT_BALANCE],
  ["is_route_not_found", LND_PAYMENT_FAILURE_REASON.NO_ROUTE],
  ["is_pathfinding_timeout", LND_PAYMENT_FAILURE_REASON.TIMEOUT],
  ["is_canceled", LND_PAYMENT_FAILURE_REASON.CANCELED],
];

function isoToMs(value: string | undefined, field: string): number {
  const ms = value === undefined ? Number.NaN : Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`LND sent an unreadable ${field}: ${value}`);
  return ms;
}

/** A zero amount means the invoice leaves the amount to the payer. */
const amountMsatOrNull = (mtokens: string): bigint | null => {
  const amount = BigInt(mtokens);
  return amount > 0n ? amount : null;
};

/** `network` is the one the node names (btcNetworkOfChainIds of its `chains`), not the hub's configuration. */
export const toNodeInfo = (info: GetWalletInfoResult, network: BtcNetwork | null): LnNodeInfo => ({
  pubkey: info.public_key,
  network,
  blockHeight: info.current_block_height,
  synced: info.is_synced_to_chain,
  version: info.version,
  uris: [...(info.uris ?? [])],
});

/** `network` comes from the invoice's own prefix: LND only decodes invoices of its network. */
export const toDecodedInvoice = (decoded: DecodedPaymentRequest, network: BtcNetwork): DecodedLnInvoice => ({
  paymentHash: toHex32(decoded.id),
  amountMsat: amountMsatOrNull(decoded.mtokens),
  network,
  createdAt: isoToMs(decoded.created_at, "invoice creation date"),
  expiresAt: isoToMs(decoded.expires_at, "invoice expiry date"),
  cltvExpiry: decoded.cltv_delta ?? BOLT11_DEFAULT_MIN_FINAL_CLTV_EXPIRY,
  destination: decoded.destination,
  description: decoded.description ?? "",
});

export function invoiceStateOf(invoice: Pick<GetInvoiceResult, "is_confirmed" | "is_held" | "is_canceled">): LnInvoiceState {
  if (invoice.is_confirmed) return "SETTLED";
  if (invoice.is_canceled) return "CANCELED";
  if (invoice.is_held) return "ACCEPTED";
  return "OPEN";
}

export const toInvoiceStatus = (invoice: LookedUpInvoice): LnInvoiceStatus => ({
  paymentHash: toHex32(invoice.id),
  state: invoiceStateOf(invoice),
  amountMsat: invoice.mtokens === undefined ? BigInt(invoice.tokens) * MSAT_PER_SAT : BigInt(invoice.mtokens),
  amountPaidMsat: BigInt(invoice.received_mtokens),
  htlcExpiryHeights: invoice.payments.filter((htlc) => htlc.is_held).map((htlc) => htlc.timeout),
});

export const failureReasonOf = (flags: PaymentFailureFlags): string =>
  FAILURE_REASON_BY_FLAG.find(([flag]) => flags[flag])?.[1] ?? LND_PAYMENT_FAILURE_REASON.ERROR;

export const inFlightPayment = (paymentHash: Hex32): LnPaymentStatus => ({
  paymentHash,
  state: "IN_FLIGHT",
  preimage: null,
  feeMsat: 0n,
  failureReason: null,
});

export const succeededPayment = (paymentHash: Hex32, settled: SettledPayment): LnPaymentStatus => ({
  paymentHash,
  state: "SUCCEEDED",
  preimage: toHex32(settled.secret),
  feeMsat: BigInt(settled.fee_mtokens),
  failureReason: null,
});

export const failedPayment = (paymentHash: Hex32, failureReason: string): LnPaymentStatus => ({
  paymentHash,
  state: "FAILED",
  preimage: null,
  feeMsat: 0n,
  failureReason,
});

export function toPaymentStatus(result: GetPaymentResult, paymentHash: Hex32): LnPaymentStatus {
  if (result.is_confirmed && result.payment) return succeededPayment(paymentHash, result.payment);
  if (result.is_failed) return failedPayment(paymentHash, failureReasonOf(result.failed ?? {}));
  return inFlightPayment(paymentHash);
}

export const toBalances = (channels: GetChannelBalanceResult, onchainSats: bigint): LnBalances => ({
  channelLocalSats: BigInt(channels.channel_balance),
  channelRemoteSats: BigInt(channels.inbound ?? 0),
  onchainSats,
});
