import { FIBER_RPC_HTTP, FIBER_RPC_METHOD, JSON_RPC_VERSION } from "../../../src/common/constants/fiber-rpc.constants";
import { FIBER_CURRENCY, FIBER_HASH_ALGORITHM_SHA256, MULTIADDR_SEPARATOR } from "../../../src/common/constants/protocol.constants";
import { toHexQuantity } from "../../../src/common/utils/amount.util";
import { with0x } from "../../../src/common/utils/hex.util";
import { sameScript } from "../../../src/common/utils/script.util";
import type { Script } from "../../../src/domain/types";
import { FNN_ADMIN_METHOD, FNN_RPC_CURL_TIMEOUT_SECONDS, MULTIADDR_PEER_ID_PROTOCOL, type FnnService } from "./constants";
import type { RemoteKit } from "./kit";

/* fnn v0.9.1 JSON-RPC shapes (snake_case, u64/u128 as 0x hex), only the fields the scripts read. */

export interface FnnScript {
  code_hash: string;
  hash_type: string;
  args: string;
}

export interface FnnNodeInfo {
  version: string;
  pubkey: string;
  addresses: string[];
  chain_hash: string;
  default_funding_lock_script: FnnScript;
}

export interface FnnPeer {
  pubkey: string;
  address: string;
}

export interface FnnChannel {
  channel_id: string;
  pubkey: string;
  state: { state_name: string };
  funding_udt_type_script: FnnScript | null;
  local_balance: string;
  remote_balance: string;
  is_public?: boolean;
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
  preimage: string;
  expirySeconds: number;
  finalExpiryDeltaMs: number;
  description: string;
}

interface JsonRpcResponse<T> {
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

/** `rpcMessage` is fnn's own error text, for matching; `message` adds the node and the method. */
export class FiberRpcError extends Error {
  constructor(
    readonly node: string,
    readonly method: string,
    readonly rpcMessage: string,
  ) {
    super(`${node} ${method}: ${rpcMessage}`);
  }
}

export const toFnnScript = (script: Script): FnnScript => ({ code_hash: script.codeHash, hash_type: script.hashType, args: script.args });

export const fromFnnScript = (script: FnnScript): Script => ({
  codeHash: script.code_hash,
  hashType: script.hash_type as Script["hashType"],
  args: script.args,
});

/** True for a channel of the asset: a CKB channel when `udtTypeScript` is null, else a channel of that UDT. */
export function isChannelOfAsset(channel: FnnChannel, udtTypeScript: Script | null): boolean {
  const funding = channel.funding_udt_type_script;
  if (udtTypeScript === null) return funding == null;
  return funding != null && sameScript(fromFnnScript(funding), udtTypeScript);
}

/** The curl call that posts stdin to the node's RPC from inside its container ($RPC_LISTENING_ADDR is its own env). */
const CURL_TO_OWN_RPC =
  `curl -sS -m ${FNN_RPC_CURL_TIMEOUT_SECONDS} -H '${FIBER_RPC_HTTP.CONTENT_TYPE_HEADER}: ${FIBER_RPC_HTTP.CONTENT_TYPE}' ` +
  `--data-binary @- "http://$RPC_LISTENING_ADDR"`;

/**
 * One fnn node of the kit over its JSON-RPC. The RPC is not published on the host: each call runs curl inside the
 * node's own container (the fnn image ships curl) with the request on stdin.
 */
export class FiberRpc {
  private nextId = 1;

  constructor(
    readonly service: FnnService,
    private readonly kit: RemoteKit,
  ) {}

  async call<T>(method: string, params: readonly unknown[] = []): Promise<T> {
    const request = JSON.stringify({ jsonrpc: JSON_RPC_VERSION, id: this.nextId++, method, params });
    const output = await this.kit.exec(this.service, ["sh", "-c", CURL_TO_OWN_RPC], { input: request, description: `${this.service} ${method}` });
    let body: JsonRpcResponse<T>;
    try {
      body = JSON.parse(output) as JsonRpcResponse<T>;
    } catch {
      throw new FiberRpcError(this.service, method, `not a JSON-RPC answer: ${output.trim().slice(0, 200)}`);
    }
    if (body.error) throw new FiberRpcError(this.service, method, body.error.message);
    return body.result as T;
  }

  nodeInfo(): Promise<FnnNodeInfo> {
    return this.call<FnnNodeInfo>(FIBER_RPC_METHOD.NODE_INFO);
  }

  async peers(): Promise<FnnPeer[]> {
    return (await this.call<{ peers: FnnPeer[] }>(FNN_ADMIN_METHOD.LIST_PEERS)).peers;
  }

  /** Connects to a peer by multiaddr and saves it, so the node reconnects after a restart. */
  async connectPeer(address: string): Promise<void> {
    await this.call(FNN_ADMIN_METHOD.CONNECT_PEER, [{ address, save: true }]);
  }

  /** Open and opening channels (fnn leaves closed ones out); with one peer when `pubkey` is given. */
  async channels(pubkey?: string): Promise<FnnChannel[]> {
    return (await this.call<{ channels: FnnChannel[] }>(FIBER_RPC_METHOD.LIST_CHANNELS, [pubkey ? { pubkey } : {}])).channels;
  }

  async openChannel(pubkey: string, fundingAmount: bigint, udtTypeScript: Script | null): Promise<string> {
    const { temporary_channel_id } = await this.call<{ temporary_channel_id: string }>(FNN_ADMIN_METHOD.OPEN_CHANNEL, [
      {
        pubkey,
        funding_amount: toHexQuantity(fundingAmount),
        public: true,
        ...(udtTypeScript ? { funding_udt_type_script: toFnnScript(udtTypeScript) } : {}),
      },
    ]);
    return temporary_channel_id;
  }

  /** A sha256 invoice on CKB testnet for a preimage the caller made (the payee knows it, as a wallet does). */
  async newInvoice(request: FiberInvoiceRequest): Promise<string> {
    const { invoice_address } = await this.call<{ invoice_address: string }>(FIBER_RPC_METHOD.NEW_INVOICE, [
      {
        amount: toHexQuantity(request.amount),
        currency: FIBER_CURRENCY.testnet,
        description: request.description,
        hash_algorithm: FIBER_HASH_ALGORITHM_SHA256,
        payment_preimage: with0x(request.preimage),
        expiry: toHexQuantity(request.expirySeconds),
        final_expiry_delta: toHexQuantity(request.finalExpiryDeltaMs),
        ...(request.udtTypeScript ? { udt_type_script: toFnnScript(request.udtTypeScript) } : {}),
      },
    ]);
    return invoice_address;
  }

  getInvoice(paymentHash: string): Promise<FnnInvoiceStatus> {
    return this.call<FnnInvoiceStatus>(FIBER_RPC_METHOD.GET_INVOICE, [{ payment_hash: with0x(paymentHash) }]);
  }

  sendPayment(invoice: string): Promise<FnnPayment> {
    return this.call<FnnPayment>(FIBER_RPC_METHOD.SEND_PAYMENT, [{ invoice }]);
  }

  getPayment(paymentHash: string): Promise<FnnPayment> {
    return this.call<FnnPayment>(FIBER_RPC_METHOD.GET_PAYMENT, [{ payment_hash: with0x(paymentHash) }]);
  }
}

/** The peer id at the end of a multiaddr (/.../p2p/<id>); null when it has none. */
export function peerIdOf(multiaddr: string): string | null {
  const segments = multiaddr.split(MULTIADDR_SEPARATOR);
  const index = segments.lastIndexOf(MULTIADDR_PEER_ID_PROTOCOL);
  const peerId = index >= 0 ? segments[index + 1] : undefined;
  return peerId ? peerId : null;
}

const HOST_PROTOCOLS: readonly string[] = ["dns4", "dns6", "dns", "ip4", "ip6"];

/** The host of a multiaddr (/dns4/bottle.fiber.channel/... -> bottle.fiber.channel); null when it names none. */
export function hostOfMultiaddr(multiaddr: string): string | null {
  const segments = multiaddr.split(MULTIADDR_SEPARATOR);
  const index = segments.findIndex((segment) => HOST_PROTOCOLS.includes(segment));
  return (index >= 0 ? segments[index + 1] : undefined) ?? null;
}

/** The peer id fnn announces with any of its addresses (node_info.addresses). */
export function announcedPeerId(info: FnnNodeInfo): string | null {
  for (const address of info.addresses) {
    const peerId = peerIdOf(address);
    if (peerId) return peerId;
  }
  return null;
}

/** /dns4/<host>/tcp/<port>/p2p/<id>: how a node on the same Docker network dials another by its service name. */
export const dockerNetworkMultiaddr = (host: string, port: number, peerId: string): string =>
  ["", "dns4", host, "tcp", String(port), MULTIADDR_PEER_ID_PROTOCOL, peerId].join(MULTIADDR_SEPARATOR);
