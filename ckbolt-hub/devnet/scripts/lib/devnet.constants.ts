/**
 * Facts of the devnet stack: docker-compose.yml, the images it runs and the dev chain spec in devnet/ckb/dev.toml.
 * These are not tunables (those live in settings.ts); change them only together with the file they describe.
 */

/* ------------------------------------------------------------------------------------------ docker compose */

/** Service names in docker-compose.yml. */
export const SERVICE = {
  BITCOIND: "bitcoind",
  LND_HUB: "lnd-hub",
  LND_USER: "lnd-user",
  CKB: "ckb",
  FNN_HUB: "fnn-hub",
  FNN_USER: "fnn-user",
} as const;

export type ServiceName = (typeof SERVICE)[keyof typeof SERVICE];

/** Ports inside the containers. Host ports are whatever compose maps them to (`docker compose port`). */
export const CONTAINER_PORT = {
  LND_GRPC: 10009,
  LND_P2P: 9735,
  CKB_RPC: 8114,
  FNN_RPC: 8227,
} as const;

/** Files the scripts write, relative to devnet/. docker-compose.yml reads FNN_UDT_ENV as an optional env_file. */
export const DEVNET_FILE = {
  STATE_DIR: "state",
  SECRETS_DIR: ".secrets",
  FNN_UDT_ENV: "state/fnn-udt.env",
  /** The Bitcoin tip after the scripts' last mine, so `npm run up` can tell when bitcoind came back below it. */
  BITCOIN_TIP: "state/bitcoin-tip.json",
  HUB_ENV: "hub.env",
} as const;

/** hub.env paths are relative to the hub repository root (the hub's working directory), written like .env.example. */
export const HUB_ROOT_DEVNET_DIR = "devnet";
export const HUB_RELATIVE_PREFIX = "./";

/* ------------------------------------------------------------------------------------- bitcoind and LND */

/** bitcoin-cli inside the bitcoind container; the conf file (compose config `bitcoin-conf`) holds network and auth. */
export const BITCOIN_CLI = ["bitcoin-cli", "-conf=/etc/bitcoin/bitcoin.conf"] as const;

/**
 * Makes bitcoind write its block files, block index and chainstate now (gettxoutsetinfo forces a full flush before it
 * counts) and prints the tip it wrote (`height`, `bestblock`). Bitcoin Core otherwise writes the block index about once
 * an hour, so an unclean Docker stop loses every regtest block mined since, and on regtest nothing downloads them again.
 */
export const BITCOIN_FLUSH_ARGS = ["gettxoutsetinfo", "none"] as const;

/** bitcoind's RPC error (-8) for a height above its tip. */
export const BITCOIN_HEIGHT_OUT_OF_RANGE = "Block height out of range";

/**
 * LND's log line, every LND_WALLET_SYNC_RETRY_SECONDS, while its wallet's synced height is above bitcoind's tip: the
 * wallet asks for a block bitcoind no longer has and gets BITCOIN_HEIGHT_OUT_OF_RANGE. It stays so until the tip passes it.
 */
export const LND_WALLET_AHEAD_LOG = {
  MESSAGE: "Unable to synchronize wallet to chain",
  REASON: BITCOIN_HEIGHT_OUT_OF_RANGE,
} as const;

/** LND tries that wallet sync again this often ("trying again in 5s"). */
export const LND_WALLET_SYNC_RETRY_SECONDS = 5;

/** LND's log line once its wallet has caught up with bitcoind at start-up. */
export const LND_CHAIN_SYNCED_LOG = "Chain backend is fully synced";

/** lncli inside an LND container; the network flag selects the regtest macaroon directory. */
export const LNCLI = ["lncli", "--network=regtest"] as const;

/** Regtest coinbase outputs become spendable after this many confirmations. */
export const COINBASE_MATURITY_BLOCKS = 100;

/** Address type for new LND wallet addresses. */
export const LND_ADDRESS_TYPE = "p2tr";

/** Files inside an LND container. */
export const LND_CONTAINER_FILE = {
  TLS_CERT: "/root/.lnd/tls.cert",
  MACAROON_DIR: "/root/.lnd/data/chain/bitcoin/regtest",
  ADMIN_MACAROON: "admin.macaroon",
} as const;

/**
 * Least-privilege macaroon the hub and the demo wallet use (docs/phase-3-plan.md section 4). onchain:read lets the
 * hub's getBalances read the wallet balance (WalletBalance).
 */
export const HUB_MACAROON_PERMISSIONS = [
  "info:read",
  "invoices:read",
  "invoices:write",
  "offchain:read",
  "offchain:write",
  "onchain:read",
] as const;

/** Names of the macaroons the bootstrap bakes and copies to devnet/.secrets/<service>/. */
export const BAKED_MACAROON = {
  HUB: "hub.macaroon",
  DEMO: "demo.macaroon",
} as const;

export const SECRET_FILE = {
  TLS_CERT: "tls.cert",
  ADMIN_MACAROON: LND_CONTAINER_FILE.ADMIN_MACAROON,
} as const;

/** lnrpc.Invoice.InvoiceState and lnrpc.Payment.PaymentStatus names, as lncli prints them. */
export const LND_INVOICE_STATE = { OPEN: "OPEN", ACCEPTED: "ACCEPTED", SETTLED: "SETTLED", CANCELED: "CANCELED" } as const;
export const LND_PAYMENT_STATUS = { IN_FLIGHT: "IN_FLIGHT", SUCCEEDED: "SUCCEEDED", FAILED: "FAILED" } as const;
/** pendingchannels marks the side that opened a channel this way. */
export const LND_INITIATOR_LOCAL = "INITIATOR_LOCAL";
/** lncli connect reports this when the peer is already connected. */
export const LND_ALREADY_CONNECTED = "already connected";

/* --------------------------------------------------------------------------------------- CKB dev chain */

/**
 * Key whose secp256k1-blake160 lock receives 20 billion CKB in the genesis of devnet/ckb/dev.toml (Fiber v0.9.1's
 * dev chain; its comment names the key). It funds the fnn wallets and issues the RUSD stand-in. Dev only, public.
 */
export const CKB_GENESIS_ISSUER_PRIVATE_KEY = "0xd00c06bfd800d27397002dca6fb0993d5ba6399b4238b2f29ee9deb97593d2bc";

/**
 * Where devnet/ckb/dev.toml puts the system cells. Transaction 0 (the genesis cellbase) holds the cells in the order of
 * `genesis.system_cells` after the genesis cell at output 0; transaction 1 holds the dep groups.
 */
export const CKB_GENESIS = {
  CELLBASE_TX: 0,
  DEP_GROUP_TX: 1,
  /** Outputs of the cellbase transaction. */
  SECP256K1_BLAKE160_CELL: 1,
  NERVOS_DAO_CELL: 2,
  SECP256K1_MULTISIG_CELL: 4,
  XUDT_CELL: 9,
  /** Outputs of the dep group transaction. */
  SECP256K1_BLAKE160_DEP_GROUP: 0,
  SECP256K1_MULTISIG_DEP_GROUP: 1,
} as const;

/** Genesis contracts are referenced by data hash with the CKB2023 VM. */
export const CKB_DATA_HASH_TYPE = "data2" as const;

/** An xUDT cell starts with its amount as a little-endian u128. */
export const XUDT_AMOUNT_BYTES = 16;

/* ---------------------------------------------------------------------------------------------- fnn */

/** fnn node-admin RPC methods the bootstrap needs and the hub does not call. */
export const FNN_ADMIN_METHOD = {
  CONNECT_PEER: "connect_peer",
  LIST_PEERS: "list_peers",
  OPEN_CHANNEL: "open_channel",
  UPDATE_CHANNEL: "update_channel",
} as const;

/** CkbInvoiceStatus and PaymentStatus values of fnn v0.9.1. */
export const FNN_INVOICE_STATUS = { OPEN: "Open", RECEIVED: "Received", PAID: "Paid", CANCELLED: "Cancelled", EXPIRED: "Expired" } as const;
export const FNN_PAYMENT_STATUS = { CREATED: "Created", INFLIGHT: "Inflight", SUCCESS: "Success", FAILED: "Failed" } as const;

/** Each fnn announces `/dns4/<service>/tcp/8228`, which peers on the compose network can dial. */
export const FNN_DIALABLE_ADDRESS_PREFIX = "/dns4/";

/** devnet/fnn/config.yml enables the pubsub RPC module, so the hub may subscribe to store changes (FIBER_PUBSUB). */
export const FNN_PUBSUB_ENABLED = true;

/** Name of the RUSD stand-in in the fnn UDT whitelist (shown in node_info.udt_cfg_infos). */
export const RUSD_UDT_NAME = "RUSD";

/** Env var fnn reads its UDT whitelist from (JSON list of UdtArgInfo), written to DEVNET_FILE.FNN_UDT_ENV. */
export const FNN_UDT_WHITELIST_ENV = "CKB_UDT_WHITELIST";

/** fnn UdtCellDep dep type for a contract cell. */
export const FNN_DEP_TYPE_CODE = "code";
