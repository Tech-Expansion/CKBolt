import { FIBER_RPC_METHOD } from "../../../src/common/constants/fiber-rpc.constants";
import { FIBER_CURRENCY, FIBER_HASH_ALGORITHM_SHA256 } from "../../../src/common/constants/protocol.constants";
import { toHexQuantity } from "../../../src/common/utils/amount.util";
import { with0x } from "../../../src/common/utils/hex.util";
import type { FiberHashAlgorithm } from "../../../src/application/ports/fiber.port";
import type { Script } from "../../../src/domain/types";
import { FNN_ADMIN_METHOD } from "./devnet.constants";
import type { JsonRpcClient } from "./json-rpc";

/* fnn v0.9.1 JSON-RPC shapes (snake_case, u64/u128 as 0x hex), only the fields the devnet reads. */

export interface FnnScript {
  code_hash: string;
  hash_type: string;
  args: string;
}

export interface FnnUdtCfgInfo {
  name: string;
  script: FnnScript;
}

export interface FnnNodeInfo {
  pubkey: string;
  addresses: string[];
  chain_hash: string;
  default_funding_lock_script: FnnScript;
  udt_cfg_infos: FnnUdtCfgInfo[];
}

export interface FnnTlc {
  payment_hash: string;
  amount: string;
  expiry: string;
  status?: unknown;
}

export interface FnnChannel {
  channel_id: string;
  pubkey: string;
  is_public?: boolean;
  enabled?: boolean;
  state: { state_name: string };
  funding_udt_type_script: FnnScript | null;
  local_balance: string;
  remote_balance: string;
  pending_tlcs: FnnTlc[];
}

export interface FnnInvoiceStatus {
  status: string;
}

export interface FnnPayment {
  payment_hash: string;
  status: string;
  payment_preimage?: string | null;
  failed_error?: string | null;
}

export interface FiberInvoiceRequest {
  amount: bigint;
  udtTypeScript: Script | null;
  hashLock: { paymentHash: string } | { paymentPreimage: string };
  expirySeconds: number;
  finalExpiryDeltaMs?: number;
  description: string;
  /** sha256 unless set: a swap needs sha256, so another algorithm only serves to test that it is refused. */
  hashAlgorithm?: FiberHashAlgorithm;
  /** Let payers split the payment into parts (`allow_mpp`); the hub refuses such payout invoices. */
  allowMpp?: boolean;
}

export const toFnnScript = (script: Script): FnnScript => ({
  code_hash: script.codeHash,
  hash_type: script.hashType,
  args: script.args,
});

export const fromFnnScript = (script: FnnScript): Script => ({
  codeHash: script.code_hash,
  hashType: script.hash_type as Script["hashType"],
  args: script.args,
});

/** One fnn node of the devnet, over its JSON-RPC (params are a one-object array). */
export class FiberNode {
  constructor(
    readonly name: string,
    private readonly rpc: JsonRpcClient,
  ) {}

  nodeInfo(): Promise<FnnNodeInfo> {
    return this.rpc.call<FnnNodeInfo>(FIBER_RPC_METHOD.NODE_INFO);
  }

  async peerPubkeys(): Promise<string[]> {
    const { peers } = await this.rpc.call<{ peers: { pubkey: string }[] }>(FNN_ADMIN_METHOD.LIST_PEERS);
    return peers.map((peer) => peer.pubkey);
  }

  /** Connects to a peer by multiaddr and saves it, so the nodes reconnect after a restart. */
  async connectPeer(address: string): Promise<void> {
    await this.rpc.call(FNN_ADMIN_METHOD.CONNECT_PEER, [{ address, save: true }]);
  }

  /** Opens a channel to a connected peer; public (announced) unless `isPublic` is false. */
  async openChannel(peerPubkey: string, fundingAmount: bigint, udtTypeScript: Script | null, isPublic = true): Promise<void> {
    await this.rpc.call(FNN_ADMIN_METHOD.OPEN_CHANNEL, [
      {
        pubkey: peerPubkey,
        funding_amount: toHexQuantity(fundingAmount),
        public: isPublic,
        ...(udtTypeScript ? { funding_udt_type_script: toFnnScript(udtTypeScript) } : {}),
      },
    ]);
  }

  /** The channels with a peer; closed ones too with `includeClosed`. */
  async channelsWith(peerPubkey: string, includeClosed = false): Promise<FnnChannel[]> {
    const params = { pubkey: peerPubkey, ...(includeClosed ? { include_closed: true } : {}) };
    const { channels } = await this.rpc.call<{ channels: FnnChannel[] }>(FIBER_RPC_METHOD.LIST_CHANNELS, [params]);
    return channels;
  }

  /** Turns a channel off or on for this node's payments and the ones it forwards (update_channel `enabled`). */
  async setChannelEnabled(channelId: string, enabled: boolean): Promise<void> {
    await this.rpc.call(FNN_ADMIN_METHOD.UPDATE_CHANNEL, [{ channel_id: channelId, enabled }]);
  }

  async newInvoice(request: FiberInvoiceRequest): Promise<string> {
    const hashLock =
      "paymentHash" in request.hashLock
        ? { payment_hash: with0x(request.hashLock.paymentHash) }
        : { payment_preimage: with0x(request.hashLock.paymentPreimage) };
    const { invoice_address } = await this.rpc.call<{ invoice_address: string }>(FIBER_RPC_METHOD.NEW_INVOICE, [
      {
        amount: toHexQuantity(request.amount),
        currency: FIBER_CURRENCY.devnet,
        description: request.description,
        hash_algorithm: request.hashAlgorithm ?? FIBER_HASH_ALGORITHM_SHA256,
        expiry: toHexQuantity(request.expirySeconds),
        ...hashLock,
        ...(request.finalExpiryDeltaMs === undefined ? {} : { final_expiry_delta: toHexQuantity(request.finalExpiryDeltaMs) }),
        ...(request.udtTypeScript ? { udt_type_script: toFnnScript(request.udtTypeScript) } : {}),
        ...(request.allowMpp ? { allow_mpp: true } : {}),
      },
    ]);
    return invoice_address;
  }

  getInvoice(paymentHash: string): Promise<FnnInvoiceStatus> {
    return this.rpc.call<FnnInvoiceStatus>(FIBER_RPC_METHOD.GET_INVOICE, [{ payment_hash: with0x(paymentHash) }]);
  }

  async settleInvoice(paymentHash: string, preimage: string): Promise<void> {
    await this.rpc.call(FIBER_RPC_METHOD.SETTLE_INVOICE, [{ payment_hash: with0x(paymentHash), payment_preimage: with0x(preimage) }]);
  }

  /** Cancels an invoice that is not paid yet: a held payment goes back to the payer, a later one is refused. */
  async cancelInvoice(paymentHash: string): Promise<void> {
    await this.rpc.call(FIBER_RPC_METHOD.CANCEL_INVOICE, [{ payment_hash: with0x(paymentHash) }]);
  }

  sendPayment(invoice: string): Promise<FnnPayment> {
    return this.rpc.call<FnnPayment>(FIBER_RPC_METHOD.SEND_PAYMENT, [{ invoice }]);
  }

  getPayment(paymentHash: string): Promise<FnnPayment> {
    return this.rpc.call<FnnPayment>(FIBER_RPC_METHOD.GET_PAYMENT, [{ payment_hash: with0x(paymentHash) }]);
  }
}
