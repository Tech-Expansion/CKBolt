import type { BtcNetwork, CkbNetwork } from "../../domain/types";

/**
 * Facts of the protocols the hub talks to. These are not tunables: they come from fnn v0.9.1 and LND v0.21.4
 * source (see docs/research). Tunable policy lives in the hub config.
 */

export const MS_PER_SECOND = 1_000;
export const MS_PER_MINUTE = 60 * MS_PER_SECOND;
export const MS_PER_HOUR = 60 * MS_PER_MINUTE;
export const MS_PER_DAY = 24 * MS_PER_HOUR;

export const MSAT_PER_SAT = 1_000n;
/** Digits of a millisatoshi amount below one sat (1 sat = 1,000 msat), to show msat amounts in sats. */
export const MSAT_DECIMALS = 3;
export const SATS_PER_BTC = 100_000_000n;
export const BTC_DECIMALS = 8;

/** A payment preimage is 32 bytes, for BOLT11 and Fiber sha256 invoices alike. */
export const PAYMENT_PREIMAGE_BYTES = 32;

/**
 * Fewest whole seconds an invoice expiry can be. Both nodes take whole seconds and read 0 as "use the default" (24 hours
 * on LND; the `lightning` package also rounds the time left until `expires_at`, so anything shorter becomes 0).
 */
export const MIN_INVOICE_EXPIRY_SECONDS = 1;

/* ----------------------------------------------------------------------------------------- Fiber (fnn v0.9.1) */

/** CKB base units: 1 CKB is 10^8 shannons. */
export const SHANNONS_PER_CKB = 100_000_000n;
/**
 * The part of a CKB channel's funding its opener can never spend: 98 CKB of commitment-cell occupancy plus 1 CKB of
 * shutdown fee (get_funding_and_reserved_amount; docs/research/fiber-node.md, reserve rules). Shannons.
 */
export const FIBER_CKB_CHANNEL_RESERVE_SHANNONS = 99n * SHANNONS_PER_CKB;
/**
 * fnn's default `open_channel_auto_accept_min_ckb_funding_amount`, which fiber-js and Fiber Studio keep: a node accepts
 * a CKB channel a peer opens to it on its own when the opener's usable funding (funding less the reserve) is at least
 * this; a smaller channel waits for an accept_channel call. Shannons.
 */
export const FIBER_DEFAULT_AUTO_ACCEPT_MIN_CKB_SHANNONS = 100n * SHANNONS_PER_CKB;

/** Minimum and default `final_expiry_delta` (MIN_TLC_EXPIRY_DELTA): 1 epoch x 4 h x 2/3 = 160 minutes in release builds. */
export const FIBER_MIN_FINAL_EXPIRY_DELTA_MS = 160 * MS_PER_MINUTE;
/** Maximum `final_expiry_delta` and default `tlc_expiry_limit` (MAX_PAYMENT_TLC_EXPIRY_LIMIT). */
export const FIBER_MAX_TLC_EXPIRY_LIMIT_MS = 14 * MS_PER_DAY;
/** How often fnn checks held TLCs for expiry. */
export const FIBER_HELD_TLC_CHECK_INTERVAL_MS = 60 * MS_PER_SECOND;
/** Length fnn gives one epoch when it turns a channel's commitment delay into time (MILLI_SECONDS_PER_EPOCH, release). */
export const FIBER_EPOCH_MS = 4 * MS_PER_HOUR;
/**
 * A channel's `commitment_delay_epoch` is chosen by whoever opens it. fnn uses 1 epoch when the opener sets none, and
 * accepts 1 to 84 epochs on a channel a peer opens to it (MIN/MAX_COMMITMENT_DELAY_EPOCHS, fee.rs
 * check_open_channel_parameters). list_channels does not report it.
 */
export const FIBER_DEFAULT_COMMITMENT_DELAY_EPOCHS = 1;
export const FIBER_MIN_COMMITMENT_DELAY_EPOCHS = 1;
export const FIBER_MAX_COMMITMENT_DELAY_EPOCHS = 84;
/**
 * fnn fails a held incoming TLC once its expiry is within this share (2/3, tlc_expiry_delay) of its inbound channel's
 * commitment delay, plus one check interval: see fiberHeldTlcEarlyFailMs (common/utils/timing.util.ts).
 */
export const FIBER_HELD_TLC_EARLY_FAIL_SHARE = { numerator: 2, denominator: 3 } as const;
/**
 * The early-fail margin on a channel with the default commitment delay (1 epoch): 2/3 x 4 h, which is
 * MIN_TLC_EXPIRY_DELTA, plus one check interval = 160 minutes + 60 s.
 */
export const FIBER_HELD_TLC_EARLY_FAIL_MS = FIBER_MIN_FINAL_EXPIRY_DELTA_MS + FIBER_HELD_TLC_CHECK_INTERVAL_MS;
/**
 * DEFAULT_FINAL_TLC_EXPIRY_DELTA (fiber-types invoice.rs): the final expiry delta a payer uses for a Fiber invoice that
 * carries no `final_htlc_minimum_expiry_delta` attribute.
 */
export const FIBER_DEFAULT_FINAL_EXPIRY_DELTA_MS = 24 * MS_PER_HOUR;
/** Default per-channel `tlc_expiry_delta` a hop adds. */
export const FIBER_DEFAULT_HOP_EXPIRY_DELTA_MS = 4 * MS_PER_HOUR;
/** Default `max_fee_rate` of send_payment, per thousand; `max_fee_amount` is clamped to amount x rate / 1000. */
export const FIBER_DEFAULT_MAX_FEE_RATE_PER_MILLE = 5n;
export const FIBER_HASH_ALGORITHM_SHA256 = "sha256" as const;

/** Invoice currency by CKB network; the invoice's human-readable prefix is the currency in lower case ("fibt1..."). */
export const FIBER_CURRENCY: Record<CkbNetwork, "Fibb" | "Fibt" | "Fibd"> = {
  mainnet: "Fibb",
  testnet: "Fibt",
  devnet: "Fibd",
};

/**
 * A Fiber node id is its compressed secp256k1 public key: 33 bytes, the first one 02 or 03. fnn writes it as hex without
 * 0x and accepts it with 0x too.
 */
export const FIBER_NODE_ID_PATTERN = /^(0x)?0[23][0-9a-fA-F]{64}$/;

/* --------------------------------------------------------------------------------------------------- Chains */

/**
 * Genesis block hash (fnn `node_info.chain_hash`) of the public CKB networks. A chain with any other genesis is a devnet:
 * each devnet has its own.
 */
export const CKB_GENESIS_HASH: Readonly<Record<Exclude<CkbNetwork, "devnet">, string>> = {
  mainnet: "0x92b197aa1fba0f63633922c61c92375c9c074a93e85963554f5499fe1450d0e5",
  testnet: "0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606",
};
/** The network of a CKB chain whose genesis is not in CKB_GENESIS_HASH. */
export const CKB_OTHER_CHAIN_NETWORK: CkbNetwork = "devnet";

/**
 * Genesis block hash of each Bitcoin network, as block explorers show it. LND's getinfo (the `lightning` package's
 * getWalletInfo `chains`) names its chain by this hash with the byte order reversed. Every signet shares the default
 * signet's genesis, so Mutinynet reads as signet: this tells signet from the other networks, not one signet from another.
 */
export const BTC_GENESIS_HASH: Readonly<Record<BtcNetwork, string>> = {
  mainnet: "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f",
  testnet: "000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943",
  testnet4: "00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043",
  signet: "00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6",
  regtest: "0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206",
};

/* ----------------------------------------------------------------------------------------------- Multiaddrs */

/** A multiaddr is a path of protocol and value segments: "/ip4/203.0.113.7/tcp/8228/ws". */
export const MULTIADDR_SEPARATOR = "/";
/** Protocol segments of a WebSocket multiaddr, the only kind a browser Fiber node (fiber-js) can dial. */
export const MULTIADDR_WEBSOCKET_PROTOCOLS: readonly string[] = ["ws", "wss"];

/* ------------------------------------------------------------------------------------------ LND (v0.21.4) */

/**
 * LND cancels an accepted hold invoice this many blocks before its earliest HTLC expires: `invoices.holdexpirydelta`,
 * 18 by default. The hub plans with HubConfig's value (LND_HOLD_EXPIRY_DELTA_BLOCKS), which must equal lnd.conf.
 */
export const LND_DEFAULT_HOLD_EXPIRY_DELTA_BLOCKS = 18;
/**
 * Smallest `holdexpirydelta` the hub runs with: LND's default, two blocks above the 16-block window in which LND
 * force-closes a channel to claim an HTLC it holds the preimage of (docs/research/lnd.md, LND settings).
 */
export const LND_MIN_HOLD_EXPIRY_DELTA_BLOCKS = LND_DEFAULT_HOLD_EXPIRY_DELTA_BLOCKS;
/** Smallest `cltv_expiry` LND 0.21 accepts on an invoice. */
export const LND_MIN_INVOICE_CLTV_EXPIRY = 24;
/**
 * LND's sender adds this many blocks (routing.BlockPadding) to the final CLTV, so a payment cannot fail when blocks are
 * mined while it is in flight. The padding counts against the payer's `cltv_limit` (docs/research/lnd.md section 2.4).
 */
export const LND_BLOCK_PADDING_BLOCKS = 3;
/**
 * LND refuses a `cltv_limit` that is not above the final CLTV plus that padding (routing.ValidateCLTVLimit: "cltv limit
 * X should be greater than Y"), so the smallest limit it takes is this many blocks above the sum.
 */
export const LND_CLTV_LIMIT_MIN_EXCESS_BLOCKS = 1;
/** CLTV delta an LND node adds to every payment it forwards by default (chainreg.DefaultBitcoinTimeLockDelta). */
export const LND_DEFAULT_TIME_LOCK_DELTA_BLOCKS = 80;
/** The smallest channel LND opens (funding.MinChanFundingSize), sats. */
export const LND_MIN_CHANNEL_FUNDING_SATS = 20_000n;

/**
 * A Lightning node's public key: its compressed secp256k1 key, 33 bytes of hex starting with 02 or 03 (LND writes it in
 * lower case).
 */
export const LN_PUBKEY_PATTERN = /^0[23][0-9a-fA-F]{64}$/;
/** A Lightning node URI as LND's getinfo lists them and wallets take them to add a peer: pubkey@host:port. */
export const LN_NODE_URI_PATTERN = /^0[23][0-9a-fA-F]{64}@[^\s@]+:\d{1,5}$/;

/**
 * CLTV delta a Lightning service provider commonly adds when it forwards (LDK's default; Megalith, the LSP Alby Hub
 * wallets on Mutinynet get their channels from, uses it too).
 */
export const LSP_TIME_LOCK_DELTA_BLOCKS = 144;
/**
 * CLTV blocks LDK's router keeps out of a payer's limit for the random offset it adds to a route's expiry (2 x
 * MEDIAN_HOP_CLTV_EXPIRY_DELTA, 40; rust-lightning routing/router.rs). The hops between an LDK payer (Alby Hub) and the
 * payee therefore get at most 1008 - the invoice's final CLTV - 80 blocks.
 */
export const LDK_SHADOW_ROUTE_RESERVE_BLOCKS = 80;

/** Longest total route CLTV common payers accept: LDK (Alby Hub) 1008, LND and Core Lightning 2016. */
export const PAYER_MAX_CLTV_LDK = 1008;
export const PAYER_MAX_CLTV_LND = 2016;
/** LND refuses a `cltv_limit` above its `max-cltv-expiry` setting, 2016 blocks by default. */
export const LND_MAX_CLTV_LIMIT = PAYER_MAX_CLTV_LND;

/* ------------------------------------------------------------------------------------------------- BOLT 11 */

/** BOLT11 human-readable prefixes by network. Longest first, so "lntbs" is matched before "lntb". */
export const BOLT11_PREFIXES: readonly { prefix: string; network: BtcNetwork }[] = [
  { prefix: "lnbcrt", network: "regtest" },
  { prefix: "lntbs", network: "signet" },
  { prefix: "lntb", network: "testnet" },
  { prefix: "lnbc", network: "mainnet" },
];

/**
 * The invoice networks (as BOLT11_PREFIXES reads them) a node on each Bitcoin network can pay and decode. Testnet3 and
 * testnet4 share the "lntb" prefix, so a testnet4 hub accepts what the prefix calls testnet; signet (Mutinynet) has its
 * own "lntbs".
 */
export const BTC_INVOICE_NETWORKS: Readonly<Record<BtcNetwork, readonly BtcNetwork[]>> = {
  regtest: ["regtest"],
  signet: ["signet"],
  testnet: ["testnet"],
  testnet4: ["testnet"],
  mainnet: ["mainnet"],
};
