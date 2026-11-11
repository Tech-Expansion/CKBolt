import type { AuthenticatedLnd } from "lightning";
import { LIGHTNING_LIB_OPEN_CHANNEL_SYNC_METHOD } from "../../common/constants/lnd.constants";

/**
 * LND's OpenChannelSync, called on the authenticated client's raw `default` service. The `lightning` package's
 * openChannel streams OpenChannel and sets no commitment type (anchors, LND's default), which LDK wallets refuse; this
 * call asks for one, and is the RPC the channel-only macaroon allows.
 */

/** lnrpc.OpenChannelRequest as grpc-js takes it: proto field names, int64 as decimal strings, bytes as a Buffer. */
export interface OpenChannelSyncRequest {
  node_pubkey: Buffer;
  local_funding_amount: string;
  push_sat: string;
  private: boolean;
  /** An lnrpc.CommitmentType name. */
  commitment_type: string;
  memo: string;
  target_conf: number;
  min_confs: number;
  spend_unconfirmed: boolean;
}

/** lnrpc.ChannelPoint as grpc-js decodes it with the package's loader options: one of the two txid fields is set. */
export interface RawChannelPoint {
  /** The funding txid in internal byte order (reversed against the hex block explorers show). */
  funding_txid_bytes?: Buffer;
  funding_txid_str?: string;
  output_index: number;
}

export interface OpenChannelSyncArgs {
  lnd: AuthenticatedLnd;
  request: OpenChannelSyncRequest;
  /** When grpc-js gives up on the call (DEADLINE_EXCEEDED), ms since the epoch. */
  deadline: number;
}

type UnaryCallback = (error: unknown, response?: RawChannelPoint) => void;
type UnaryMethod = (this: unknown, request: OpenChannelSyncRequest, options: { deadline: number }, callback: UnaryCallback) => void;

/** Resolves with the channel point once the funding is published; rejects with grpc-js's error (code and details). */
export function openChannelSync({ lnd, request, deadline }: OpenChannelSyncArgs): Promise<RawChannelPoint> {
  const service = lnd.default as Record<string, UnaryMethod | undefined>;
  const method = service[LIGHTNING_LIB_OPEN_CHANNEL_SYNC_METHOD];
  if (typeof method !== "function") return Promise.reject(new Error(`The LND client has no ${LIGHTNING_LIB_OPEN_CHANNEL_SYNC_METHOD} method`));
  return new Promise((resolve, reject) => {
    method.call(service, request, { deadline }, (error, response) => {
      if (error) reject(error);
      else if (response) resolve(response);
      else reject(new Error(`LND answered ${LIGHTNING_LIB_OPEN_CHANNEL_SYNC_METHOD} without a channel point`));
    });
  });
}
