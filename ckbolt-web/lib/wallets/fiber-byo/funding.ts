import { encodeBech32, toWords } from "@/lib/bech32";
import { formatUnits, toBaseUnits } from "@/lib/hub/format";
import { validateCkbAddress } from "@/lib/payment-request";
import {
  BECH32_SEPARATOR,
  CKB_DECIMALS,
  CKB_EXPLORER_PATH,
  CKB_MAINNET_ADDRESS_PREFIX,
  CKB_SYMBOL,
  CKB_TESTNET_ADDRESS_PREFIX,
  CKB_TESTNET_EXPLORER_URL,
  FIBER_FUNDING,
  HASH_TYPE_BYTE,
  MIN_CKB_CELL_CKB,
  RUSD_DECIMALS,
  RUSD_SYMBOL,
  TESTNET_RUSD,
  type ScriptParts,
  type SendableUdt,
} from "./constants";

/* ---------------------------------------------------------------------------------------------- tokens */

/** Something the connected wallet can send to a Fiber node: CKB itself, or a UDT. */
export interface FundingToken {
  symbol: string;
  decimals: number;
  /** Null for CKB. */
  udt: SendableUdt | null;
}

export const CKB_FUNDING_TOKEN: FundingToken = { symbol: CKB_SYMBOL, decimals: CKB_DECIMALS, udt: null };

/** Tokens besides CKB that the funding form offers on CKB testnet, when the wallet holds some. */
export const TESTNET_FUNDING_TOKENS: readonly FundingToken[] = [{ symbol: RUSD_SYMBOL, decimals: RUSD_DECIMALS, udt: TESTNET_RUSD }];

/** One transfer from the connected wallet to the node: `units` are base units of `token`. */
export interface FundingTransfer {
  to: string;
  token: FundingToken;
  units: bigint;
}

/* --------------------------------------------------------------------------------------------- presets */

/** A suggested amount, in whole units of the token it names. */
export interface FundingPreset {
  id: string;
  symbol: string;
  amount: number;
  label: string;
  detail: string;
}

const ceilTo = (value: number, step: number): number => Math.ceil(value / step) * step;

/** A CKB amount that covers `lockedCkb` on the node plus its change cell and fees, as a round number. */
export const ckbPresetAmount = (lockedCkb: number): number =>
  ceilTo(lockedCkb + FIBER_FUNDING.CHANGE_CELL_CKB + FIBER_FUNDING.FEE_MARGIN_CKB, FIBER_FUNDING.PRESET_STEP_CKB);

const F = FIBER_FUNDING;

/** What a relay node can pay to a visitor over a CKB channel the visitor opened: its contribution minus its reserve. */
const publicNodeInboundCkb = (): number => F.PUBLIC_NODE_CONTRIBUTION_CKB - F.CKB_CHANNEL_RESERVE_CKB;

/** The amounts the funding form suggests (600, 200 and 250 CKB; 20 RUSD), each with what it is for. */
export const FUNDING_PRESETS: readonly FundingPreset[] = [
  {
    id: "public-channel",
    symbol: CKB_SYMBOL,
    amount: ckbPresetAmount(F.PUBLIC_NODE_MIN_CHANNEL_CKB),
    label: "Open a channel to a public node",
    detail: `${F.PUBLIC_NODE_MIN_CHANNEL_CKB} CKB funds a channel to bottle or bracer, which can then pay you up to ${publicNodeInboundCkb()} CKB over it; the rest covers change and fees.`,
  },
  {
    id: "accept-channel",
    symbol: CKB_SYMBOL,
    amount: ckbPresetAmount(F.CKB_CHANNEL_RESERVE_CKB),
    label: "Accept a CKB channel",
    detail: `Your side's ${F.CKB_CHANNEL_RESERVE_CKB} CKB reserve, plus change and fees, so your node can accept a channel another node opens to it.`,
  },
  {
    id: "rusd-reserve",
    symbol: CKB_SYMBOL,
    amount: ckbPresetAmount(F.UDT_CHANNEL_RESERVE_CKB),
    label: "Reserve for a token channel",
    detail: `About ${F.UDT_CHANNEL_RESERVE_CKB} CKB that a channel in a token (RUSD, cWBTC) locks on your side, plus change and fees.`,
  },
  {
    id: "public-rusd-channel",
    symbol: RUSD_SYMBOL,
    amount: F.PUBLIC_NODE_MIN_CHANNEL_RUSD,
    label: "Open an RUSD channel to a public node",
    detail: `bottle and bracer accept RUSD channels from ${F.PUBLIC_NODE_MIN_CHANNEL_RUSD} RUSD. The node also needs CKB for the channel's reserve.`,
  },
];

export const presetsFor = (presets: readonly FundingPreset[], symbol: string): FundingPreset[] => presets.filter((p) => p.symbol === symbol);

/** Whole units (as typed or preset) to base units of the token; null when that is not a positive amount. */
export function fundingUnits(amount: number | null, decimals: number): bigint | null {
  if (amount === null) return null;
  const units = toBaseUnits(amount, decimals);
  return units === null ? null : BigInt(units);
}

/** "600 CKB": base units with the token's symbol. */
export const formatFunding = (units: bigint, token: Pick<FundingToken, "decimals" | "symbol">): string =>
  `${formatUnits(units.toString(), token.decimals)} ${token.symbol}`;

const MIN_CKB_SHANNONS = BigInt(MIN_CKB_CELL_CKB) * BigInt(10 ** CKB_DECIMALS);

/** Why an amount cannot be sent from a wallet holding `balance` (base units, unknown while read), or null when it can. */
export function checkFundingAmount(units: bigint | null, token: FundingToken, balance: bigint | undefined): string | null {
  if (units === null || units <= BigInt(0)) return "Enter an amount to send.";
  if (token.udt === null && units < MIN_CKB_SHANNONS) return `Send at least ${MIN_CKB_CELL_CKB} CKB: a CKB cell cannot hold less.`;
  if (balance !== undefined && units > balance) {
    return `Your wallet holds ${formatFunding(balance, token)}. Send less, or top the wallet up first.`;
  }
  return null;
}

/* ------------------------------------------------------------------------------------------ the address */

export type CkbNetwork = "mainnet" | "testnet";

/**
 * The CKB network an address names by its prefix (ckb1… or ckt1…), or null when it is not a CKB address, such as the
 * EVM or Bitcoin account of a wallet whose CKB address CCC derives on the network it asked for.
 */
export function ckbAddressNetwork(address: string): CkbNetwork | null {
  const end = address.lastIndexOf(BECH32_SEPARATOR);
  if (end <= 0) return null;
  const prefix = address.slice(0, end).toLowerCase();
  if (prefix === CKB_MAINNET_ADDRESS_PREFIX) return "mainnet";
  return prefix === CKB_TESTNET_ADDRESS_PREFIX ? "testnet" : null;
}

export type FundingTarget = { status: "empty" } | { status: "invalid"; error: string } | { status: "ok"; address: string };

const HEX_32 = /^0x[0-9a-fA-F]{64}$/;
const HEX_BYTES = /^0x([0-9a-fA-F]{2})*$/;
const FULL_FORMAT = 0x00;
const JSON_START = "{";

const hexBytes = (hex: string): number[] => (hex.slice(2).match(/.{2}/g) ?? []).map((b) => parseInt(b, 16));

/** A lock script as a full-format CKB address (RFC 0021, bech32m), on testnet unless another prefix is given. */
export function lockScriptToAddress(script: ScriptParts, prefix: string = CKB_TESTNET_ADDRESS_PREFIX): string {
  const payload = [FULL_FORMAT, ...hexBytes(script.codeHash), HASH_TYPE_BYTE[script.hashType], ...hexBytes(script.args)];
  return encodeBech32(prefix, toWords(payload), "bech32m");
}

/** Reads fnn's `default_funding_lock_script` ({ code_hash, hash_type, args }) as a script, or null. */
export function parseLockScriptJson(text: string): ScriptParts | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { code_hash: codeHash, hash_type: hashType, args } = value as Record<string, unknown>;
  if (typeof codeHash !== "string" || !HEX_32.test(codeHash)) return null;
  if (typeof hashType !== "string" || !Object.hasOwn(HASH_TYPE_BYTE, hashType)) return null;
  if (typeof args !== "string" || !HEX_BYTES.test(args)) return null;
  return { codeHash, hashType: hashType as ScriptParts["hashType"], args };
}

/** Bech32 is case-insensitive, so two spellings of one address compare equal. */
const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * Where the funding goes: a CKB testnet address (ckt1…), or fnn's `default_funding_lock_script` as JSON, which becomes
 * its address. Mainnet addresses and the wallet's own address are refused.
 */
export function parseFundingTarget(input: string, walletAddress?: string): FundingTarget {
  const text = input.trim();
  if (!text) return { status: "empty" };
  let address = text;
  if (text.startsWith(JSON_START)) {
    const script = parseLockScriptJson(text);
    if (!script) return { status: "invalid", error: "This is not a lock script. Paste the node's ckt1… address, or node_info's default_funding_lock_script." };
    address = lockScriptToAddress(script);
  }
  let network: CkbNetwork;
  try {
    network = validateCkbAddress(address);
  } catch (e) {
    return { status: "invalid", error: e instanceof Error ? e.message : "This is not a CKB address." };
  }
  if (network !== "testnet") {
    return { status: "invalid", error: "This is a CKB mainnet address. Fund your node with test CKB: use its testnet address (ckt1…)." };
  }
  if (walletAddress && sameAddress(address, walletAddress)) {
    return { status: "invalid", error: "This is your wallet's own address. Paste the address of your Fiber node." };
  }
  return { status: "ok", address };
}

/* ----------------------------------------------------------------------------------------------- result */

export const explorerTxUrl = (txHash: string): string => `${CKB_TESTNET_EXPLORER_URL}/${CKB_EXPLORER_PATH.TRANSACTION}/${txHash}`;

export const FUNDING_FAILURE = {
  /** The wallet or the address is not on CKB testnet. */
  WRONG_NETWORK: "wrong_network",
  NOT_ENOUGH_CKB: "not_enough_ckb",
  NOT_ENOUGH_TOKEN: "not_enough_token",
  /** The UDT's code cell could not be found on chain. */
  TOKEN_UNAVAILABLE: "token_unavailable",
  /** The visitor refused to sign in the wallet. */
  CANCELLED: "cancelled",
  /** CKB testnet answered that it does not take the signed transfer: nothing went out. */
  REJECTED: "rejected",
  /** The wallet signed, but no answer came from CKB testnet: the transfer may or may not have gone out. */
  UNCONFIRMED: "unconfirmed",
  FAILED: "failed",
} as const;

export type FundingFailure = (typeof FUNDING_FAILURE)[keyof typeof FUNDING_FAILURE];

/** A funding transfer that did not go out (or may not have), with a sentence for the visitor. */
export class FundingError extends Error {
  constructor(
    readonly code: FundingFailure,
    message: string,
    /** The signed transaction's hash, when it may have reached CKB testnet, so the visitor can look it up. */
    readonly txHash?: string,
  ) {
    super(message);
    this.name = "FundingError";
  }
}

/**
 * Wallets report a refusal to sign in their own words; these are the ones CCC's wallets use. Only read on errors the
 * wallet threw while asked to sign: a CKB node's "PoolRejected…" or a closed connection is not the visitor refusing.
 */
const WALLET_REFUSAL_PATTERN = /cancel|reject|denied|declined|(?:popup|window|dialog)\s+(?:was\s+)?closed/i;

/** " (what it said)" for an error with a message, else nothing. */
const errorDetail = (e: unknown): string => (e instanceof Error && e.message ? ` (${e.message})` : "");

/** What the wallet threw when asked to sign, as a sentence: the visitor refusing, or the wallet failing. */
export function walletSigningError(e: unknown): FundingError {
  if (e instanceof FundingError) return e;
  const text = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  if (WALLET_REFUSAL_PATTERN.test(text)) return new FundingError(FUNDING_FAILURE.CANCELLED, "You cancelled in your wallet, so nothing was sent.");
  return new FundingError(FUNDING_FAILURE.FAILED, `Your wallet could not send it${errorDetail(e)}. Try again.`);
}

/** CKB testnet refused the signed transfer, so it did not go out. */
export const chainRejectedError = (e: unknown): FundingError =>
  new FundingError(FUNDING_FAILURE.REJECTED, `CKB testnet did not accept the transfer${errorDetail(e)}, so nothing was sent. Try again.`);

/** The wallet signed, but CKB testnet never answered: the transfer may still go through. */
export const unconfirmedSendError = (e: unknown, txHash: string): FundingError =>
  new FundingError(
    FUNDING_FAILURE.UNCONFIRMED,
    `Your wallet signed the transfer, but CKB testnet did not answer${errorDetail(e)}. It may still go through: look it up on the explorer before you send again.`,
    txHash,
  );

/** The wallet did not say which account it holds, so nothing can be checked or sent. */
export const accountUnreadableError = (e: unknown): FundingError =>
  new FundingError(FUNDING_FAILURE.FAILED, `Your CKB wallet's account could not be read${errorDetail(e)}. Nothing was sent: reconnect the wallet, then try again.`);

/** The transfer could not be put together from what CKB testnet answered about the wallet; nothing was signed. */
export const buildFailedError = (e: unknown): FundingError =>
  new FundingError(FUNDING_FAILURE.FAILED, `The transfer could not be prepared on CKB testnet${errorDetail(e)}. Nothing was sent: try again.`);

/** A sentence for a FundingError, or for an error a wallet threw while asked to sign. */
export const fundingErrorMessage = (e: unknown): string => walletSigningError(e).message;
