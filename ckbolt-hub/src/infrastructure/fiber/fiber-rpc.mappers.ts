import type {
  FiberChannel,
  FiberChannelBalance,
  FiberChannelStatus,
  FiberHashAlgorithm,
  FiberHeldTlc,
  FiberOfferedTlc,
  FiberInvoiceState,
  FiberInvoiceStatus,
  FiberNodeInfo,
  FiberPaymentState,
  FiberPaymentStatus,
  FiberPort,
  OpenChannelArgs,
  ParsedFiberInvoice,
} from "../../application/ports/fiber.port";
import { FIBER_CHANNEL_STATUS } from "../../common/constants/fiber-node.constants";
import {
  FIBER_CHANNEL_CLOSED_STATE,
  FIBER_CHANNEL_CLOSING_STATE,
  FIBER_CHANNEL_NEGOTIATING_STATE,
  FIBER_CHANNEL_READY_STATE,
  FIBER_DEFAULT_HASH_ALGORITHM,
  FIBER_FEE_RATE_DENOMINATOR,
  FIBER_INVOICE_ATTR,
  FIBER_MPP_FEATURES,
  FIBER_OUTBOUND_TLC_STATE_RESOLVED,
  FIBER_SINGLE_PART_MAX_PARTS,
  FIBER_TLC_DIRECTION_INBOUND,
  FIBER_TLC_DIRECTION_OUTBOUND,
  FIBER_TLC_REMOVAL_STATES,
  FIBER_TLC_STATE_COMMITTED,
} from "../../common/constants/fiber-rpc.constants";
import { FIBER_CURRENCY, FIBER_DEFAULT_MAX_FEE_RATE_PER_MILLE, FIBER_HASH_ALGORITHM_SHA256 } from "../../common/constants/protocol.constants";
import { ceilDiv, fromHexQuantity, maxBigint, toHexQuantity } from "../../common/utils/amount.util";
import { describeError } from "../../common/utils/error.util";
import { canonicalHex, isHex32, toHex32, with0x, without0x } from "../../common/utils/hex.util";
import { decodeMoleculeScript } from "../../common/utils/molecule.util";
import { toNodeId } from "../../common/utils/node-id.util";
import { sameAssetScript } from "../../common/utils/script.util";
import { secondsToMs } from "../../common/utils/time.util";
import type { CkbNetwork, Hex32, Script } from "../../domain/types";
import { FiberRpcResponseError } from "./fiber-rpc.errors";
import {
  rpcScriptSchema,
  storeChangeNotificationSchema,
  type RpcChannel,
  type RpcCkbInvoice,
  type RpcGetInvoiceResult,
  type RpcNewInvoiceParams,
  type RpcNodeInfoResult,
  type RpcOpenChannelParams,
  type RpcPaymentResult,
  type RpcPendingTlc,
  type RpcScript,
  type RpcSendPaymentParams,
} from "./fiber-rpc.schemas";

/** Conversions between the fnn wire format and the FiberPort types. Pure functions; malformed values throw FiberRpcResponseError. */

export type HoldInvoiceArgs = Parameters<FiberPort["createHoldInvoice"]>[0];
export type InvoiceArgs = Parameters<FiberPort["createInvoice"]>[0];
export type PayInvoiceArgs = Parameters<FiberPort["payInvoice"]>[0];

const SCRIPT_HASH_TYPES: readonly Script["hashType"][] = ["type", "data", "data1", "data2"];
const HASH_ALGORITHMS: readonly FiberHashAlgorithm[] = ["sha256", "ckb_hash"];
const INVOICE_STATES: readonly FiberInvoiceState[] = ["Open", "Received", "Paid", "Cancelled", "Expired"];
const PAYMENT_STATES: readonly FiberPaymentState[] = ["Created", "Inflight", "Success", "Failed"];

/** Port states the adapter acts on. */
export const PORT_STATE = {
  PAYMENT_FAILED: "Failed",
  INVOICE_PAID: "Paid",
  INVOICE_CANCELLED: "Cancelled",
} as const satisfies Record<string, FiberPaymentState | FiberInvoiceState>;

/* ------------------------------------------------------------------------------------------------- Scalars */

/** fnn has spelled enums as PascalCase, snake_case and SCREAMING_SNAKE across versions: compare without case or "_". */
const enumKey = (value: string): string => value.replace(/_/g, "").toLowerCase();
const sameEnum = (a: string, b: string): boolean => enumKey(a) === enumKey(b);

function toEnum<T extends string>(value: string, allowed: readonly T[], what: string): T {
  const match = allowed.find((candidate) => sameEnum(candidate, value));
  if (match === undefined) throw new FiberRpcResponseError(`unknown ${what} "${value}"`);
  return match;
}

function converted<T>(field: string, convert: () => T): T {
  try {
    return convert();
  } catch (error) {
    throw new FiberRpcResponseError(`${field}: ${describeError(error)}`);
  }
}

const quantity = (value: string, field: string): bigint => converted(field, () => fromHexQuantity(value));

function quantityAsNumber(value: string, field: string): number {
  const amount = quantity(value, field);
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new FiberRpcResponseError(`${field}: ${value} is too large`);
  return Number(amount);
}

export const toRpcHash = (hash: Hex32): string => with0x(hash);
export const fromRpcHash = (value: string, field: string): Hex32 => converted(field, () => toHex32(value));

/** Public keys as lowercase hex without 0x (fnn writes them without, accepts both). */
export const toPubkey = (value: string): string => toNodeId(value);

export const toRpcScript = (script: Script): RpcScript => ({ code_hash: script.codeHash, hash_type: script.hashType, args: script.args });

export const fromRpcScript = (script: RpcScript): Script => ({
  codeHash: script.code_hash.toLowerCase(),
  hashType: toEnum(script.hash_type, SCRIPT_HASH_TYPES, "script hash_type"),
  args: script.args.toLowerCase(),
});

export function networkFromCurrency(currency: string): CkbNetwork {
  const networks = Object.keys(FIBER_CURRENCY) as CkbNetwork[];
  const network = networks.find((candidate) => FIBER_CURRENCY[candidate].toLowerCase() === currency.toLowerCase());
  if (network === undefined) throw new FiberRpcResponseError(`unknown currency "${currency}"`);
  return network;
}

/* ------------------------------------------------------------------------------------------------ Invoices */

type InvoiceAttributes = ReadonlyMap<string, unknown>;

/** `attrs` is a list of single-key objects; keys are looked up the same way as enum names. */
const invoiceAttributes = (invoice: RpcCkbInvoice): InvoiceAttributes =>
  new Map(invoice.data.attrs.flatMap((attr) => Object.entries(attr)).map(([key, value]) => [enumKey(key), value]));

const attribute = (attrs: InvoiceAttributes, key: string): unknown => attrs.get(enumKey(key)) ?? null;

function stringAttribute(attrs: InvoiceAttributes, key: string): string | null {
  const value = attribute(attrs, key);
  if (value === null) return null;
  if (typeof value !== "string") throw new FiberRpcResponseError(`invoice attribute ${key} is not a string`);
  return value;
}

function numberAttribute(attrs: InvoiceAttributes, key: string): number | null {
  const value = stringAttribute(attrs, key);
  return value === null ? null : quantityAsNumber(value, key);
}

/** The `feature` attribute: a list of feature names; empty when absent. */
function featureAttribute(attrs: InvoiceAttributes): string[] {
  const value = attribute(attrs, FIBER_INVOICE_ATTR.FEATURE);
  if (value === null) return [];
  if (!Array.isArray(value) || !value.every((name) => typeof name === "string")) {
    throw new FiberRpcResponseError(`invoice attribute ${FIBER_INVOICE_ATTR.FEATURE} is not a list of names`);
  }
  return value;
}

const allowsMpp = (features: readonly string[]): boolean => features.some((name) => FIBER_MPP_FEATURES.some((mpp) => sameEnum(name, mpp)));

/** `udt_script` is the 0x hex of a molecule Script; a JSON Script is accepted too. */
function udtScriptAttribute(attrs: InvoiceAttributes): Script | null {
  const value = attribute(attrs, FIBER_INVOICE_ATTR.UDT_SCRIPT);
  if (value === null) return null;
  if (typeof value === "string") return converted(FIBER_INVOICE_ATTR.UDT_SCRIPT, () => decodeMoleculeScript(value));
  const parsed = rpcScriptSchema.safeParse(value);
  if (!parsed.success) throw new FiberRpcResponseError(`invoice attribute ${FIBER_INVOICE_ATTR.UDT_SCRIPT} is not a script`);
  return fromRpcScript(parsed.data);
}

const invoiceAmount = (invoice: RpcCkbInvoice): bigint | null => (invoice.amount ? quantity(invoice.amount, "amount") : null);

export function toParsedInvoice(invoice: RpcCkbInvoice): ParsedFiberInvoice {
  const attrs = invoiceAttributes(invoice);
  const createdAt = quantityAsNumber(invoice.data.timestamp, "timestamp");
  const expirySeconds = numberAttribute(attrs, FIBER_INVOICE_ATTR.EXPIRY_TIME);
  const hashAlgorithm = stringAttribute(attrs, FIBER_INVOICE_ATTR.HASH_ALGORITHM) ?? FIBER_DEFAULT_HASH_ALGORITHM;
  const payee = stringAttribute(attrs, FIBER_INVOICE_ATTR.PAYEE_PUBLIC_KEY);
  return {
    paymentHash: fromRpcHash(invoice.data.payment_hash, "payment_hash"),
    amount: invoiceAmount(invoice),
    network: networkFromCurrency(invoice.currency),
    hashAlgorithm: toEnum(hashAlgorithm, HASH_ALGORITHMS, "hash algorithm"),
    udtTypeScript: udtScriptAttribute(attrs),
    createdAt,
    expiresAt: expirySeconds === null ? null : createdAt + secondsToMs(expirySeconds),
    finalExpiryDeltaMs: numberAttribute(attrs, FIBER_INVOICE_ATTR.FINAL_EXPIRY_DELTA),
    payee: payee === null ? null : toPubkey(payee),
    allowsMpp: allowsMpp(featureAttribute(attrs)),
  };
}

export const toInvoiceStatus = (result: RpcGetInvoiceResult): FiberInvoiceStatus => ({
  paymentHash: fromRpcHash(result.invoice.data.payment_hash, "payment_hash"),
  state: toEnum(result.status, INVOICE_STATES, "invoice status"),
  amount: invoiceAmount(result.invoice) ?? 0n,
});

/** Fields shared by hold and regular invoices: always sha256, so the Lightning leg can use the same hash. */
function invoiceParams(args: Omit<InvoiceArgs, "preimage">, network: CkbNetwork): RpcNewInvoiceParams {
  return {
    amount: toHexQuantity(args.amount),
    currency: FIBER_CURRENCY[network],
    description: args.description,
    hash_algorithm: FIBER_HASH_ALGORITHM_SHA256,
    // Rounded down: an invoice never outlives the validity it was given.
    expiry: toHexQuantity(Math.floor(args.expirySeconds)),
    ...(args.udtTypeScript ? { udt_type_script: toRpcScript(args.udtTypeScript) } : {}),
  };
}

export const toHoldInvoiceParams = (args: HoldInvoiceArgs, network: CkbNetwork): RpcNewInvoiceParams => ({
  ...invoiceParams(args, network),
  payment_hash: toRpcHash(args.paymentHash),
  // Rounded up: the guaranteed hold window is never shorter than asked.
  final_expiry_delta: toHexQuantity(Math.ceil(args.finalExpiryDeltaMs)),
});

export const toRegularInvoiceParams = (args: InvoiceArgs, network: CkbNetwork): RpcNewInvoiceParams => ({
  ...invoiceParams(args, network),
  payment_preimage: toRpcHash(args.preimage),
});

/* ------------------------------------------------------------------------------------------------ Payments */

export const toPaymentStatus = (result: RpcPaymentResult): FiberPaymentStatus => ({
  paymentHash: fromRpcHash(result.payment_hash, "payment_hash"),
  state: toEnum(result.status, PAYMENT_STATES, "payment status"),
  preimage: result.payment_preimage ? fromRpcHash(result.payment_preimage, "payment_preimage") : null,
  fee: result.fee ? quantity(result.fee, "fee") : 0n,
  failedError: result.failed_error ?? null,
});

/** The status of a payment fnn refused to start: nothing is in flight, so it has definitely failed. */
export const refusedPaymentStatus = (paymentHash: Hex32, reason: string): FiberPaymentStatus => ({
  paymentHash,
  state: PORT_STATE.PAYMENT_FAILED,
  preimage: null,
  fee: 0n,
  failedError: reason,
});

/**
 * fnn clamps max_fee_amount to amount x max_fee_rate / 1000 (research 2.2). Returns the smallest rate at which the
 * clamp keeps the whole max_fee_amount, never below fnn's default rate.
 */
export const maxFeeRateFor = (maxFeeAmount: bigint, amount: bigint): bigint =>
  maxBigint(FIBER_DEFAULT_MAX_FEE_RATE_PER_MILLE, ceilDiv(maxFeeAmount * FIBER_FEE_RATE_DENOMINATOR, amount));

export const toSendPaymentParams = (args: PayInvoiceArgs, amount: bigint | null): RpcSendPaymentParams => ({
  invoice: args.invoice,
  max_fee_amount: toHexQuantity(args.maxFeeAmount),
  // Rounded down: the outgoing lock never outlasts the limit the timing policy computed.
  tlc_expiry_limit: toHexQuantity(Math.floor(args.tlcExpiryLimitMs)),
  max_parts: toHexQuantity(FIBER_SINGLE_PART_MAX_PARTS),
  ...(amount ? { max_fee_rate: toHexQuantity(maxFeeRateFor(args.maxFeeAmount, amount)) } : {}),
});

/* ------------------------------------------------------------------------------------------------ Channels */

/** The UDT a channel is funded in; null for a CKB channel. */
const channelUdtScript = (channel: RpcChannel): Script | null =>
  channel.funding_udt_type_script ? fromRpcScript(channel.funding_udt_type_script) : null;

/** A channel that can carry payments: ChannelReady and not disabled. */
const isReadyChannel = (channel: RpcChannel): boolean =>
  sameEnum(channel.state.state_name, FIBER_CHANNEL_READY_STATE) && channel.enabled !== false;

export const toChannelBalance = (channel: RpcChannel): FiberChannelBalance => ({
  channelId: channel.channel_id,
  peer: toPubkey(channel.pubkey),
  udtTypeScript: channelUdtScript(channel),
  ready: isReadyChannel(channel),
  localBalance: quantity(channel.local_balance, "local_balance"),
  remoteBalance: quantity(channel.remote_balance, "remote_balance"),
});

/** fnn's state name -> the hub's channel status; every state before ChannelReady is a channel being opened. */
export function toChannelStatus(stateName: string): FiberChannelStatus {
  if (sameEnum(stateName, FIBER_CHANNEL_READY_STATE)) return FIBER_CHANNEL_STATUS.READY;
  if (sameEnum(stateName, FIBER_CHANNEL_CLOSING_STATE)) return FIBER_CHANNEL_STATUS.CLOSING;
  if (sameEnum(stateName, FIBER_CHANNEL_CLOSED_STATE)) return FIBER_CHANNEL_STATUS.CLOSED;
  return FIBER_CHANNEL_STATUS.OPENING;
}

/**
 * A plain list_channels plus what only `only_pending` lists (fnn v0.9.1 rpc/channel.rs): a channel the node asked a peer
 * to open that the peer has not accepted yet, which fnn keeps only as a channel-opening record (NegotiatingFunding, under
 * the temporary channel id, without its UDT). The pending listing's failed openings (Closed: funding aborted or
 * abandoned) are left out, and a channel in both keeps the plain listing's entry.
 */
export function withPendingChannels(listed: readonly RpcChannel[], pending: readonly RpcChannel[]): RpcChannel[] {
  const listedIds = new Set(listed.map((channel) => canonicalHex(channel.channel_id)));
  const added = pending.filter(
    (channel) =>
      !listedIds.has(canonicalHex(channel.channel_id)) && toChannelStatus(channel.state.state_name) !== FIBER_CHANNEL_STATUS.CLOSED,
  );
  return [...listed, ...added];
}

/**
 * When this node asked for a channel the peer has not accepted yet (a channel it opened, still NegotiatingFunding),
 * from `created_at`; undefined for any other channel, or when fnn does not say when.
 */
function awaitingAcceptSince(channel: RpcChannel): number | undefined {
  const opener = channel.is_acceptor === false;
  if (!opener || !sameEnum(channel.state.state_name, FIBER_CHANNEL_NEGOTIATING_STATE) || channel.created_at === undefined) return undefined;
  return quantityAsNumber(channel.created_at, "created_at");
}

export const toChannelDetails = (channel: RpcChannel): FiberChannel => {
  const since = awaitingAcceptSince(channel);
  return {
    ...toChannelBalance(channel),
    status: toChannelStatus(channel.state.state_name),
    public: channel.is_public === true,
    // Unknown counts as opened by the peer, as for held TLCs: the hub only vouches for channels it knows it opened.
    openedByPeer: channel.is_acceptor !== false,
    ...(since === undefined ? {} : { awaitingAcceptSince: since }),
    ...(sameEnum(channel.state.state_name, FIBER_CHANNEL_NEGOTIATING_STATE) ? { negotiating: true as const } : {}),
  };
};

export const toOpenChannelParams = (args: OpenChannelArgs): RpcOpenChannelParams => ({
  pubkey: toPubkey(args.peer),
  funding_amount: toHexQuantity(args.fundingAmount),
  public: args.public,
  ...(args.udtTypeScript ? { funding_udt_type_script: toRpcScript(args.udtTypeScript) } : {}),
});

/** `{ "Inbound": "Committed" }` -> direction and state; null for any other shape. */
function tlcStatus(status: unknown): { direction: string; state: string } | null {
  if (typeof status !== "object" || status === null) return null;
  const [entry] = Object.entries(status);
  return entry && typeof entry[1] === "string" ? { direction: entry[0], state: entry[1] } : null;
}

/** A TLC this node offered (outbound) whose removal is not acknowledged yet: the payee may still claim it. */
function isUnresolvedOfferedTlc(tlc: RpcPendingTlc): boolean {
  const status = tlcStatus(tlc.status);
  return (
    status !== null &&
    sameEnum(status.direction, FIBER_TLC_DIRECTION_OUTBOUND) &&
    !sameEnum(status.state, FIBER_OUTBOUND_TLC_STATE_RESOLVED)
  );
}

/** A TLC this node received as the final hop (inbound, not forwarded) whose state is one of `states`. */
function isFinalIncomingTlcIn(tlc: RpcPendingTlc, states: readonly string[]): boolean {
  const status = tlcStatus(tlc.status);
  return (
    status !== null &&
    !tlc.forwarding_channel_id &&
    sameEnum(status.direction, FIBER_TLC_DIRECTION_INBOUND) &&
    states.some((state) => sameEnum(status.state, state))
  );
}

/** A TLC this node received as the final hop and still holds: inbound, committed, not forwarded. */
const isHeldIncomingTlc = (tlc: RpcPendingTlc): boolean => isFinalIncomingTlcIn(tlc, [FIBER_TLC_STATE_COMMITTED]);

/** A TLC this node received as the final hop and is removing (fulfilled or failed, not yet acknowledged). */
const isRemovingIncomingTlc = (tlc: RpcPendingTlc): boolean => isFinalIncomingTlcIn(tlc, FIBER_TLC_REMOVAL_STATES);

const isForHash = (tlc: RpcPendingTlc, paymentHash: Hex32): boolean => fromRpcHash(tlc.payment_hash, "payment_hash") === paymentHash;

/**
 * TLCs held for the hash on ready channels funded in the asset `udtTypeScript` (null for CKB). fnn should reject a TLC
 * in another asset than the invoice's, but one it has not rejected yet must not count at its face value.
 */
export const toHeldTlcs = (channels: readonly RpcChannel[], paymentHash: Hex32, udtTypeScript: Script | null): FiberHeldTlc[] =>
  channels
    .filter((channel) => isReadyChannel(channel) && sameAssetScript(channelUdtScript(channel), udtTypeScript))
    .flatMap((channel) =>
      channel.pending_tlcs
        .filter((tlc) => isHeldIncomingTlc(tlc) && isForHash(tlc, paymentHash))
        .map((tlc) => ({
          paymentHash,
          amount: quantity(tlc.amount, "tlc amount"),
          expiresAt: quantityAsNumber(tlc.expiry, "tlc expiry"),
          channelId: channel.channel_id,
          // Unknown counts as opened by the peer: the peer may then have chosen the longest commitment delay.
          channelOpenedByPeer: channel.is_acceptor !== false,
        })),
    );

/** The unresolved TLCs this node offered for the hash on its ready channels (see FiberPort.offeredTlcs). */
export const toOfferedTlcs = (channels: readonly RpcChannel[], paymentHash: Hex32): FiberOfferedTlc[] =>
  channels
    .filter(isReadyChannel)
    .flatMap((channel) =>
      channel.pending_tlcs
        .filter((tlc) => isUnresolvedOfferedTlc(tlc) && isForHash(tlc, paymentHash))
        .map((tlc) => ({
          paymentHash,
          expiresAt: quantityAsNumber(tlc.expiry, "tlc expiry"),
          channelId: channel.channel_id,
          peer: toPubkey(channel.pubkey),
          channelPublic: channel.is_public === true,
          channelOpenedByPeer: channel.is_acceptor !== false,
        })),
    );

/** True when some channel is removing an inbound TLC for the hash (see FiberPort.hasRemovingTlcs). */
export const hasRemovingTlcs = (channels: readonly RpcChannel[], paymentHash: Hex32): boolean =>
  channels.some((channel) => channel.pending_tlcs.some((tlc) => isRemovingIncomingTlc(tlc) && isForHash(tlc, paymentHash)));

/** True when some channel still has an unresolved outbound TLC for the hash (see FiberPort.hasOfferedTlcs). */
export const hasOfferedTlcs = (channels: readonly RpcChannel[], paymentHash: Hex32): boolean =>
  channels.some((channel) => channel.pending_tlcs.some((tlc) => isUnresolvedOfferedTlc(tlc) && isForHash(tlc, paymentHash)));

/* --------------------------------------------------------------------------------------------- Pushes */

/** The payment hash a `store_changes` notification is about; null for any other message or a malformed one. */
export function paymentHashFromStoreChange(message: unknown): Hex32 | null {
  const parsed = storeChangeNotificationSchema.safeParse(message);
  if (!parsed.success) return null;
  const [change] = Object.values(parsed.data.params.result);
  const paymentHash = change ? without0x(change.payment_hash).toLowerCase() : null;
  return paymentHash !== null && isHex32(paymentHash) ? paymentHash : null;
}

/* -------------------------------------------------------------------------------------------------- Node */

/** `network` is the chain the node runs on (ckbNetworkOfChainHash of its `chain_hash`), not the hub's configuration. */
export const toNodeInfo = (info: RpcNodeInfoResult, network: CkbNetwork): FiberNodeInfo => ({
  nodeId: toPubkey(info.pubkey),
  network,
  version: info.version,
});
