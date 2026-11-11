import type { Script } from "@/lib/hub/contract";
import { HTTP_HEADER, JSON_CONTENT_TYPE } from "@/lib/hub/constants";
import { UDT_AMOUNT_BYTES } from "@/lib/wallets/fiber-byo/constants";
import { fromHexBytes, fromHexQuantity } from "./hex";
import { sameScript, scriptToRpc } from "./scripts";
import { JSON_RPC_VERSION, NODE_TIMING } from "./constants";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const GET_CELLS_CAPACITY = "get_cells_capacity";
const GET_CELLS = "get_cells";
/** Cells per page of get_cells, and the most pages read (a node holds a few token cells, not thousands). */
const CELLS_PAGE_SIZE = "0x64";
const MAX_CELL_PAGES = 20;
const SEARCH_ORDER = "asc";

/** The amount of a UDT cell (xUDT, sUDT): the first 16 bytes of its data, little endian; 0 for shorter data. */
export function readUdtAmount(data: unknown): bigint {
  if (typeof data !== "string") return BigInt(0);
  let bytes: Uint8Array;
  try {
    bytes = fromHexBytes(data);
  } catch {
    return BigInt(0);
  }
  if (bytes.length < UDT_AMOUNT_BYTES) return BigInt(0);
  let amount = BigInt(0);
  for (let i = UDT_AMOUNT_BYTES - 1; i >= 0; i--) amount = (amount << BigInt(8)) + BigInt(bytes[i]);
  return amount;
}

/** A script as the RPC writes it that is exactly `script`; false for anything missing or malformed. */
function isScriptOf(value: unknown, script: Script): boolean {
  if (typeof value !== "object" || value === null) return false;
  const { code_hash, hash_type, args } = value as Record<string, unknown>;
  if (typeof code_hash !== "string" || typeof args !== "string") return false;
  return hash_type === script.hashType && sameScript({ codeHash: code_hash, hashType: script.hashType, args }, script);
}

/** Indexer ranges are [from, to): "0x0".."0x1" means length zero. */
const EMPTY_RANGE = ["0x0", "0x1"];

/**
 * Reads the node's on-chain wallet from a public CKB JSON-RPC with indexer (CORS-enabled, so it loads on the isolated
 * page). This is a convenience for the page; the node itself watches the chain through the same URL.
 */
export class CkbRpcClient {
  constructor(
    private readonly url: string,
    private readonly fetchFn: FetchLike = (input, init) => fetch(input, init),
    private readonly timeoutMs: number = NODE_TIMING.rpcTimeoutMs,
  ) {}

  /**
   * Shannons in plain cells of `lock` (no type script, no data): what the node can spend on channel funding. Cells that
   * hold tokens such as RUSD are not counted.
   */
  async spendableCapacity(lock: Script): Promise<bigint> {
    const result = await this.call(GET_CELLS_CAPACITY, [
      {
        script: scriptToRpc(lock),
        script_type: "lock",
        filter: { script_len_range: EMPTY_RANGE, output_data_len_range: EMPTY_RANGE },
      },
    ]);
    // The indexer answers null for a lock it has never seen.
    if (result === null) return BigInt(0);
    if (typeof result !== "object") throw new Error("The CKB RPC sent an unreadable balance.");
    return fromHexQuantity((result as { capacity?: unknown }).capacity);
  }

  /**
   * Base units of the token `type` in the cells of `lock`, summed over every page of get_cells. The indexer matches both
   * scripts by prefix (its default search mode, and the only one for the filter), so a cell whose lock or type merely
   * starts with them (an xUDT with longer args, such as flags after the owner's lock hash, is another token) is left out.
   */
  async tokenAmount(lock: Script, type: Script): Promise<bigint> {
    const key = { script: scriptToRpc(lock), script_type: "lock", filter: { script: scriptToRpc(type) }, with_data: true };
    let cursor: string | null = null;
    let total = BigInt(0);
    for (let page = 0; page < MAX_CELL_PAGES; page++) {
      const result = await this.call(GET_CELLS, [key, SEARCH_ORDER, CELLS_PAGE_SIZE, cursor]);
      if (result === null) return total;
      const { objects, last_cursor: next } = result as { objects?: unknown; last_cursor?: unknown };
      if (!Array.isArray(objects)) throw new Error("The CKB RPC sent unreadable cells.");
      for (const cell of objects) {
        const { output, output_data: data } = (cell ?? {}) as { output?: { lock?: unknown; type?: unknown }; output_data?: unknown };
        if (isScriptOf(output?.lock, lock) && isScriptOf(output?.type, type)) total += readUdtAmount(data);
      }
      if (objects.length === 0 || typeof next !== "string") return total;
      cursor = next;
    }
    return total;
  }

  private async call(method: string, params: unknown[]): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchFn(this.url, {
        method: "POST",
        headers: { [HTTP_HEADER.CONTENT_TYPE]: JSON_CONTENT_TYPE },
        body: JSON.stringify({ id: 1, jsonrpc: JSON_RPC_VERSION, method, params }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new Error("The CKB RPC cannot be reached. Try again in a minute.");
    }
    if (!res.ok) throw new Error(`The CKB RPC answered ${res.status}. Try again in a minute.`);
    const body = (await res.json().catch(() => null)) as { result?: unknown; error?: { message?: string } } | null;
    if (!body || body.error) throw new Error(body?.error?.message ?? "The CKB RPC sent an unreadable answer.");
    return body.result ?? null;
  }
}
