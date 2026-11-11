/**
 * Facts of the deploy kit (deploy/testnet: its compose files, images and file layout) and of the public test networks
 * it joins. These are not tunables: the scripts' settings live in settings.ts (DEPLOY_* variables, deploy.env.example),
 * and the network facts below are only their defaults. Protocol facts shared with the hub come from src/common.
 */

/* ------------------------------------------------------------------------------------------------- the kit */

/** Compose project name (`name:` in docker-compose.yml): the running Mutinynet sync uses it too. */
export const COMPOSE_PROJECT = "ckbolt-testnet";

/** Service names in docker-compose.yml. */
export const SERVICE = {
  BITCOIND: "bitcoind",
  LND_HUB: "lnd-hub",
  LND_DEMO: "lnd-demo",
  FNN_HUB: "fnn-hub",
  FNN_DEMO: "fnn-demo",
  HUB: "hub",
} as const;

export type ServiceName = (typeof SERVICE)[keyof typeof SERVICE];
export type LndService = typeof SERVICE.LND_HUB | typeof SERVICE.LND_DEMO;
export type FnnService = typeof SERVICE.FNN_HUB | typeof SERVICE.FNN_DEMO;
/** The kit's LND and fnn nodes: the hub's first, then the demo wallet's (profile `demo`). */
export const LND_SERVICES: readonly LndService[] = [SERVICE.LND_HUB, SERVICE.LND_DEMO];
export const FNN_SERVICES: readonly FnnService[] = [SERVICE.FNN_HUB, SERVICE.FNN_DEMO];

/** The compose profile that runs the demo wallet's nodes. */
export const DEMO_PROFILE = "demo";

/** The bitcoind data volume (`bitcoind` in docker-compose.yml) and where the container mounts it. */
export const BITCOIND_VOLUME = `${COMPOSE_PROJECT}_bitcoind`;
export const BITCOIND_DATA_DIR = "/data";

/** Files and folders of the kit, relative to the kit directory (deploy/testnet here, DEPLOY_REMOTE_DIR on the server). */
export const KIT_FILE = {
  ENV: ".env",
  ENV_EXAMPLE: ".env.example",
  HUB_ENV: "hub.env",
  HUB_ENV_EXAMPLE: "hub.env.example",
  COMPOSE: "docker-compose.yml",
  SECRETS_DIR: "secrets",
  /** LND wallet unlock passwords (mounted into LND) and the seeds `testnet wallet` saves. */
  WALLET_SECRETS_DIR: "secrets/wallet",
  /** What the hub may read (mounted read-only at /secrets): TLS certificates and least-privilege macaroons. */
  HUB_SECRETS_DIR: "secrets/hub",
  /** The hub source the images build from (HUB_BUILD_CONTEXT, FNN_BUILD_CONTEXT in .env). */
  SOURCE_DIR: "src",
  LND_INIT_WALLET_SCRIPT: "lnd/init-wallet.sh",
  /** fnn's configs with the generated udt_whitelist; only add_token.py writes them on the server. */
  FNN_WHITELIST_FILES: ["fnn/hub.yml", "fnn/demo.yml"],
  /** Where `testnet sync` puts the repo's FNN_WHITELIST_FILES (same relative paths), the templates add_token.py reads. */
  SYNC_TEMPLATES_DIR: ".sync-templates",
} as const;

/**
 * testnet/add_token.py, run with Python 3 in the kit folder on the server (docs/add-token.md). `testnet sync` runs it
 * with REGENERATE_ARGS after each upload, so fnn's whitelists follow the server's hub.env, which is never uploaded.
 */
export const ADD_TOKEN = {
  PYTHON: "python3",
  SCRIPT: "add_token.py",
  /** Regenerate fnn/hub.yml and fnn/demo.yml from hub.env's FIBER_ASSETS, restart only the fnn whose file changed. */
  REGENERATE_ARGS: ["--regenerate", "--apply", "--template-dir", KIT_FILE.SYNC_TEMPLATES_DIR],
  /** Its failure when the hub image predates the whitelist generator (node cannot load it): the image needs a build. */
  GENERATOR_MISSING: /Cannot find module[^\n]*fnn-whitelist/,
  /** Its refusal of a hub.env still on the legacy asset variables: the uploaded whitelists are then the ones to use. */
  NO_FIBER_ASSETS: /hub\.env has no FIBER_ASSETS/,
} as const;

/** The exit code of a POSIX shell for a command it cannot find (python3 not installed). */
export const SHELL_COMMAND_NOT_FOUND_EXIT_CODE = 127;

/** Suffix of a file being written, renamed into place once complete. */
export const PENDING_FILE_SUFFIX = ".pending";
/** Suffix of the folder a new source upload is unpacked into before it replaces the old one. */
export const INCOMING_DIR_SUFFIX = ".incoming";

/** Owner-only modes for secrets on the server. */
export const SECRET_FILE_MODE = "600";
export const SECRET_DIR_MODE = "700";

/** The hub image runs as the `node` user (uid and gid 1000), which must be able to read secrets/hub. */
export const HUB_CONTAINER_UID = 1000;
export const HUB_CONTAINER_PORT = 8787;

/* ------------------------------------------------------------------------------------------------ syncing */

/** Names never uploaded, wherever they appear: settings with secrets, wallets, build output and dependencies. */
export const SYNC_EXCLUDED_NAMES: readonly string[] = [".env", "hub.env", "deploy.env", "secrets", "data", "node_modules", "dist", ".git", "__pycache__", "backups"];
/** Never uploaded either: seed files and files being written. */
export const SYNC_EXCLUDED_SUFFIXES: readonly string[] = [".seed", PENDING_FILE_SUFFIX];

/** What the image builds need from the hub repository (paths relative to its root), uploaded to KIT_FILE.SOURCE_DIR. */
export const HUB_SOURCE_PATHS: readonly string[] = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.build.json",
  "nest-cli.json",
  "src",
  "deploy/testnet/hub",
  "devnet/fnn",
];

/** Files that run in Linux containers or shells: uploaded with LF line endings whatever the Windows checkout has. */
export const LF_ONLY_FILE_PATTERN = /(\.sh|\.py|\.ya?ml|\.conf|\.example|(^|\/)Dockerfile[^/]*)$/;

/* ------------------------------------------------------------------------------------------- .env of the kit */

/** Keys of the kit's .env the scripts read or fill in. */
export const KIT_ENV_KEY = {
  PUBLIC_IP: "PUBLIC_IP",
  COMPOSE_FILE: "COMPOSE_FILE",
  COMPOSE_PROFILES: "COMPOSE_PROFILES",
  DEMO_ENABLED: "DEMO_ENABLED",
  LND_HOLD_EXPIRY_DELTA_BLOCKS: "LND_HOLD_EXPIRY_DELTA_BLOCKS",
  CLOUDFLARED_TUNNEL_TOKEN: "CLOUDFLARED_TUNNEL_TOKEN",
} as const;

/**
 * Secrets of the kit's .env set by hand (the Cloudflare tunnel's token): never generated, never read back. The scripts
 * only learn whether each is set.
 */
export const KIT_HAND_SECRETS: readonly string[] = [KIT_ENV_KEY.CLOUDFLARED_TUNNEL_TOKEN];

/** Secrets of the kit's .env, generated on the server (random bytes as hex) when missing or empty; never read back. */
export const KIT_SECRET_BYTES: Readonly<Record<string, number>> = {
  QUOTE_SIGNING_KEY: 32,
  BITCOIND_RPC_PASSWORD: 24,
  FNN_HUB_KEY_PASSWORD: 24,
  FNN_DEMO_KEY_PASSWORD: 24,
};

/** Random bytes of each LND wallet unlock password (hex, so 48 characters: LND wants more than 8). */
export const LND_WALLET_PASSWORD_BYTES = 24;

/** The Compose profile of the Cloudflare Tunnel (cloudflared and fiber-ws); it needs CLOUDFLARED_TUNNEL_TOKEN. */
export const TUNNEL_PROFILE = "tunnel";

/** The compose file that publishes and announces the P2P ports; PUBLIC_IP must be set when COMPOSE_FILE lists it. */
export const PUBLIC_OVERLAY_FILE = "docker-compose.public.yml";
/** Compose's separator in COMPOSE_FILE and COMPOSE_PROFILES on Linux. */
export const COMPOSE_FILE_SEPARATOR = ":";
export const COMPOSE_PROFILE_SEPARATOR = ",";
export const ENV_TRUE_VALUES: readonly string[] = ["true", "1", "yes"];

/* --------------------------------------------------------------------------------------------------- LND */

/** lncli inside an LND container; the network flag picks the signet macaroon directory. */
export const LNCLI = ["lncli", "--network=signet"] as const;
/** bitcoin-cli inside the bitcoind container. */
export const BITCOIN_CLI = ["bitcoin-cli", "-conf=/etc/bitcoin/bitcoin.conf", `-datadir=${BITCOIND_DATA_DIR}`] as const;

export const LND_CONTAINER_FILE = {
  DIR: "/root/.lnd",
  TLS_CERT: "/root/.lnd/tls.cert",
} as const;

/** The least-privilege macaroon the hub and its demo wallet get (docs/phase-3-plan.md section 4). */
export const HUB_MACAROON_PERMISSIONS: readonly string[] = [
  "info:read",
  "invoices:read",
  "invoices:write",
  "offchain:read",
  "offchain:write",
  "onchain:read",
];

/** Per LND node: the macaroon it bakes for the hub (named as hub.env.example's paths) and the TLS certificate copy. */
export const LND_HUB_FILES: Readonly<Record<LndService, { macaroon: string }>> = {
  [SERVICE.LND_HUB]: { macaroon: "hub.macaroon" },
  [SERVICE.LND_DEMO]: { macaroon: "demo.macaroon" },
};
export const TLS_CERT_FILE = "tls.cert";

/** lnrpc wallet states as `lncli state` prints them. */
export const LND_STATE = {
  NON_EXISTING: "NON_EXISTING",
  LOCKED: "LOCKED",
  UNLOCKED: "UNLOCKED",
  RPC_ACTIVE: "RPC_ACTIVE",
  SERVER_ACTIVE: "SERVER_ACTIVE",
  WAITING_TO_START: "WAITING_TO_START",
} as const;
/** States in which the wallet exists (created before). */
export const LND_WALLET_EXISTS_STATES: readonly string[] = [LND_STATE.LOCKED, LND_STATE.UNLOCKED, LND_STATE.RPC_ACTIVE, LND_STATE.SERVER_ACTIVE];

export const LND_PAYMENT_STATUS = { IN_FLIGHT: "IN_FLIGHT", SUCCEEDED: "SUCCEEDED", FAILED: "FAILED" } as const;
/** lncli connect's answer when the peer is already connected. */
export const LND_ALREADY_CONNECTED = "already connected";
export const LND_ADDRESS_TYPE = "p2tr";
export const LND_P2P_PORT = 9735;
/** The smallest channel LND opens (funding.MinChanFundingSize). */
export const LND_MIN_CHANNEL_SATS = 20_000n;

/* ---------------------------------------------------------------------------------------------------- fnn */

/** fnn node-admin RPC methods the scripts need and the hub does not call (FIBER_RPC_METHOD has the others). */
export const FNN_ADMIN_METHOD = {
  CONNECT_PEER: "connect_peer",
  LIST_PEERS: "list_peers",
  OPEN_CHANNEL: "open_channel",
} as const;

export const FNN_PAYMENT_STATUS = { CREATED: "Created", INFLIGHT: "Inflight", SUCCESS: "Success", FAILED: "Failed" } as const;
export const FNN_FINAL_PAYMENT_STATES: readonly string[] = [FNN_PAYMENT_STATUS.SUCCESS, FNN_PAYMENT_STATUS.FAILED];

/** fnn-demo dials fnn-hub on the Docker network: /dns4/<service>/tcp/<port>/p2p/<peer id>. */
export const FNN_P2P_PORT = 8228;
export const MULTIADDR_PEER_ID_PROTOCOL = "p2p";

/** How long one fnn JSON-RPC call through curl may take inside the node's container, seconds. */
export const FNN_RPC_CURL_TIMEOUT_SECONDS = 60;

/* ---------------------------------------------------------------------------------------------- CKB address */

/** CKB full address format (RFC 0021): payload 0x00 | code_hash | hash_type | args, bech32m-encoded. */
export const CKB_FULL_ADDRESS_FORMAT = 0x00;
export const CKB_ADDRESS_PREFIX = { mainnet: "ckb", testnet: "ckt" } as const;
export const CKB_HASH_TYPE_BYTE: Readonly<Record<string, number>> = { data: 0x00, type: 0x01, data1: 0x02, data2: 0x04 };

/* -------------------------------------------------------------------------- Network facts (setting defaults) */

/** Mutinynet faucet (github.com/MutinyWallet/mutinynet-faucet-rs): its API and its daily budget. */
export const MUTINYNET_FAUCET = {
  URL: "https://faucet.mutinynet.com",
  /** POST {"amount_sats"} -> {"bolt11"}: an invoice of the faucet's node, no login; 60 per day per IP. */
  BOLT11_PATH: "/api/bolt11",
  INVOICES_PER_DAY: 60,
  /** On-chain sats, channels and Lightning payments share 1,000,000 sats per 24 h per IP and GitHub user. */
  DAILY_BUDGET_SATS: 1_000_000n,
} as const;

/**
 * Megalith, the LSP that gives Alby Hub wallets on Mutinynet their channels; it forwards with a CLTV delta of 144 blocks
 * (LSP_TIME_LOCK_DELTA_BLOCKS in src/common). lnd-hub opens a private channel to it and pushes part of it to Megalith's
 * side: those wallets are then one hop from the hub, the only hop LDK's 1,008-block cap leaves room for on Mutinynet,
 * and the pushed part is the hub's inbound. The hub's hold invoices carry a route hint for the channel
 * (LN_INVOICE_ROUTE_HINTS in hub.env).
 */
export const MUTINYNET_LSP = {
  /** How logs and the check's report name it. */
  LABEL: "the Megalith LSP",
  NODE: "03e30fda71887a916ef5548a4d02b06fe04aaa1a8de9e24134ce7f139cf79d7579@64.23.192.68:9736",
} as const;

/** CKB testnet faucet (faucet.nervos.org): claims by script, no login. */
export const CKB_FAUCET = {
  API_URL: "https://faucet-api.nervos.org",
  CLAIM_PATH: "/claim_events",
  /** The amounts (whole CKB) a claim may ask for; at most 300,000 CKB per address per calendar month. */
  CLAIM_AMOUNTS: ["10000", "100000"],
  WEB_URL: "https://faucet.nervos.org",
} as const;

/** RUSD on CKB testnet comes from a browser faucet with a connected wallet (JoyID), 20 RUSD per click. */
export const RUSD_FAUCET_URL = "https://testnet0815.stablepp.xyz/faucet";

/**
 * cWBTC on CKB testnet (100 per claim). The kit does not serve it: fnn-hub's whitelist and the hub's UDT_CWBTC_SCRIPT
 * are left out (docs/add-token.md adds it), and `testnet channels` opens no cWBTC channel.
 */
export const CWBTC_FAUCET_URL = "https://faucet-cwbtc.ckb.dev";

/** Public CKB testnet RPC with the indexer (fnn's testnet default). */
export const CKB_TESTNET_RPC_URL = "https://testnet.ckbapp.dev/";

/** Fiber's public relay nodes on testnet (fiber.world network resources): fnn-hub opens its public channels to them. */
export const FIBER_TESTNET_RELAYS: readonly string[] = [
  "02b6d4e3ab86a2ca2fad6fae0ecb2e1e559e0b911939872a90abdda6d20302be71@/dns4/bottle.fiber.channel/tcp/8119/p2p/QmXen3eUHhywmutEzydCsW4hXBoeVmdET2FJvMX69XJ1Eo",
  "0291a6576bd5a94bd74b27080a48340875338fff9f6d6361fe6b8db8d0d1912fcc@/dns4/bracer.fiber.channel/tcp/8119/p2p/QmbKyzq9qUmymW2Gi8Zq7kKVpPiNA1XUJ6uMvsUC4F3p89",
];

/** Separates a node's public key from its address in DEPLOY_LN_LSP_NODE and DEPLOY_FIBER_RELAYS entries. */
export const PEER_URI_SEPARATOR = "@";
