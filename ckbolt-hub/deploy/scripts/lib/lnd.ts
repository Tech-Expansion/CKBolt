import { posix } from "node:path";
import { LNCLI, LND_ADDRESS_TYPE, LND_ALREADY_CONNECTED, LND_CONTAINER_FILE, type LndService } from "./constants";
import type { RemoteKit } from "./kit";
import { RemoteCommandError } from "./ssh";

/* lncli JSON output (lnrpc field names; int64 as strings), only the fields the scripts read. */

export interface LndInfo {
  identity_pubkey: string;
  alias: string;
  synced_to_chain: boolean;
  block_height: number;
  num_peers: number;
  num_active_channels: number;
  num_pending_channels: number;
  chains: { chain: string; network: string }[];
  /** pubkey@host:port for each announced address (lnd-hub with --externalip). */
  uris?: string[];
}

export interface LndWalletBalance {
  confirmed_balance: string;
  unconfirmed_balance: string;
}

export interface LndChannel {
  remote_pubkey: string;
  active: boolean;
  initiator: boolean;
  capacity: string;
  local_balance: string;
  remote_balance: string;
  channel_point: string;
}

export interface LndPendingChannel {
  channel: { remote_node_pub: string; capacity: string; local_balance: string; remote_balance: string };
}

export interface LndPendingChannels {
  pending_open_channels: LndPendingChannel[];
}

export interface LndPayment {
  payment_hash: string;
  status: string;
  payment_preimage: string;
  failure_reason: string;
  fee_sat: string;
}

export interface OpenChannelOptions {
  /** Sats given to the peer's side when the channel opens: inbound for the opener from the start. */
  pushSats?: bigint;
  /** Not announced to the network: payers find it only through the route hints of the node's invoices. */
  private?: boolean;
}

export interface PayOptions {
  feeLimitSats: bigint;
  timeoutSeconds: number;
  /** The remote call may take this long: a hold invoice is answered only once it settles or is cancelled. */
  callTimeoutMs: number;
}

/** One LND node of the kit, driven with lncli inside its container (admin rights, unlike the hub's macaroon). */
export class LndCli {
  constructor(
    readonly service: LndService,
    private readonly kit: RemoteKit,
  ) {}

  /** The wallet state (`lncli state` needs no macaroon); null while LND's RPC is not up yet. */
  async state(): Promise<string | null> {
    try {
      return (await this.lncli<{ state: string }>(["state"])).state;
    } catch (error) {
      if (error instanceof RemoteCommandError) return null;
      throw error;
    }
  }

  info(): Promise<LndInfo> {
    return this.lncli<LndInfo>(["getinfo"]);
  }

  walletBalance(): Promise<LndWalletBalance> {
    return this.lncli<LndWalletBalance>(["walletbalance"]);
  }

  async newAddress(): Promise<string> {
    return (await this.lncli<{ address: string }>(["newaddress", LND_ADDRESS_TYPE])).address;
  }

  async channels(): Promise<LndChannel[]> {
    return (await this.lncli<{ channels: LndChannel[] }>(["listchannels"])).channels;
  }

  async pendingOpenChannels(): Promise<LndPendingChannel[]> {
    return (await this.lncli<LndPendingChannels>(["pendingchannels"])).pending_open_channels;
  }

  async peerPubkeys(): Promise<string[]> {
    return (await this.lncli<{ peers: { pub_key: string }[] }>(["listpeers"])).peers.map((peer) => peer.pub_key);
  }

  /** Connects to pubkey@host:port; a peer that is already connected is fine. */
  async connect(pubkey: string, address: string): Promise<void> {
    try {
      await this.lncli(["connect", `${pubkey}@${address}`]);
    } catch (error) {
      if (!(error instanceof RemoteCommandError && `${error.result.stderr}${error.result.stdout}`.includes(LND_ALREADY_CONNECTED))) throw error;
    }
  }

  async openChannel(pubkey: string, sats: bigint, options: OpenChannelOptions = {}): Promise<string> {
    const args = ["openchannel", `--node_key=${pubkey}`, `--local_amt=${sats}`];
    if (options.pushSats !== undefined && options.pushSats > 0n) args.push(`--push_amt=${options.pushSats}`);
    if (options.private) args.push("--private");
    return (await this.lncli<{ funding_txid: string }>(args)).funding_txid;
  }

  async sendCoins(address: string, sats: bigint): Promise<string> {
    return (await this.lncli<{ txid: string }>(["sendcoins", `--addr=${address}`, `--amt=${sats}`])).txid;
  }

  /** Pays a BOLT11 invoice and returns the payment as LND ends it (a hold invoice: once settled or cancelled). */
  payInvoice(bolt11: string, options: PayOptions): Promise<LndPayment> {
    const args = ["payinvoice", "--force", "--json", `--fee_limit=${options.feeLimitSats}`, `--timeout=${options.timeoutSeconds}s`, bolt11];
    return this.lncli<LndPayment>(args, options.callTimeoutMs);
  }

  /** Bakes a macaroon with `permissions` into the node's data folder (replacing one of that name); returns its path. */
  async bakeMacaroon(fileName: string, permissions: readonly string[]): Promise<string> {
    const containerPath = posix.join(LND_CONTAINER_FILE.DIR, fileName);
    await this.kit.exec(this.service, [...LNCLI, "bakemacaroon", `--save_to=${containerPath}`, ...permissions]);
    return containerPath;
  }

  private lncli<T>(args: readonly string[], timeoutMs?: number): Promise<T> {
    return this.kit.execJson<T>(this.service, [...LNCLI, ...args], timeoutMs === undefined ? {} : { timeoutMs });
  }
}

/** Channel balances of `channels` with one peer, summed: local can be paid out, remote can be received. */
export function balancesWith(channels: readonly LndChannel[], pubkey: string): { local: bigint; remote: bigint; active: number } {
  const withPeer = channels.filter((channel) => channel.remote_pubkey === pubkey);
  return {
    local: withPeer.reduce((sum, channel) => sum + BigInt(channel.local_balance), 0n),
    remote: withPeer.reduce((sum, channel) => sum + BigInt(channel.remote_balance), 0n),
    active: withPeer.filter((channel) => channel.active).length,
  };
}
