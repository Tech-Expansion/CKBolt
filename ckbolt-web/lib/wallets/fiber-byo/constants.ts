import type { FiberNetwork } from "@/lib/payment-request";

/**
 * Facts and defaults for "bring your own Fiber node": a visitor's Fiber Studio or fnn on CKB testnet receives a payout
 * (ln_to_fiber) or pays the hub's hold invoice (fiber_to_ln), and the connected CCC wallet funds that node.
 * Sources: ../ckbolt-hub/docs/research/fiber-browser-wallet.md (sections 2.2 and 4) and ../ckbolt-hub/docs/research/fiber-node.md.
 */

/* ---------------------------------------------------------------------------------------------- the node */

/** Where a visitor gets a Fiber node that runs on their own machine. */
export const FIBER_NODE_LINKS = {
  /** Desktop app (Windows, macOS, Linux) that bundles fnn; testnet only. */
  FIBER_STUDIO: "https://github.com/chukwuma619/fiber-studio/releases",
  /** fnn release binaries, Windows included. */
  FNN: "https://github.com/nervosnetwork/fiber/releases",
} as const;

/** Invoice currency per CKB network, as fnn's `new_invoice` takes it. An invoice starts with it in lower case. */
export const FIBER_CURRENCY: Record<FiberNetwork, string> = { mainnet: "Fibb", testnet: "Fibt", devnet: "Fibd" };

/** The CKB network assumed when the hub does not say which one it runs on. */
export const DEFAULT_FIBER_NETWORK: FiberNetwork = "testnet";

/** The hub refuses a longer payout invoice (`CreateSwapBody.payoutInvoice`, max 4,096 characters). */
export const MAX_PAYOUT_INVOICE_LENGTH = 4_096;

/* ------------------------------------------------------------------------------------------- CKB scripts */

/** A CKB script as CCC and the hub write it. */
export interface ScriptParts {
  codeHash: string;
  hashType: "type" | "data" | "data1" | "data2";
  args: string;
}

/** Byte that stands for each hash type in a full-format CKB address (RFC 0021). */
export const HASH_TYPE_BYTE: Record<ScriptParts["hashType"], number> = { data: 0, type: 1, data1: 2, data2: 4 };

/** Code hash of CKB's built-in Type ID script ("TYPE_ID" in ASCII). Cell deps named by type id resolve through it. */
export const TYPE_ID_CODE_HASH = "0x00000000000000000000000000000000000000000000000000545950455f4944";

/** A UDT the connected wallet can send: its type script, and the cell that holds its code, found by its Type ID. */
export interface SendableUdt {
  /** The type script, as fnn's `udt_whitelist` names it. */
  script: ScriptParts;
  /** Args of the Type ID script whose cell holds the UDT's code; a transfer adds that cell as a dep. */
  codeTypeIdArgs: string;
}

/** RUSD on CKB testnet, from fnn v0.9.1's bundled testnet whitelist (`deploy/testnet/fnn/config.yml` in the hub). */
export const TESTNET_RUSD: SendableUdt = {
  script: {
    codeHash: "0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a",
    hashType: "type",
    args: "0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b",
  },
  codeTypeIdArgs: "0x97d30b723c0b2c66e9cb8d4d0df4ab5d7222cbb00d4a9a2055ce2e5d7f0d8b0f",
};

/** Decimals of RUSD (the hub's ASSET_METADATA). */
export const RUSD_DECIMALS = 8;
export const RUSD_SYMBOL = "RUSD";

/* --------------------------------------------------------------------------------------------- funding */

/** CKB counts in shannons: 8 decimals. */
export const CKB_DECIMALS = 8;
export const CKB_SYMBOL = "CKB";

/** Address prefix of CKB testnet; a CCC client on mainnet uses "ckb". */
export const CKB_TESTNET_ADDRESS_PREFIX = "ckt";
export const CKB_MAINNET_ADDRESS_PREFIX = "ckb";

/** Bech32 ends an address's human-readable prefix with the last "1" in it. */
export const BECH32_SEPARATOR = "1";

/**
 * CKB node JSON-RPC error codes the funding transfer reads (ckb/rpc/src/error.rs). A duplicated transaction is already
 * in the node's pool: the transfer went out.
 */
export const CKB_RPC_ERROR_CODE = { POOL_REJECTED_DUPLICATED_TRANSACTION: -1107 } as const;

/** UDT amounts sit in the first 16 bytes of a cell's data, little endian. */
export const UDT_AMOUNT_BYTES = 16;

/** The smallest CKB cell a plain secp256k1 address can hold, so the smallest CKB transfer. */
export const MIN_CKB_CELL_CKB = 61;

/**
 * Figures behind the funding presets (fiber-browser-wallet.md section 2.2, checked on testnet on 2026-10-23):
 * the relay nodes bottle and bracer accept a CKB channel from 499 CKB of funding and add 250 CKB of their own; every
 * side of a channel locks a reserve (99 CKB for CKB, about 180 CKB for a token such as RUSD or cWBTC); the node's funding transaction leaves a
 * change cell of at least 61 CKB; testnet fees are a tiny fraction of a CKB.
 */
export const FIBER_FUNDING = {
  PUBLIC_NODE_MIN_CHANNEL_CKB: 499,
  /** What the relay nodes add to a CKB channel opened to them: the visitor's inbound liquidity. */
  PUBLIC_NODE_CONTRIBUTION_CKB: 250,
  CKB_CHANNEL_RESERVE_CKB: 99,
  UDT_CHANNEL_RESERVE_CKB: 180,
  CHANGE_CELL_CKB: MIN_CKB_CELL_CKB,
  FEE_MARGIN_CKB: 1,
  /** Presets round up to a multiple of this, so they read as round numbers. */
  PRESET_STEP_CKB: 50,
  /** The relay nodes accept an RUSD channel from 20 RUSD (their live minimum is 10). */
  PUBLIC_NODE_MIN_CHANNEL_RUSD: 20,
} as const;

/** CKB testnet explorer, for the funding transaction. */
export const CKB_TESTNET_EXPLORER_URL = "https://testnet.explorer.nervos.org";
export const CKB_EXPLORER_PATH = { TRANSACTION: "transaction" } as const;

/* ------------------------------------------------------------------------------------- fnn's JSON-RPC */

/** Where fnn serves its JSON-RPC unless its config says otherwise (`rpc.listening_addr`). */
export const FNN_DEFAULT_RPC_URL = "http://127.0.0.1:8227";

/**
 * How long a payout invoice made with the command the swap card shows stays valid, in seconds: longer than any quote
 * (a swap quote lasts minutes, a request quote 15), so it outlives the quote even if the command runs a while later.
 */
export const BYO_INVOICE_EXPIRY_SECONDS = 3_600;

/** The description such an invoice carries. Plain words: it goes inside single quotes in a shell command. */
export const BYO_INVOICE_DESCRIPTION = "CKBolt swap payout";
