import { LND_ERROR_DETAILS } from "../../../src/common/constants/lnd.constants";
import { FIBER_RPC_ERROR_PATTERN } from "../../../src/common/constants/fiber-rpc.constants";
import { SWAP_DIRECTION } from "../../../src/common/constants/swap.constants";
import { fromHexQuantity, sumOf } from "../../../src/common/utils/amount.util";
import { without0x } from "../../../src/common/utils/hex.util";
import { sameAssetScript } from "../../../src/common/utils/script.util";
import { LEG_NETWORK, type LegNetwork } from "../../../src/domain/swap";
import type { Direction, FiberAsset, Script } from "../../../src/domain/types";
import { createDevnetContext, createFiberNodes, type DevnetContext, type FiberNodes } from "../../../devnet/scripts/lib/context";
import { FNN_INVOICE_STATUS, FNN_PAYMENT_STATUS, LND_INVOICE_STATE, LND_PAYMENT_STATUS } from "../../../devnet/scripts/lib/devnet.constants";
import { resolveHostEndpoints } from "../../../devnet/scripts/lib/endpoints";
import { fromFnnScript, type FnnScript } from "../../../devnet/scripts/lib/fiber";
import { JsonRpcError } from "../../../devnet/scripts/lib/json-rpc";
import type { LndNode } from "../../../devnet/scripts/lib/lnd";
import { ensureLightningSynced } from "../../../devnet/scripts/steps/connectivity.step";

/**
 * The devnet's nodes as the tests use them, through the devnet scripts' own clients (devnet/scripts/lib): lncli inside
 * the LND containers and fnn JSON-RPC. The `*-user` nodes play the user (they also back the hub's demo wallet); the
 * `*-hub` nodes are read only to check what the hub did.
 */
export interface DevnetNodes {
  ctx: DevnetContext;
  lnd: { hub: LndNode; user: LndNode };
  fiber: FiberNodes;
  pubkeys: { lndHub: string; lndUser: string; fnnHub: string; fnnUser: string };
}

/** Connects to the running devnet (see global-setup.ts) and makes sure LND is synced, mining a block if it is not. */
export async function connectDevnet(): Promise<DevnetNodes> {
  const ctx = createDevnetContext();
  const fiber = createFiberNodes(await resolveHostEndpoints(ctx.compose), ctx.settings);
  await ensureLightningSynced(ctx);
  const [lndHub, lndUser, fnnHub, fnnUser] = await Promise.all([
    ctx.lnd.hub.info(),
    ctx.lnd.user.info(),
    fiber.hub.nodeInfo(),
    fiber.user.nodeInfo(),
  ]);
  return {
    ctx,
    lnd: ctx.lnd,
    fiber,
    pubkeys: { lndHub: lndHub.identity_pubkey, lndUser: lndUser.identity_pubkey, fnnHub: fnnHub.pubkey, fnnUser: fnnUser.pubkey },
  };
}

/** Mines regtest blocks (to lnd-hub's wallet), like `npm --prefix devnet run mine -- <blocks>`. */
export async function mineBlocks(nodes: DevnetNodes, blocks: number): Promise<void> {
  await nodes.ctx.bitcoin.mineTo(await nodes.lnd.hub.newAddress(), blocks);
}

/* ------------------------------------------------------------------------------------------- swap legs on nodes */

/** The user's payment of a hold invoice, as the paying node records it. */
export interface PaymentRecord {
  status: string;
  /** Hex without 0x, as the hub writes hashes and preimages; empty or null until the payment succeeded. */
  preimage: string | null;
}

/**
 * One swap direction as the nodes see it, in the nodes' own words (lncli and fnn status names). The hold invoice is
 * the hub's (the leg the user pays); the payout invoice is the user's (the leg the hub pays).
 */
export interface SwapSides {
  /** The hub's hold invoice status, or null when the hub's node has no invoice for the hash. */
  holdInvoiceStatus(paymentHash: string): Promise<string | null>;
  payoutInvoiceStatus(paymentHash: string): Promise<string>;
  /** The user cancels its payout invoice, so the hub's payout cannot succeed any more. */
  cancelPayoutInvoice(paymentHash: string): Promise<void>;
  /** The user's payment of the hold invoice. */
  userPayment(paymentHash: string): Promise<PaymentRecord>;
  /** The preimage the swap's Lightning invoice was settled with: the hub's hold invoice, or the user's payout invoice. */
  lightningInvoicePreimage(paymentHash: string): Promise<string>;
  states: {
    hold: InvoiceStates;
    payout: InvoiceStates;
    payment: { succeeded: string; failed: string };
  };
}

/** One node's invoice statuses by meaning. */
export interface InvoiceStates {
  open: string;
  /** A payment is held (hold invoices). */
  held: string;
  /** Paid and collected: final. */
  settled: string;
  cancelled: string;
  /** Every status of an invoice that holds nothing and can no longer be paid (cancelled or expired). */
  released: readonly string[];
}

const lndInvoiceMissing = (error: unknown): boolean => String(error).includes(LND_ERROR_DETAILS.INVOICE_NOT_FOUND);
const fnnInvoiceMissing = (error: unknown): boolean =>
  error instanceof JsonRpcError && FIBER_RPC_ERROR_PATTERN.INVOICE_NOT_FOUND.test(error.rpcMessage);

async function statusOrNull(read: () => Promise<string>, isMissing: (error: unknown) => boolean): Promise<string | null> {
  try {
    return await read();
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function lndPayment(node: LndNode, paymentHash: string): Promise<PaymentRecord> {
  const payment = await node.findPayment(paymentHash);
  if (!payment) throw new Error(`${node.service} has no payment for ${paymentHash}`);
  return { status: payment.status, preimage: payment.payment_preimage };
}

/** LND cancels an invoice when it expires. */
const LND_INVOICE_STATES: InvoiceStates = {
  open: LND_INVOICE_STATE.OPEN,
  held: LND_INVOICE_STATE.ACCEPTED,
  settled: LND_INVOICE_STATE.SETTLED,
  cancelled: LND_INVOICE_STATE.CANCELED,
  released: [LND_INVOICE_STATE.CANCELED],
};

/** fnn reports an Open invoice past its expiry as Expired. */
const FNN_INVOICE_STATES: InvoiceStates = {
  open: FNN_INVOICE_STATUS.OPEN,
  held: FNN_INVOICE_STATUS.RECEIVED,
  settled: FNN_INVOICE_STATUS.PAID,
  cancelled: FNN_INVOICE_STATUS.CANCELLED,
  released: [FNN_INVOICE_STATUS.CANCELLED, FNN_INVOICE_STATUS.EXPIRED],
};

/** ln_to_fiber: lnd-user pays the hub's hold invoice on lnd-hub; fnn-hub pays the user's invoice on fnn-user. */
function lnToFiberSides({ lnd, fiber }: DevnetNodes): SwapSides {
  return {
    holdInvoiceStatus: (hash) => statusOrNull(async () => (await lnd.hub.lookupInvoice(hash)).state, lndInvoiceMissing),
    payoutInvoiceStatus: async (hash) => (await fiber.user.getInvoice(hash)).status,
    cancelPayoutInvoice: (hash) => fiber.user.cancelInvoice(hash),
    userPayment: (hash) => lndPayment(lnd.user, hash),
    lightningInvoicePreimage: async (hash) => (await lnd.hub.lookupInvoice(hash)).r_preimage,
    states: {
      hold: LND_INVOICE_STATES,
      payout: FNN_INVOICE_STATES,
      payment: { succeeded: LND_PAYMENT_STATUS.SUCCEEDED, failed: LND_PAYMENT_STATUS.FAILED },
    },
  };
}

/** fiber_to_ln: fnn-user pays the hub's hold invoice on fnn-hub; lnd-hub pays the user's invoice on lnd-user. */
function fiberToLnSides({ lnd, fiber }: DevnetNodes): SwapSides {
  return {
    holdInvoiceStatus: (hash) => statusOrNull(async () => (await fiber.hub.getInvoice(hash)).status, fnnInvoiceMissing),
    payoutInvoiceStatus: async (hash) => (await lnd.user.lookupInvoice(hash)).state,
    cancelPayoutInvoice: (hash) => lnd.user.cancelInvoice(hash),
    userPayment: async (hash) => {
      const payment = await fiber.user.getPayment(hash);
      return { status: payment.status, preimage: payment.payment_preimage ? without0x(payment.payment_preimage) : null };
    },
    lightningInvoicePreimage: async (hash) => (await lnd.user.lookupInvoice(hash)).r_preimage,
    states: {
      hold: FNN_INVOICE_STATES,
      payout: LND_INVOICE_STATES,
      payment: { succeeded: FNN_PAYMENT_STATUS.SUCCESS, failed: FNN_PAYMENT_STATUS.FAILED },
    },
  };
}

export const swapSides = (nodes: DevnetNodes, direction: Direction): SwapSides =>
  direction === SWAP_DIRECTION.LN_TO_FIBER ? lnToFiberSides(nodes) : fiberToLnSides(nodes);

/* ---------------------------------------------------------------------------------------------------- balances */

/** What the user holds in its channels with the hub, per network: sats on Lightning, the asset's base units on Fiber. */
export type UserBalances = Record<LegNetwork, bigint>;

const isAssetChannel = (fundingScript: FnnScript | null, asset: FiberAsset): boolean => {
  const script: Script | null = fundingScript ? fromFnnScript(fundingScript) : null;
  return sameAssetScript(script, asset.udtTypeScript);
};

export async function userBalances(nodes: DevnetNodes, asset: FiberAsset): Promise<UserBalances> {
  const [lnChannels, fiberChannels] = await Promise.all([nodes.lnd.user.channels(), nodes.fiber.user.channelsWith(nodes.pubkeys.fnnHub)]);
  return {
    [LEG_NETWORK.LIGHTNING]: sumOf(lnChannels.filter((channel) => channel.remote_pubkey === nodes.pubkeys.lndHub).map((channel) => BigInt(channel.local_balance))),
    [LEG_NETWORK.FIBER]: sumOf(fiberChannels.filter((channel) => isAssetChannel(channel.funding_udt_type_script, asset)).map((channel) => fromHexQuantity(channel.local_balance))),
  };
}
