import type { Script } from "@/lib/hub/contract";
import { MIN_CKB_CELL_CKB } from "@/lib/wallets/fiber-byo/constants";
import { addressToScript, type CkbAddressNetwork } from "./ckb-address";
import { channelsMovingFunds, ckbToShannons } from "./channels";
import type { NodeChannel } from "./node-port";
import { sameScript } from "./scripts";
import { CKB_ADDRESS_PREFIX, CKB_DECIMALS } from "./constants";
import { formatUnits } from "@/lib/hub/format";

/**
 * Getting CKB back from the browser node: where a closing channel's share goes (fnn's shutdown_channel `close_script`),
 * and the withdrawal of the node's on-chain CKB to the visitor's own address, which the page signs with the node's CKB
 * key (./ccc-withdraw.ts). Sentences here are what the node page shows.
 */

/** An address the visitor gave for the node's CKB, as typed: nothing yet, refused with a reason, or its lock script. */
export type CkbDestination = { status: "empty" } | { status: "invalid"; error: string } | { status: "ok"; address: string; script: Script };

export const DESTINATION_ERROR = {
  WRONG_NETWORK: (network: CkbAddressNetwork) =>
    `This address is not on CKB ${network}. Use a CKB ${network} address (${CKB_ADDRESS_PREFIX[network]}1…), like the node's.`,
  OWN_ADDRESS: "This is the node's own address. Paste your wallet's address.",
  NOT_ADDRESS: "This is not a CKB address.",
} as const;

/**
 * Reads a CKB address for the node's CKB: it must be on the node's network, and not the node's own address (`nodeLock`).
 */
export function parseCkbDestination(input: string, network: CkbAddressNetwork, nodeLock: Script | null): CkbDestination {
  const text = input.trim();
  if (!text) return { status: "empty" };
  let parsed: ReturnType<typeof addressToScript>;
  try {
    parsed = addressToScript(text);
  } catch (e) {
    return { status: "invalid", error: e instanceof Error && e.message ? e.message : DESTINATION_ERROR.NOT_ADDRESS };
  }
  if (parsed.network !== network) return { status: "invalid", error: DESTINATION_ERROR.WRONG_NETWORK(network) };
  if (nodeLock && sameScript(parsed.script, nodeLock)) return { status: "invalid", error: DESTINATION_ERROR.OWN_ADDRESS };
  return { status: "ok", address: text, script: parsed.script };
}

/* ------------------------------------------------------------------------------------------- withdrawal */

/** The least the node must hold to withdraw: one plain CKB cell, without the fee. */
export const MIN_WITHDRAW_SHANNONS = ckbToShannons(MIN_CKB_CELL_CKB);

/** Why a withdrawal cannot start now, or null when it can. */
export const WITHDRAW_BLOCK = {
  CHANNELS_MOVING: "A channel is opening or closing. Withdraw once it is done.",
  BALANCE_UNKNOWN: "Reading the node's balance…",
  NOTHING: "The node holds no CKB on chain.",
  TOO_LITTLE: `Too little CKB to withdraw: a CKB cell needs at least ${MIN_CKB_CELL_CKB} CKB.`,
} as const;

/**
 * Whether the node's on-chain CKB can be withdrawn now: not while a channel opens or closes, because fnn may be
 * spending those cells; not before the balance is known; not when it cannot fill one cell.
 */
export function withdrawBlock(balance: bigint | null, channels: readonly Pick<NodeChannel, "state">[]): string | null {
  if (channelsMovingFunds(channels).length > 0) return WITHDRAW_BLOCK.CHANNELS_MOVING;
  if (balance === null) return WITHDRAW_BLOCK.BALANCE_UNKNOWN;
  if (balance === BigInt(0)) return WITHDRAW_BLOCK.NOTHING;
  if (balance <= MIN_WITHDRAW_SHANNONS) return WITHDRAW_BLOCK.TOO_LITTLE;
  return null;
}

export const WITHDRAW_FAILURE = {
  /** A channel started opening or closing: nothing was signed. */
  CHANNELS_MOVING: "channels_moving",
  /** The decrypted key does not sign for the node's address. */
  KEY_MISMATCH: "key_mismatch",
  NOTHING: "nothing",
  TOO_LITTLE: "too_little",
  /** The transaction could not be put together or signed: nothing was sent. */
  BUILD_FAILED: "build_failed",
  /** CKB testnet refused the signed transaction: nothing was sent. */
  REJECTED: "rejected",
  /** Pay's on-chain send: less than a cell of the destination's lock holds. */
  BELOW_CELL: "below_cell",
  /** Pay's on-chain send: the node holds less than the amount and the fee. */
  NOT_ENOUGH: "not_enough",
  /** Pay's on-chain send: what would stay at the node is too little for a cell of its own. */
  NO_CHANGE: "no_change",
  /** Signed, but no answer from CKB testnet: it may or may not have gone out. */
  UNCONFIRMED: "unconfirmed",
  /** A token withdrawal: the node holds none of the token on chain. */
  NO_TOKEN: "no_token",
  /** A token withdrawal: the token's code cell cannot be found, so no transaction can use it. */
  TOKEN_CODE_MISSING: "token_code_missing",
  /** A token withdrawal: too little plain CKB for the new token cell's capacity and the fee. */
  TOKEN_NEEDS_CKB: "token_needs_ckb",
} as const;

export type WithdrawFailure = (typeof WITHDRAW_FAILURE)[keyof typeof WITHDRAW_FAILURE];

/** A withdrawal that did not go out (or may not have), with a sentence for the visitor. */
export class WithdrawError extends Error {
  constructor(
    readonly code: WithdrawFailure,
    message: string,
    /** The signed transaction's hash, when it may have reached CKB testnet. */
    readonly txHash?: string,
  ) {
    super(message);
    this.name = "WithdrawError";
  }
}

/** " (what it said)" for an error with a message, else nothing. */
const errorDetail = (e: unknown): string => (e instanceof Error && e.message ? ` (${e.message})` : "");

export const withdrawErrors = {
  channelsMoving: () => new WithdrawError(WITHDRAW_FAILURE.CHANNELS_MOVING, WITHDRAW_BLOCK.CHANNELS_MOVING),
  keyMismatch: () =>
    new WithdrawError(WITHDRAW_FAILURE.KEY_MISMATCH, "This key does not sign for the node's address, so nothing was sent."),
  nothing: () => new WithdrawError(WITHDRAW_FAILURE.NOTHING, WITHDRAW_BLOCK.NOTHING),
  tooLittle: (minCkb: string) =>
    new WithdrawError(WITHDRAW_FAILURE.TOO_LITTLE, `Too little CKB to withdraw: the new cell needs at least ${minCkb} CKB plus the fee.`),
  belowCell: (minCkb: string) => new WithdrawError(WITHDRAW_FAILURE.BELOW_CELL, SEND_MESSAGE.BELOW_CELL(minCkb)),
  notEnough: () => new WithdrawError(WITHDRAW_FAILURE.NOT_ENOUGH, SEND_MESSAGE.NOT_ENOUGH),
  noChange: () => new WithdrawError(WITHDRAW_FAILURE.NO_CHANGE, SEND_MESSAGE.NO_CHANGE),
  buildFailed: (e: unknown) =>
    new WithdrawError(WITHDRAW_FAILURE.BUILD_FAILED, `The withdrawal could not be prepared on CKB testnet${errorDetail(e)}. Nothing was sent: try again.`),
  rejected: (e: unknown) =>
    new WithdrawError(WITHDRAW_FAILURE.REJECTED, `CKB testnet did not accept the withdrawal${errorDetail(e)}, so nothing was sent. Try again.`),
  noToken: (symbol: string) => new WithdrawError(WITHDRAW_FAILURE.NO_TOKEN, `Your node holds no ${symbol} on chain.`),
  tokenCodeMissing: (symbol: string) =>
    new WithdrawError(WITHDRAW_FAILURE.TOKEN_CODE_MISSING, `The ${symbol} script cannot be found on CKB testnet right now. Nothing was sent: try again later.`),
  tokenNeedsCkb: (symbol: string) =>
    new WithdrawError(
      WITHDRAW_FAILURE.TOKEN_NEEDS_CKB,
      `Your node holds too little CKB on chain for the new ${symbol} cell and the fee. Add some CKB to the node, then try again.`,
    ),
  unconfirmed: (e: unknown, txHash: string) =>
    new WithdrawError(
      WITHDRAW_FAILURE.UNCONFIRMED,
      `The withdrawal was signed, but CKB testnet did not answer${errorDetail(e)}. It may still go through: look it up on the explorer before you try again.`,
      txHash,
    ),
};

/* --------------------------------------------------------------------------------------- Pay: an exact amount */

export const SEND_MESSAGE = {
  BELOW_CELL: (minCkb: string) => `Send at least ${minCkb} CKB: a CKB cell at this address needs it.`,
  OVER_BALANCE: (balanceCkb: string) => `Your node holds ${balanceCkb} CKB on chain. Send less.`,
  NOT_ENOUGH: "Your node holds too little CKB on chain for this and its fee. Send less.",
  NO_CHANGE: `What stays at your node would be under ${MIN_CKB_CELL_CKB} CKB, too little for a cell. Send less, or withdraw it all.`,
} as const;

/** Bytes a plain cell occupies besides its lock's args: capacity (8), the lock's code hash (32) and hash type (1). */
const CELL_BASE_BYTES = 8 + 32 + 1;

/** The least a plain cell with this lock holds, in shannons (one CKB per occupied byte). */
export const minCellShannons = (lock: Pick<Script, "args">): bigint => ckbToShannons(CELL_BASE_BYTES + (lock.args.length - 2) / 2);

const ckbText = (shannons: bigint): string => formatUnits(shannons.toString(), CKB_DECIMALS);

/**
 * Why Pay's on-chain send of `amount` shannons to `to` cannot start now, or null when it can: not while a channel opens
 * or closes (fnn may be spending those cells), not before the balance is known, not below one cell of `to`'s lock, not
 * more than the node holds. The fee and the change are checked when the transaction is built.
 */
export function sendBlock(amount: bigint, to: Pick<Script, "args">, balance: bigint | null, channels: readonly Pick<NodeChannel, "state">[]): string | null {
  if (channelsMovingFunds(channels).length > 0) return WITHDRAW_BLOCK.CHANNELS_MOVING;
  if (balance === null) return WITHDRAW_BLOCK.BALANCE_UNKNOWN;
  const least = minCellShannons(to);
  if (amount < least) return SEND_MESSAGE.BELOW_CELL(ckbText(least));
  if (amount >= balance) return SEND_MESSAGE.OVER_BALANCE(ckbText(balance));
  return null;
}

/** A withdrawal that went out: its hash, what the destination receives and the fee, in shannons. */
export interface WithdrawReceipt {
  txHash: string;
  amount: bigint;
  fee: bigint;
}
