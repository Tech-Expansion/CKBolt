/**
 * Facts and defaults of the visitor's Fiber node in the browser (fiber-js on the isolated /app/fiber route), and of the
 * bridge that lets the swap form on /app use it. Values that differ per deployment are read from the environment in
 * ./config.ts. Research: ../ckbolt-hub/docs/research/fiber-browser-wallet.md.
 */

/** The fiber-js release this code is written for; package.json pins it. The hub's fnn must run the same minor (0.9). */
export const FIBER_JS_VERSION = "0.9.1";
/** Download size of fiber-js 0.9.1 (gzip), told to the visitor before the node starts. */
export const FIBER_JS_DOWNLOAD_MB = 7;

/**
 * The CKB network the browser node runs on. CKBolt runs on test networks only, and fiber-js bundles configs for testnet
 * and mainnet only, so a devnet hub cannot be reached from the browser.
 */
export const BROWSER_NODE_NETWORK = "testnet" as const;
export type BrowserNodeNetwork = typeof BROWSER_NODE_NETWORK;

/** First Chrome and Edge version with Document-Isolation-Policy, the isolation that keeps wallet popups working. */
export const DIP_MIN_CHROMIUM_VERSION = 137;

/** fiber-js log level inside its workers. */
export const FIBER_LOG_LEVEL = "info" as const;

/* ------------------------------------------------------------------------------------------------- pages */

/** The isolated page that runs the node (headers in next.config.mjs). */
export const FIBER_NODE_PAGE_PATH = "/app/fiber";
/** The app page, whose swap form uses the node over the bridge. */
export const APP_PAGE_PATH = "/app";
/**
 * The page that funds the node from the visitor's CKB wallet. It is a normal page, not isolated (next.config.mjs), so
 * the CCC wallet popups (JoyID) work there; they do not on the node page.
 */
export const FUND_NODE_PAGE_PATH = "/app/fiber/fund";
/** Query parameter of the funding page with the node's address: /app/fiber/fund?address=<ckt1...>. */
export const FUND_ADDRESS_PARAM = "address";

/* ---------------------------------------------------------------------------------------- browser storage */

/** Prefix of every localStorage and sessionStorage key, and of the Web Lock; the network follows it. */
export const STORAGE_PREFIX = "ckbolt:fiber-browser";
/** Names after `<prefix>:<network>:`. */
export const STORAGE_NAME = {
  /** The encrypted node keys (localStorage). */
  KEYSTORE: "keystore",
  /** Set once the page reloaded itself to get cross-origin isolation (sessionStorage). */
  ISOLATION_RELOAD: "isolation-reload",
  /** The Web Lock held by the one tab that runs the node. */
  NODE_LOCK: "node",
  /** The CKB the node puts into the hub's CKB channel, as the visitor chose it (localStorage). */
  CHANNEL_CONTRIBUTION: "channel-contribution",
  /** The hub's Fiber node id as last read, so it is still known while the hub cannot be reached (localStorage). */
  HUB_NODE_ID: "hub-node-id",
  /** The node's history, per node id after it (localStorage; activity.ts). */
  HISTORY: "history",
} as const;
/** IndexedDB name prefix of fiber-js; the network and a tag of the node key follow, so another key gets its own database. */
export const DATABASE_PREFIX = "/ckbolt-fiber";

/* ------------------------------------------------------------------------------------------------ keys */

/** fiber-js takes two 32-byte secp256k1 secret keys: the P2P identity and the on-chain (CKB) key. */
export const SECRET_KEY_BYTES = 32;
/** secp256k1 group order n: a secret key must be in [1, n - 1]. */
export const SECP256K1_ORDER_HEX = "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141";
/** Tries before giving up on drawing a valid key (one try fails with probability about 2^-128). */
export const KEY_GENERATION_MAX_TRIES = 8;
/** Bytes of sha256(P2P key) that name the node's database. */
export const KEY_TAG_BYTES = 8;
export const PASSWORD_MIN_LENGTH = 8;

/** Version of the stored keystore record. */
export const KEYSTORE_VERSION = 1;
/**
 * scrypt parameters for a new keystore (N = 2^logN). 2^16 x r 8 uses 64 MiB for about a second, next to fiber-js's own
 * 100 MiB of shared buffers; the record stores them, so a later change keeps old records readable.
 */
export const KDF_PARAMS = { logN: 16, r: 8, p: 1 } as const;
/** Largest parameters accepted from a stored or imported record, so a crafted backup cannot freeze the tab. */
export const KDF_LIMITS = { maxLogN: 20, maxR: 16, maxP: 4 } as const;
export const KDF_SALT_BYTES = 16;
/** AES-256-GCM key length, from scrypt. */
export const KDF_KEY_BYTES = 32;
/** scrypt yields to the page this often, in ms, so the page stays responsive. */
export const KDF_ASYNC_TICK_MS = 10;
export const KDF_NAME = "scrypt";
export const CIPHER_NAME = "AES-GCM";
export const CIPHER_IV_BYTES = 12;
/** Suggested file name of an encrypted backup: prefix, network, then the node id's first characters. */
export const BACKUP_FILE_PREFIX = "ckbolt-fiber-node";
export const BACKUP_FILE_NODE_ID_CHARS = 8;
export const BACKUP_FILE_TYPE = "application/json";
export const BACKUP_FILE_EXTENSION = ".json";

/* ------------------------------------------------------------------------------------------- CKB chain */

export const CKB_DECIMALS = 8;
/** Public CKB JSON-RPC (with indexer) the node and the balance reader use, unless the environment names another. */
export const CKB_RPC_DEFAULT_URL: Record<BrowserNodeNetwork, string> = { testnet: "https://testnet.ckbapp.dev/" };
/** Where testers claim testnet CKB by hand, besides funding from their own wallet. */
export const CKB_TESTNET_FAUCET_URL = "https://faucet.nervos.org/";
/** RFC 0021 full address format. */
export const CKB_FULL_ADDRESS_FORMAT = 0x00;
export const CKB_ADDRESS_PREFIX: Record<"mainnet" | "testnet", string> = { mainnet: "ckb", testnet: "ckt" };
export const CKB_HASH_TYPE_BYTE: Record<"data" | "type" | "data1" | "data2", number> = { data: 0, type: 1, data1: 2, data2: 4 };
/** RFC 0021 address formats besides the full one: the short format (code hash index) and the deprecated full ones. */
export const CKB_SHORT_ADDRESS_FORMAT = 0x01;
export const CKB_FULL_DATA_ADDRESS_FORMAT = 0x02;
export const CKB_FULL_TYPE_ADDRESS_FORMAT = 0x04;
/**
 * The locks a short-format address (ckt1qy…) names by its code hash index (RFC 0021): secp256k1-blake160, multisig and
 * anyone-can-pay, all with hash type "type". Old wallets such as Neuron still show these addresses.
 */
export const CKB_SHORT_ADDRESS_LOCKS: Record<"mainnet" | "testnet", readonly string[]> = {
  mainnet: [
    "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8",
    "0x5c5069eb0857efc65e1bca0c07df34c31663b3622fd3876c876320fc9634e2a8",
    "0xd369597ff47f29fbc0d47d2e3775370d1250b85140c670e4718af712983a2354",
  ],
  testnet: [
    "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8",
    "0x5c5069eb0857efc65e1bca0c07df34c31663b3622fd3876c876320fc9634e2a8",
    "0x3419a1c09eb2567f6552ee7a8ecffd64155cffe0f1796e6e61ec088d740c1356",
  ],
};
export const JSON_RPC_VERSION = "2.0";

/* ------------------------------------------------------------------------------------------- channels */

/**
 * CKB every side of a channel locks as its reserve (fnn 0.9.1): 99 for a CKB channel, and for a channel in any token
 * (a UDT: RUSD, cWBTC, any other the hub lists) about 180, the size of the token's cell with room to spare (an xUDT
 * cell such as cWBTC's needs at least 146 CKB; computed from the cell size, not measured). A node that accepts the
 * hub's inbound channel pays its own reserve. Per asset: channelReserveCkb (channel-contribution.ts).
 */
export const CHANNEL_RESERVE_CKB = { CKB: 99, UDT: 180 } as const;
/**
 * CKB the browser node puts into its side when it accepts the hub's CKB channel, unless the visitor chose another amount
 * (channel-contribution.ts). The node accepts that channel itself with accept_channel (hub-accept.ts), so the amount is
 * picked per request and never needs a restart. The hub opens the channel, so the hub knows its safety delay and takes
 * payments over it; with its own CKB in it the node can pay a swap from CKB to BTC at once, before it ever receives.
 * Spendable: this minus the reserve.
 */
export const NODE_CHANNEL_CONTRIBUTION_CKB = 1_200;
/** Least the visitor may choose to put in: the 99 CKB reserve plus about a hundred to pay with. */
export const MIN_CHANNEL_CONTRIBUTION_CKB = 200;
/** On-chain fee room the node keeps on top of what it puts into a channel. */
export const CHANNEL_FEE_MARGIN_CKB = 1;
/**
 * Fiber channel state names (list_channels `state.state_name`). Every state but READY and CLOSED is a channel opening or
 * closing, whose funding or closing transaction is not final yet: fnn may be spending the node's on-chain cells for it.
 */
export const CHANNEL_STATE = {
  READY: "ChannelReady",
  AWAITING_READY: "AwaitingChannelReady",
  SHUTTING_DOWN: "ShuttingDown",
  CLOSED: "Closed",
} as const;
/** How each Fiber channel state reads on the page; states not listed read "Opening". */
export const CHANNEL_STATE_LABEL: Record<string, string> = {
  [CHANNEL_STATE.READY]: "Ready",
  [CHANNEL_STATE.AWAITING_READY]: "Waiting for confirmations",
  [CHANNEL_STATE.SHUTTING_DOWN]: "Closing",
  [CHANNEL_STATE.CLOSED]: "Closed",
};
export const CHANNEL_STATE_OPENING_LABEL = "Opening";

/* ------------------------------------------------------------------------------------- invoices, payments */

/** Fiber invoice currency by network; an invoice starts with it in lower case ("fibt1..."). */
export const FIBER_CURRENCY = { mainnet: "Fibb", testnet: "Fibt", devnet: "Fibd" } as const;
/** Both legs of a swap share one SHA-256 hash, so the node's invoices use it (Fiber's default is ckb_hash). */
export const FIBER_HASH_ALGORITHM = "sha256" as const;
export const PREIMAGE_BYTES = 32;
/**
 * A payout invoice stays valid this long after the quote expires, as the hub's demo wallet does
 * (DEMO_PAYOUT_INVOICE_EXTRA_SECONDS), so the hub can still pay it once your payment arrives.
 */
export const INVOICE_EXTRA_SECONDS = 3_600;
/** Shortest validity of an invoice, in seconds, even for a quote about to expire. */
export const INVOICE_MIN_EXPIRY_SECONDS = 60;
export const INVOICE_DESCRIPTION = "CKBolt swap payout";
/** get_invoice statuses after which an invoice needs nothing more from the node. */
export const INVOICE_FINAL_STATUSES: readonly string[] = ["Paid", "Cancelled", "Expired"];
/** get_invoice's status of an invoice nobody has paid yet. */
export const INVOICE_STATUS_OPEN = "Open";
/** get_invoice's status of an invoice paid in full. */
export const INVOICE_STATUS_PAID = "Paid";
/** get_payment statuses of a finished payment. */
export const PAYMENT_STATUS = { SUCCESS: "Success", FAILED: "Failed" } as const;
/** send_payment's first status: the payment session exists, nothing has been routed yet. */
export const PAYMENT_STATUS_CREATED = "Created";

/* ------------------------------------------------------------------------- Pay: a Fiber invoice, CKB on chain */

/**
 * Attribute keys of an invoice as parse_invoice returns it (fnn 0.9.1 writes them in snake_case; fiber-js's typings in
 * PascalCase), compared without case or "_".
 */
export const FIBER_INVOICE_ATTR = {
  /** u64 hex, seconds after `data.timestamp` (ms). Absent: the invoice never expires. */
  EXPIRY_TIME: "expiry_time",
  DESCRIPTION: "description",
  /** 0x hex of a molecule-encoded CKB Script: the token the invoice asks for. Absent: CKB. */
  UDT_SCRIPT: "udt_script",
  PAYEE_PUBLIC_KEY: "payee_public_key",
  HASH_ALGORITHM: "hash_algorithm",
} as const;
/** Fiber's hash algorithm when an invoice names none. */
export const FIBER_DEFAULT_HASH_ALGORITHM = "ckb_hash";
/**
 * The most a Fiber payment from Pay may spend on routing fees, per thousand of its amount: fnn 0.9.1's own default
 * `max_fee_rate` (5, 0.5 %), which also caps `max_fee_amount`. The node passes the amount it shows, so what the visitor
 * confirms is what fnn enforces.
 */
export const PAY_MAX_FEE_PER_THOUSAND = 5;
export const PER_THOUSAND = 1_000;
/** Longest invoice note the node shows when it asks the visitor to confirm a payment; longer ones are cut. */
export const PAY_NOTE_MAX_CHARS = 140;
/** Longest CKB address the bridge carries (a full-format address with long args is about 100 characters). */
export const MAX_CKB_ADDRESS_LENGTH = 256;

/* -------------------------------------------------------------------- Get paid: the node's Fiber invoice */

/** A Fiber invoice the node makes for Get paid on /app stays payable this long (a merchant waits minutes, not seconds). */
export const RECEIVE_INVOICE_EXPIRY_SECONDS = 3_600;
/** Longest note the node writes into an invoice it makes for Get paid. */
export const INVOICE_NOTE_MAX_LENGTH = 100;
/** The invoice's description when the visitor wrote no note. */
export const REQUEST_INVOICE_DESCRIPTION = "CKBolt request";

/* ------------------------------------------------------------------------------------------ activity */

/** The most activity entries kept per node (the newest). */
export const MAX_HISTORY_ENTRIES = 200;
/** Entries Home shows under History. */
export const RECENT_HISTORY_ENTRIES = 5;

/** Least CKB a channel the node opens with another node is funded with: more than its 99 CKB reserve. */
export const PEER_CHANNEL_MIN_CKB = CHANNEL_RESERVE_CKB.CKB + 1;
/**
 * Waiting for a peer the node dialled: fnn lists it in list_peers about half a second after connect_peer, and
 * open_channel needs the peer's Init first. The hub's deploy kit waits the same way before it opens a channel.
 */
export const PEER_CONNECT_TIMING = {
  /** list_peers is asked this often until the peer shows. */
  pollMs: 500,
  /** Longest wait for the peer, then the visitor is told. */
  timeoutMs: 15_000,
} as const;

/**
 * fnn's `auto_accept_channel_ckb_funding_amount` in the browser node's config (node-config.ts): 0 turns automatic
 * acceptance of CKB channels off (fnn v0.9.1 network.rs), so the node accepts the hub's CKB channel with accept_channel
 * and the amount the visitor chose. UDT channels (RUSD, cWBTC) are still accepted automatically by fnn's UDT whitelist
 * (the hub's entries, udt-whitelist.ts), with nothing from the node. A CKB channel another node opens now waits for an accept_channel the app does not send; fnn
 * drops it when that node disconnects.
 */
export const NODE_AUTO_ACCEPT_CKB_FUNDING_SHANNONS = BigInt(0);
/**
 * Accepting the hub's CKB channel (hub-accept.ts): the hub answers its open_channel call before its open_channel message
 * has reached the browser node, so accept_channel can say "No channel with temp id ... found" for a moment. It is tried
 * again after each of these waits, then the visitor is told (about 20 seconds in all).
 */
export const HUB_ACCEPT_RETRY_DELAYS_MS: readonly number[] = [250, 500, 1_000, 2_000, 4_000, 4_000, 4_000, 4_000];
/**
 * Several channels from the hub in one press (hub-channel-rows.ts) are asked for one after another, and the next waits
 * until no channel of the node is still being funded: fnn 0.9.1 keeps the cells of a funding transaction out of the next
 * one until it is committed (its live-cells exclusion map), and the change of the first only becomes a live cell then, so
 * a node funded by one transfer would have nothing left to fund the next channel's reserve with. fnn calls a channel
 * ready after 4 confirmations (CKB_TX_TRACING_CONFIRMATIONS), about 40 s on testnet. `appearMs`: how long the hub's open
 * of a token channel may take to reach the node after the hub answered; `waitMs`: the longest wait, after which the run
 * asks for no more channels (the funding still pending would make the next one fail).
 */
export const HUB_RUN_TIMING = { pollMs: 3_000, appearMs: 20_000, waitMs: 240_000 } as const;

/* --------------------------------------------------------------------------------------------- timings */

export const NODE_TIMING = {
  /** Channels, peers and invoice and payment states are read this often while the node runs. */
  nodePollMs: 5_000,
  /** The node's on-chain balance is read this often from the CKB RPC. */
  balancePollMs: 15_000,
  /** The CKB RPC must answer within this. */
  rpcTimeoutMs: 10_000,
} as const;

/* ---------------------------------------------------------------------------------------------- bridge */

/** BroadcastChannel between /app (the swap form) and /app/fiber (the node); same origin only. */
export const BRIDGE_CHANNEL_NAME = `${STORAGE_PREFIX}:bridge`;
/** Messages carry it; a tab ignores other versions. */
export const BRIDGE_PROTOCOL_VERSION = 1;
export const BRIDGE_TIMING = {
  /** A status request collects answers this long, then keeps the best one (only one tab runs the node). */
  statusWindowMs: 800,
  /**
   * After an empty window, a late answer (a busy or hidden tab, measured up to 3 s under load) still counts until this
   * long after the request; it stays under statusRefreshMs, so the next request is not overtaken.
   */
  statusLateMs: 4_500,
  /** The swap form asks again this often whether a node tab is open. */
  statusRefreshMs: 5_000,
  /**
   * Status windows in a row without an answer before the swap form forgets the node. A busy or hidden tab can miss
   * one window (800 ms); forgetting it at once would flash "Open your Fiber node" and send the card's button to Home.
   */
  missesBeforeGone: 2,
  /** The node must answer an invoice request within this. */
  invoiceTimeoutMs: 30_000,
  /** The node must answer a payment request (checks, then send_payment) within this. */
  paymentTimeoutMs: 60_000,
  /** Pay: the node must answer a read of a Fiber invoice, or of a payment's status, within this. */
  readTimeoutMs: 15_000,
  /**
   * Pay: how long the node waits for the visitor to confirm a payment or an on-chain send in the node before it declines
   * by itself. The page waits this plus the time the node may take to send (paymentTimeoutMs).
   */
  confirmTimeoutMs: 120_000,
} as const;
