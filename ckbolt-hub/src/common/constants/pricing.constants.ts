/**
 * Facts and fixed formats of the pricing module. Tunables (fees, caps, TTL, price age) live in HubConfig.pricing.
 */

/** Basis points in one whole: 100 % = 10,000 bps. */
export const BASIS_POINTS_PER_WHOLE = 10_000n;

/** Percent in one whole, for settings given as a percentage (SWAP_MAX_UNPAID_SHARE_PERCENT). */
export const PERCENT_PER_WHOLE = 100;

/**
 * Bounds of REQUEST_QUOTE_TTL_SECONDS, the life of a request quote and of its hold invoice. At least a swap quote's
 * default life (QUOTE_TTL_SECONDS, 180 s): a request is never shorter than a swap. At most 30 minutes: an open request
 * reserves the hub's payout and gives its payer a free option on the price for that long.
 */
export const REQUEST_QUOTE_TTL_MIN_SECONDS = 180;
export const REQUEST_QUOTE_TTL_MAX_SECONDS = 1_800;

/** USD value of one whole unit of a USD-pegged asset (ASSET_USD_RULE `usd_peg`, e.g. RUSD). */
export const USD_PEG_PRICE = 1;

/** Decimal places a USD price keeps when it enters bigint amount maths. */
export const PRICE_SCALE_DECIMALS = 12;

/** `Quote.priceSource` of a median price: "median:coingecko,binance,kucoin". */
export const MEDIAN_PRICE_LABEL = "median";
export const MEDIAN_LABEL_SEPARATOR = ":";
export const PRICE_SOURCE_LIST_SEPARATOR = ",";

/** Prefix of the signed quote message. Binds a signature to CKBolt quotes and to this message format's version. */
export const QUOTE_MESSAGE_PREFIX = "ckbolt-quote-v1:";

/* ------------------------------------------------------------------- Ed25519 (RFC 8032; key encodings RFC 8410) */

export const ED25519_KEY_TYPE = "ed25519";
export const ED25519_SEED_BYTES = 32;
export const ED25519_PUBLIC_KEY_BYTES = 32;
export const ED25519_SIGNATURE_BYTES = 64;
/** DER header of a PKCS#8 Ed25519 private key; the 32-byte seed follows it. */
export const ED25519_PKCS8_SEED_PREFIX_HEX = "302e020100300506032b657004220420";
/** DER header of an SPKI Ed25519 public key; the 32-byte raw key follows it. */
export const ED25519_SPKI_KEY_PREFIX_HEX = "302a300506032b6570032100";
