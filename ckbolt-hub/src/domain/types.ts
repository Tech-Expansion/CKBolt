/**
 * Shared domain types. Every module speaks these; change them only in the lead's foundation work.
 *
 * Conventions:
 * - Amounts are bigint in base units: sats for Lightning, the asset's base units for Fiber
 *   (shannons for CKB, 10^-decimals of a UDT: 10^-8 for RUSD and cWBTC). Never floats for amounts.
 * - Times are milliseconds since the Unix epoch (number). Bitcoin heights are block numbers.
 * - Hashes and preimages are `Hex32`: 64 lowercase hex characters, no 0x. Adapters convert at the edge.
 */

/** 32 bytes as 64 lowercase hex characters, without 0x. */
export type Hex32 = string;

export type BtcNetwork = "regtest" | "signet" | "testnet" | "testnet4" | "mainnet";
export type CkbNetwork = "devnet" | "testnet" | "mainnet";

/** A CKB script in JSON form; hex fields are 0x-prefixed. */
export interface Script {
  codeHash: string;
  hashType: "type" | "data" | "data1" | "data2";
  args: string;
}

/**
 * An asset on the Fiber side: "CKB", built in, or the id the hub's config gives a UDT (FIBER_ASSETS, or RUSD and CWBTC
 * from the legacy UDT_*_SCRIPT variables). Upper-case letters and digits (ASSET_ID_PATTERN); the asset registry says
 * which ids the hub serves.
 */
export type FiberAssetId = string;

/**
 * How the hub values one whole unit of an asset in USD: CKB at its market price, a USD-pegged UDT (RUSD) at $1, a
 * BTC-pegged UDT (cWBTC) at the BTC price. Only `ckb_market` needs a CKB price.
 */
export type AssetUsdRule = "ckb_market" | "usd_peg" | "btc_parity";

/** A cell a transaction references so a script can run, in CKB's JSON form (hex fields 0x-prefixed, `index` as hex). */
export interface OutPointCellDep {
  outPoint: { txHash: string; index: string };
  depType: "code" | "dep_group";
}

/** fnn's other way to name a cell dep: the live cell whose type script is this type-id script (it follows upgrades). */
export interface TypeIdCellDep {
  typeId: Script;
}

/** A cell dep of a UDT's type script, as fnn's `udt_whitelist` lists them (`cell_dep` or `type_id`). */
export type CellDep = OutPointCellDep | TypeIdCellDep;

export interface FiberAsset {
  id: FiberAssetId;
  symbol: string;
  name: string;
  decimals: number;
  /** null for native CKB. */
  udtTypeScript: Script | null;
  usdRule: AssetUsdRule;
  /** What a Fiber node needs to whitelist the UDT (fnn's `udt_whitelist` cell_deps); empty for CKB, or when not configured. */
  cellDeps: CellDep[];
  /** The name the web app shows for the asset, when config sets one (FIBER_ASSETS `displayName`). */
  displayName?: string;
  /** The icon the web app shows for the asset: an https URL or an inline SVG data URL (FIBER_ASSETS `iconUrl`). */
  iconUrl?: string;
}

/**
 * Which way value moves for the user.
 * - `ln_to_fiber`: the user pays BTC on Lightning and receives a Fiber asset.
 * - `fiber_to_ln`: the user pays a Fiber asset and receives BTC on Lightning.
 */
export type Direction = "ln_to_fiber" | "fiber_to_ln";

/**
 * What a quote is for.
 * - `swap`: the user swaps now (the swap card, Pay); the quote lives QUOTE_TTL_SECONDS.
 * - `request`: a payment request (Get paid) whose Lightning invoice waits for someone else to pay it, so the quote and
 *   its hold invoice live REQUEST_QUOTE_TTL_SECONDS. ln_to_fiber only.
 */
export type QuotePurpose = "swap" | "request";

export interface QuoteRequest {
  direction: Direction;
  asset: FiberAssetId;
  /** Which amount is fixed: what the user pays (incoming leg) or what the user receives (outgoing leg). */
  side: "pay" | "receive";
  /** Base units of that side: sats for the Lightning leg, asset base units for the Fiber leg. */
  amount: bigint;
  /** Absent: a swap quote. */
  purpose?: QuotePurpose;
}

/** A firm quote. For `ln_to_fiber` the user pays `sats` and receives `fiberAmount`; for `fiber_to_ln` the reverse. */
export interface Quote {
  id: string;
  direction: Direction;
  asset: FiberAssetId;
  /** Lightning leg, in sats. */
  sats: bigint;
  /** Fiber leg, in the asset's base units. */
  fiberAmount: bigint;
  /** USD per whole BTC and per whole asset unit used for this quote. */
  btcUsd: number;
  assetUsd: number;
  priceSource: string;
  priceAt: number;
  /** Hub fee plus option premium (plus the request premium on a request quote), in basis points, already applied. */
  feeBps: number;
  /** Sets the quote's lifetime and premium; a swap on a request quote counts toward the per-client cap on requests. */
  purpose: QuotePurpose;
  createdAt: number;
  expiresAt: number;
  /**
   * Hub signature (Ed25519, RFC 8032: 64 bytes as 128 lowercase hex characters) over the UTF-8 bytes of
   * `canonicalQuoteMessage(quote)` (src/domain/pricing/quote-message.ts, the canonical message), and the hub's raw
   * Ed25519 public key (32 bytes as 64 lowercase hex characters).
   */
  signature: string;
  hubPubkey: string;
}

/**
 * Order states, the same machine as Fiber's Cross-Chain Hub:
 * pending -> incoming_accepted -> outgoing_in_flight -> outgoing_succeeded -> succeeded, or failed.
 * `failed` means the incoming leg was (or will be) cancelled and the user refunded, unless a preimage is known.
 */
export type SwapState =
  | "pending"
  | "incoming_accepted"
  | "outgoing_in_flight"
  | "outgoing_succeeded"
  | "succeeded"
  | "failed";

export interface Swap {
  id: string;
  quoteId: string;
  direction: Direction;
  asset: FiberAssetId;
  /** sha256 of the user's preimage; the same on both legs. */
  paymentHash: Hex32;
  sats: bigint;
  fiberAmount: bigint;
  /** Where the hub pays out: the user's Fiber invoice (ln_to_fiber) or the user's BOLT11 invoice (fiber_to_ln). */
  payoutInvoice: string;
  /** The hold invoice the hub issued and the user pays: BOLT11 (ln_to_fiber) or Fiber (fiber_to_ln). */
  holdInvoice: string;
  state: SwapState;
  /** Learned from the outgoing leg only. Saved before the incoming leg is settled. */
  preimage: Hex32 | null;
  failureReason: string | null;
  /**
   * True once the hub has cancelled the incoming hold invoice, so it keeps nothing: a held payment returns to the user.
   * Also true for a swap that was never paid (its hold invoice was cancelled or expired unpaid).
   */
  refunded: boolean;
  /** ln_to_fiber: `cltv_expiry` of the Lightning hold invoice, in blocks. */
  holdCltvExpiry: number | null;
  /** fiber_to_ln: `final_expiry_delta` of the Fiber hold invoice, in ms. */
  holdFinalExpiryDeltaMs: number | null;
  /** Limit used when paying out: `tlc_expiry_limit` in ms (ln_to_fiber) or `cltv_limit` in blocks (fiber_to_ln). */
  payoutLockLimit: number | null;
  quoteExpiresAt: number;
  /**
   * The hash of the cancel token POST /v1/swaps answered with once; the token itself is never kept. Set when the swap is
   * created and never changed. null on a swap made before cancel tokens existed: it cannot be cancelled.
   */
  cancelTokenHash: Hex32 | null;
  /** The payout invoice came from the hub-run demo wallet (which may also pay the hold invoice). */
  demo: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface SwapEvent {
  swapId: string;
  at: number;
  /** Short machine name, e.g. "created", "incoming_accepted", "payout_started", "settled", "cancelled", "error". */
  type: string;
  detail: string;
}
