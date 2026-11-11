import { isIP } from "node:net";
import { join } from "node:path";
import { ASSET_METADATA, type KnownAssetId } from "../../../src/common/constants/assets.constants";
import { BASIS_POINTS_PER_WHOLE } from "../../../src/common/constants/pricing.constants";
import { MS_PER_SECOND } from "../../../src/common/constants/protocol.constants";
import { baseUnitsPerWhole } from "../../../src/common/utils/pricing.util";
import { loadEnvFile } from "../../../src/config/env-file";
import {
  CKB_FAUCET,
  CKB_TESTNET_RPC_URL,
  FIBER_TESTNET_RELAYS,
  LND_MIN_CHANNEL_SATS,
  MUTINYNET_FAUCET,
  MUTINYNET_LSP,
  PEER_URI_SEPARATOR,
} from "./constants";

/**
 * Settings of the deploy scripts, from the environment and deploy/deploy.env (deploy.env.example lists every one with
 * its default). Amounts of CKB and RUSD are whole units here and base units in the settings object.
 */

/** The local settings file, next to package.json; variables already set in the environment win over it. */
export const DEPLOY_ENV_FILE = "deploy.env";

export interface LightningPeer {
  pubkey: string;
  /** host:port */
  address: string;
}

export interface FiberPeer {
  pubkey: string;
  /** A multiaddr ending in /p2p/<peer id>. */
  address: string;
}

export type SmokeDirection = "ln_to_fiber" | "fiber_to_ln" | "both";
export const SMOKE_DIRECTIONS: readonly SmokeDirection[] = ["ln_to_fiber", "fiber_to_ln", "both"];

export interface DeploySettings {
  ssh: {
    /** Host or ~/.ssh/config alias; null until DEPLOY_SSH_HOST is set (remote commands then stop with a hint). */
    host: string | null;
    connectTimeoutSeconds: number;
  };
  /** Absolute kit directory on the server. */
  remoteDir: string;
  /** Overrides the address `testnet env` finds for PUBLIC_IP. */
  publicIp: string | null;
  timeouts: {
    commandMs: number;
    buildMs: number;
    /** Waits for nodes, confirmations and channels. */
    waitMs: number;
    /** How long a node gets to connect to a peer it dialled. */
    peerConnectMs: number;
    pollIntervalMs: number;
    httpMs: number;
  };
  urls: { mutinynetFaucet: string; ckbFaucetApi: string; ckbRpc: string };
  peers: { lnLspNode: LightningPeer; fiberRelays: FiberPeer[] };
  ckbFaucet: {
    /** Whole CKB per claim, one of CKB_FAUCET.CLAIM_AMOUNTS. */
    claimHub: string;
    claimDemo: string;
    /** Claim only while the node's wallet holds less than this (shannons). */
    minHubShannons: bigint;
    minDemoShannons: bigint;
  };
  lightning: {
    /** lnd-hub's private channel to the LSP, and the part of it pushed to the LSP's side (the hub's inbound). */
    lspChannelSats: bigint;
    lspPushSats: bigint;
    demoWalletSats: bigint;
    demoChannelSats: bigint;
    inboundTargetSats: bigint;
    balanceInvoiceSats: bigint;
    balanceMaxInvoices: number;
    onchainReserveSats: bigint;
    payTimeoutSeconds: number;
    payFeeLimitSats: bigint;
  };
  fiber: {
    relayChannelShannons: bigint;
    /** 0: no RUSD channel to the first relay node. */
    relayChannelRusd: bigint;
    demoChannelShannons: bigint;
    demoChannelRusd: bigint;
    /** Share of each demo channel moved to fnn-demo, basis points. */
    demoShareBps: bigint;
    invoiceExpirySeconds: number;
    /** Tries of a balancing payment while a new channel reaches fnn's graph. */
    paymentAttempts: number;
  };
  smoke: { sats: bigint; asset: KnownAssetId; direction: SmokeDirection; timeoutMs: number };
  check: { minLiquiditySats: bigint };
}

type Env = Readonly<Record<string, string | undefined>>;

/**
 * An absolute folder at least two levels deep whose segments are plain names (no ".", "..", spaces or shell
 * characters): the scripts replace folders under it with rm -rf.
 */
const SAFE_REMOTE_DIR = /^(\/[A-Za-z0-9_-][A-Za-z0-9._-]*){2,}$/;

/**
 * An ssh destination: an ~/.ssh/config alias, host, user@host or [IPv6] that ssh cannot read as an option (a leading
 * "-", e.g. -oProxyCommand=..., would run a local program) and that has no spaces or control characters.
 */
const SAFE_SSH_HOST = /^[A-Za-z0-9_.@[\]:%+][A-Za-z0-9_.@[\]:%+-]*$/;

/** Collects every bad value, so one run reports them all. */
class SettingsReader {
  readonly problems: string[] = [];

  constructor(private readonly env: Env) {}

  text(key: string, fallback: string): string {
    const value = this.env[key]?.trim();
    return value ? value : fallback;
  }

  optionalText(key: string): string | null {
    const value = this.env[key]?.trim();
    return value ? value : null;
  }

  integer(key: string, fallback: number, min: number): number {
    const raw = this.text(key, String(fallback));
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min) {
      this.problems.push(`${key} must be a whole number of at least ${min} (got "${raw}")`);
      return fallback;
    }
    return value;
  }

  sats(key: string, fallback: bigint, min = 0n): bigint {
    return this.whole(key, fallback, min);
  }

  /** Whole units of an asset in the environment, base units in the result. */
  assetAmount(key: string, fallbackWhole: bigint, asset: KnownAssetId): bigint {
    return this.whole(key, fallbackWhole, 0n) * baseUnitsPerWhole(ASSET_METADATA[asset].decimals);
  }

  oneOf<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
    const value = this.text(key, fallback);
    if ((allowed as readonly string[]).includes(value)) return value as T;
    this.problems.push(`${key} must be one of ${allowed.join(", ")} (got "${value}")`);
    return fallback;
  }

  ipv4(key: string): string | null {
    const value = this.optionalText(key);
    if (value !== null && isIP(value) !== 4) this.problems.push(`${key} must be an IPv4 address (got "${value}")`);
    return value;
  }

  lightningPeer(key: string, fallback: string): LightningPeer {
    const [pubkey, address] = splitPeer(this.text(key, fallback));
    if (!pubkey || !address) this.problems.push(`${key} must be <pubkey>@<host>:<port>`);
    return { pubkey: pubkey ?? "", address: address ?? "" };
  }

  fiberPeers(key: string, fallback: readonly string[]): FiberPeer[] {
    const entries = this.text(key, fallback.join(",")).split(",").map((entry) => entry.trim()).filter(Boolean);
    return entries.map((entry) => {
      const [pubkey, address] = splitPeer(entry);
      if (!pubkey || !address?.startsWith("/")) this.problems.push(`${key} entries must be <pubkey>@<multiaddr> (got "${entry}")`);
      return { pubkey: pubkey ?? "", address: address ?? "" };
    });
  }

  private whole(key: string, fallback: bigint, min: bigint): bigint {
    const raw = this.text(key, fallback.toString());
    if (!/^\d+$/.test(raw) || BigInt(raw) < min) {
      this.problems.push(`${key} must be a whole number of at least ${min} (got "${raw}")`);
      return fallback;
    }
    return BigInt(raw);
  }
}

/** "<pubkey>@<address>" -> [pubkey, address], split at the first "@". */
function splitPeer(entry: string): [string | undefined, string | undefined] {
  const at = entry.indexOf(PEER_URI_SEPARATOR);
  if (at <= 0) return [undefined, undefined];
  return [entry.slice(0, at), entry.slice(at + PEER_URI_SEPARATOR.length)];
}

const seconds = (value: number): number => value * MS_PER_SECOND;

/** Reads the settings from `env`; throws one error that lists every bad value. */
export function readDeploySettings(env: Env): DeploySettings {
  const r = new SettingsReader(env);
  const remoteDir = r.text("DEPLOY_REMOTE_DIR", "/opt/ckbolt/testnet");
  const settings: DeploySettings = {
    ssh: {
      host: r.optionalText("DEPLOY_SSH_HOST"),
      connectTimeoutSeconds: r.integer("DEPLOY_SSH_CONNECT_TIMEOUT_SECONDS", 15, 1),
    },
    remoteDir,
    publicIp: r.ipv4("DEPLOY_PUBLIC_IP"),
    timeouts: {
      commandMs: seconds(r.integer("DEPLOY_COMMAND_TIMEOUT_SECONDS", 300, 1)),
      buildMs: seconds(r.integer("DEPLOY_BUILD_TIMEOUT_SECONDS", 3600, 1)),
      waitMs: seconds(r.integer("DEPLOY_WAIT_TIMEOUT_SECONDS", 1800, 1)),
      pollIntervalMs: seconds(r.integer("DEPLOY_POLL_INTERVAL_SECONDS", 10, 1)),
      peerConnectMs: seconds(r.integer("DEPLOY_PEER_CONNECT_TIMEOUT_SECONDS", 120, 1)),
      httpMs: seconds(r.integer("DEPLOY_HTTP_TIMEOUT_SECONDS", 30, 1)),
    },
    urls: {
      mutinynetFaucet: r.text("DEPLOY_MUTINYNET_FAUCET_URL", MUTINYNET_FAUCET.URL),
      ckbFaucetApi: r.text("DEPLOY_CKB_FAUCET_API_URL", CKB_FAUCET.API_URL),
      ckbRpc: r.text("DEPLOY_CKB_RPC_URL", CKB_TESTNET_RPC_URL),
    },
    peers: {
      lnLspNode: r.lightningPeer("DEPLOY_LN_LSP_NODE", MUTINYNET_LSP.NODE),
      fiberRelays: r.fiberPeers("DEPLOY_FIBER_RELAYS", FIBER_TESTNET_RELAYS),
    },
    ckbFaucet: {
      claimHub: r.oneOf("DEPLOY_CKB_CLAIM_HUB", "100000", CKB_FAUCET.CLAIM_AMOUNTS),
      claimDemo: r.oneOf("DEPLOY_CKB_CLAIM_DEMO", "10000", CKB_FAUCET.CLAIM_AMOUNTS),
      minHubShannons: r.assetAmount("DEPLOY_CKB_MIN_HUB", 25_000n, "CKB"),
      minDemoShannons: r.assetAmount("DEPLOY_CKB_MIN_DEMO", 1_000n, "CKB"),
    },
    lightning: {
      lspChannelSats: r.sats("DEPLOY_LN_LSP_CHANNEL_SATS", 220_000n, LND_MIN_CHANNEL_SATS),
      lspPushSats: r.sats("DEPLOY_LN_LSP_PUSH_SATS", 100_000n),
      demoWalletSats: r.sats("DEPLOY_LN_DEMO_WALLET_SATS", 200_000n),
      demoChannelSats: r.sats("DEPLOY_LN_DEMO_CHANNEL_SATS", 150_000n),
      inboundTargetSats: r.sats("DEPLOY_LN_INBOUND_TARGET_SATS", 100_000n),
      balanceInvoiceSats: r.sats("DEPLOY_LN_BALANCE_INVOICE_SATS", 50_000n, 1n),
      balanceMaxInvoices: r.integer("DEPLOY_LN_BALANCE_MAX_INVOICES", 10, 1),
      onchainReserveSats: r.sats("DEPLOY_LN_ONCHAIN_RESERVE_SATS", 20_000n),
      payTimeoutSeconds: r.integer("DEPLOY_LN_PAY_TIMEOUT_SECONDS", 120, 1),
      payFeeLimitSats: r.sats("DEPLOY_LN_PAY_FEE_LIMIT_SATS", 100n),
    },
    fiber: {
      relayChannelShannons: r.assetAmount("DEPLOY_FIBER_RELAY_CHANNEL_CKB", 1_000n, "CKB"),
      relayChannelRusd: r.assetAmount("DEPLOY_FIBER_RELAY_CHANNEL_RUSD", 0n, "RUSD"),
      demoChannelShannons: r.assetAmount("DEPLOY_FIBER_DEMO_CHANNEL_CKB", 20_000n, "CKB"),
      demoChannelRusd: r.assetAmount("DEPLOY_FIBER_DEMO_CHANNEL_RUSD", 0n, "RUSD"),
      demoShareBps: BigInt(r.integer("DEPLOY_FIBER_DEMO_SHARE_BPS", 5_000, 0)),
      invoiceExpirySeconds: r.integer("DEPLOY_FIBER_INVOICE_EXPIRY_SECONDS", 3_600, 1),
      paymentAttempts: r.integer("DEPLOY_FIBER_PAYMENT_ATTEMPTS", 5, 1),
    },
    smoke: {
      sats: r.sats("DEPLOY_SMOKE_SATS", 2_000n, 1n),
      asset: r.oneOf<KnownAssetId>("DEPLOY_SMOKE_ASSET", "CKB", ["CKB", "RUSD"]),
      direction: r.oneOf("DEPLOY_SMOKE_DIRECTION", "both", SMOKE_DIRECTIONS),
      timeoutMs: seconds(r.integer("DEPLOY_SMOKE_TIMEOUT_SECONDS", 600, 1)),
    },
    check: { minLiquiditySats: r.sats("DEPLOY_CHECK_MIN_LIQUIDITY_SATS", 20_000n) },
  };
  const sshHost = settings.ssh.host;
  if (sshHost !== null && !SAFE_SSH_HOST.test(sshHost)) {
    r.problems.push(`DEPLOY_SSH_HOST must be an ~/.ssh/config alias, host or user@host, not starting with "-" (got "${sshHost}")`);
  }
  if (!SAFE_REMOTE_DIR.test(remoteDir)) {
    r.problems.push(`DEPLOY_REMOTE_DIR must be an absolute folder at least two levels deep, plain names only (got "${remoteDir}")`);
  }
  if (settings.fiber.demoShareBps > BASIS_POINTS_PER_WHOLE) r.problems.push(`DEPLOY_FIBER_DEMO_SHARE_BPS must be at most ${BASIS_POINTS_PER_WHOLE}`);
  const { lspChannelSats, lspPushSats, inboundTargetSats } = settings.lightning;
  // The opener keeps a part of the channel; `testnet balance` can reach only an inbound below the channel's size.
  if (lspPushSats >= lspChannelSats) r.problems.push(`DEPLOY_LN_LSP_PUSH_SATS must be below DEPLOY_LN_LSP_CHANNEL_SATS (${lspChannelSats})`);
  if (inboundTargetSats >= lspChannelSats) r.problems.push(`DEPLOY_LN_INBOUND_TARGET_SATS must be below DEPLOY_LN_LSP_CHANNEL_SATS (${lspChannelSats})`);
  if (r.problems.length > 0) throw new Error(`Invalid deploy settings: ${r.problems.join("; ")}`);
  return settings;
}

/** Loads deploy/deploy.env (when present) into the environment, then reads the settings. */
export function loadDeploySettings(deployDir: string, env: NodeJS.ProcessEnv = process.env): DeploySettings {
  loadEnvFile(join(deployDir, DEPLOY_ENV_FILE), env);
  return readDeploySettings(env);
}

/** The SSH host, or an error that says how to set it. */
export function requireSshHost(settings: DeploySettings): string {
  if (settings.ssh.host) return settings.ssh.host;
  throw new Error(`Set DEPLOY_SSH_HOST (an ~/.ssh/config alias or user@host) in deploy/${DEPLOY_ENV_FILE} or the environment`);
}
