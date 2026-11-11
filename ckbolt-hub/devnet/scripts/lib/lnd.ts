import { posix } from "node:path";
import type { DockerCompose } from "./compose";
import { CommandError } from "./process";
import {
  CONTAINER_PORT,
  LNCLI,
  LND_ADDRESS_TYPE,
  LND_ALREADY_CONNECTED,
  LND_CONTAINER_FILE,
  type ServiceName,
} from "./devnet.constants";

/* lncli JSON output (lnrpc field names), only the fields the devnet reads. */

export interface LndInfo {
  identity_pubkey: string;
  synced_to_chain: boolean;
  block_height: number;
}

export interface LndChannel {
  remote_pubkey: string;
  initiator: boolean;
  active: boolean;
  capacity: string;
  local_balance: string;
  remote_balance: string;
}

export interface LndPendingOpenChannel {
  channel: { remote_node_pub: string; initiator: string };
}

export interface LndInvoice {
  state: string;
  /** Hex; empty until the invoice is settled (a hold invoice) or for an invoice LND did not make the preimage of. */
  r_preimage: string;
  amt_paid_sat: string;
}

export interface LndPayment {
  payment_hash: string;
  status: string;
  payment_preimage: string;
}

export interface LndAddedInvoice {
  r_hash: string;
  payment_request: string;
}

export interface InvoiceRequest {
  /** null: an invoice without an amount (the payer chooses it). */
  sats: bigint | null;
  expirySeconds: number;
  /** min_final_cltv_expiry of the invoice; LND's default when absent. */
  cltvExpiryDelta?: number;
}

export interface HoldInvoiceRequest {
  paymentHash: string;
  sats: bigint;
  cltvExpiryDelta: number;
  expirySeconds: number;
}

/** One LND node of the devnet, driven with lncli inside its container. */
export class LndNode {
  constructor(
    readonly service: ServiceName,
    private readonly compose: DockerCompose,
  ) {}

  info(): Promise<LndInfo> {
    return this.lncli<LndInfo>(["getinfo"]);
  }

  /** The node's last `lines` log lines (its container's output). */
  recentLog(lines: number): Promise<string> {
    return this.compose.logs(this.service, lines);
  }

  async newAddress(): Promise<string> {
    return (await this.lncli<{ address: string }>(["newaddress", LND_ADDRESS_TYPE])).address;
  }

  async confirmedBalanceSats(): Promise<bigint> {
    return BigInt((await this.lncli<{ confirmed_balance: string }>(["walletbalance"])).confirmed_balance);
  }

  async peerPubkeys(): Promise<string[]> {
    return (await this.lncli<{ peers: { pub_key: string }[] }>(["listpeers"])).peers.map((peer) => peer.pub_key);
  }

  /** Connects to a peer by pubkey and compose hostname; a peer that is already connected is fine. */
  async connect(pubkey: string, host: ServiceName): Promise<void> {
    try {
      await this.lncli(["connect", `${pubkey}@${host}:${CONTAINER_PORT.LND_P2P}`]);
    } catch (error) {
      if (!(error instanceof CommandError && error.output.includes(LND_ALREADY_CONNECTED))) throw error;
    }
  }

  async channels(): Promise<LndChannel[]> {
    return (await this.lncli<{ channels: LndChannel[] }>(["listchannels"])).channels;
  }

  async pendingOpenChannels(): Promise<LndPendingOpenChannel[]> {
    return (await this.lncli<{ pending_open_channels: LndPendingOpenChannel[] }>(["pendingchannels"])).pending_open_channels;
  }

  async openChannel(pubkey: string, sats: bigint): Promise<string> {
    const args = ["openchannel", `--node_key=${pubkey}`, `--local_amt=${sats}`];
    return (await this.lncli<{ funding_txid: string }>(args)).funding_txid;
  }

  /** Bakes a macaroon with `permissions` into the node's macaroon directory (replacing one of that name); returns its path. */
  async bakeMacaroon(permissions: readonly string[], fileName: string): Promise<string> {
    const containerPath = posix.join(LND_CONTAINER_FILE.MACAROON_DIR, fileName);
    await this.lncli(["bakemacaroon", `--save_to=${containerPath}`, ...permissions], false);
    return containerPath;
  }

  async addHoldInvoice(request: HoldInvoiceRequest): Promise<string> {
    const args = [
      "addholdinvoice",
      `--amt=${request.sats}`,
      `--cltv_expiry_delta=${request.cltvExpiryDelta}`,
      `--expiry=${request.expirySeconds}`,
      request.paymentHash,
    ];
    return (await this.lncli<{ payment_request: string }>(args)).payment_request;
  }

  /** A regular invoice; LND makes and keeps the preimage. */
  addInvoice(request: InvoiceRequest): Promise<LndAddedInvoice> {
    const args = [
      "addinvoice",
      `--expiry=${request.expirySeconds}`,
      ...(request.sats === null ? [] : [`--amt=${request.sats}`]),
      ...(request.cltvExpiryDelta === undefined ? [] : [`--cltv_expiry_delta=${request.cltvExpiryDelta}`]),
    ];
    return this.lncli<LndAddedInvoice>(args);
  }

  lookupInvoice(paymentHash: string): Promise<LndInvoice> {
    return this.lncli<LndInvoice>(["lookupinvoice", paymentHash]);
  }

  async settleInvoice(preimage: string): Promise<void> {
    await this.lncli(["settleinvoice", preimage]);
  }

  /** Cancels an open or held invoice: a held payment goes back to the payer. */
  async cancelInvoice(paymentHash: string): Promise<void> {
    await this.lncli(["cancelinvoice", paymentHash]);
  }

  /** Pays a BOLT11 invoice; resolves when lncli returns, which for a hold invoice is after it is settled or cancelled. */
  async payInvoice(paymentRequest: string, options: { feeLimitSats: bigint; timeoutSeconds: number }): Promise<void> {
    const args = ["payinvoice", "--force", "--json", `--fee_limit=${options.feeLimitSats}`, `--timeout=${options.timeoutSeconds}s`, paymentRequest];
    await this.lncli(args, false);
  }

  async findPayment(paymentHash: string): Promise<LndPayment | undefined> {
    const { payments } = await this.lncli<{ payments: LndPayment[] }>(["listpayments", "--include_incomplete"]);
    return payments.find((payment) => payment.payment_hash === paymentHash);
  }

  private lncli<T>(args: readonly string[], json?: true): Promise<T>;
  private lncli(args: readonly string[], json: false): Promise<string>;
  private lncli<T>(args: readonly string[], json = true): Promise<T | string> {
    const command = [...LNCLI, ...args];
    return json ? this.compose.execJson<T>(this.service, command) : this.compose.exec(this.service, command);
  }
}
