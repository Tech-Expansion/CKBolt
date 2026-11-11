import { JSON_RPC_VERSION } from "../../../src/common/constants/fiber-rpc.constants";
import { fromHexQuantity } from "../../../src/common/utils/amount.util";
import type { FnnScript } from "./fiber";
import { isSuccess, parseJsonBody, type HttpClient } from "./http";

const GET_CELLS_CAPACITY = "get_cells_capacity";
const LOCK_SCRIPT_TYPE = "lock";
const EXACT_SEARCH = "exact";

interface JsonRpcAnswer<T> {
  result?: T;
  error?: { message: string };
}

/**
 * The public CKB testnet RPC (with its indexer), called from this machine: how much CKB an fnn wallet holds on chain,
 * which fnn's own RPC does not tell.
 */
export class CkbRpc {
  constructor(
    private readonly http: HttpClient,
    private readonly url: string,
    private readonly timeoutMs: number,
  ) {}

  /** Shannons in the live cells locked by `lock` (the node's default_funding_lock_script). */
  async capacityOf(lock: FnnScript): Promise<bigint> {
    const description = `${GET_CELLS_CAPACITY} on ${this.url}`;
    const response = await this.http({
      method: "POST",
      url: this.url,
      json: {
        jsonrpc: JSON_RPC_VERSION,
        id: 1,
        method: GET_CELLS_CAPACITY,
        params: [{ script: lock, script_type: LOCK_SCRIPT_TYPE, script_search_mode: EXACT_SEARCH }],
      },
      timeoutMs: this.timeoutMs,
    });
    if (!isSuccess(response.status)) throw new Error(`${description}: HTTP ${response.status}`);
    const answer = parseJsonBody<JsonRpcAnswer<{ capacity: string } | null>>(response, description);
    if (answer.error) throw new Error(`${description}: ${answer.error.message}`);
    return answer.result ? fromHexQuantity(answer.result.capacity) : 0n;
  }
}
