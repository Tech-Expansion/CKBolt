import type { Script } from "@/lib/hub/contract";
import type { FiberNetwork } from "@/lib/payment-request";
import { BYO_INVOICE_DESCRIPTION, BYO_INVOICE_EXPIRY_SECONDS, FIBER_CURRENCY, FNN_DEFAULT_RPC_URL } from "./constants";

/**
 * The fnn JSON-RPC calls an external node (fnn, or Fiber Studio's fnn) runs by hand for a swap, as copyable curl lines:
 * the payout invoice for BTC to a Fiber token, the payment of the hub's hold invoice for the other way, and the
 * connection to the hub. Field names and encodings follow fnn v0.9.1 (`crates/fiber-json-types`): quantities are 0x hex,
 * scripts snake_case, one object as the only positional param.
 */
export interface FnnRequest {
  method: string;
  params: Record<string, unknown>;
}

/** The hash algorithm the hub needs: fnn's default, ckb_hash, cannot be matched with a Lightning payment. */
export const SHA256_HASH_ALGORITHM = "sha256";

/** A quantity as fnn's JSON-RPC takes it: 0x and lower-case hex. */
export const rpcQuantity = (value: bigint | number | string): string => `0x${BigInt(value).toString(16)}`;

const rpcScript = (script: Script) => ({ code_hash: script.codeHash, hash_type: script.hashType, args: script.args });

/**
 * new_invoice for a payout: the exact amount in the asset's base units, a sha256 hash, the network's currency, the
 * token's type script (none for CKB). fnn leaves allow_mpp off and sets final_expiry_delta to its minimum (160 minutes)
 * when they are left out: both what the hub needs.
 */
export function newInvoiceRequest(args: { amount: bigint | string; network: FiberNetwork; udtTypeScript: Script | null }): FnnRequest {
  return {
    method: "new_invoice",
    params: {
      amount: rpcQuantity(args.amount),
      currency: FIBER_CURRENCY[args.network],
      description: BYO_INVOICE_DESCRIPTION,
      expiry: rpcQuantity(BYO_INVOICE_EXPIRY_SECONDS),
      hash_algorithm: SHA256_HASH_ALGORITHM,
      ...(args.udtTypeScript ? { udt_type_script: rpcScript(args.udtTypeScript) } : {}),
    },
  };
}

/** send_payment of an invoice with a cap on the routing fee (base units of the invoice's asset). */
export const sendPaymentRequest = (args: { invoice: string; maxFeeAmount: bigint }): FnnRequest => ({
  method: "send_payment",
  params: { invoice: args.invoice, max_fee_amount: rpcQuantity(args.maxFeeAmount) },
});

/** connect_peer to a node's multiaddr (the hub's p2p address, from GET /v1/fiber/node). */
export const connectPeerRequest = (address: string): FnnRequest => ({ method: "connect_peer", params: { address } });

/** The JSON-RPC body fnn takes. */
export const rpcBody = (request: FnnRequest): string =>
  JSON.stringify({ jsonrpc: "2.0", id: 1, method: request.method, params: [request.params] });

/** Wraps text in single quotes for a POSIX shell: a single quote inside becomes '\''. */
export const shellQuote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

/** A curl line that sends the request to fnn's RPC (its default address unless given). */
export const curlCommand = (request: FnnRequest, rpcUrl: string = FNN_DEFAULT_RPC_URL): string =>
  `curl -s -X POST ${rpcUrl} -H 'Content-Type: application/json' -d ${shellQuote(rpcBody(request))}`;
