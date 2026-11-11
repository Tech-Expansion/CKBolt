import { randomBytes } from "node:crypto";
import { cccA } from "@ckb-ccc/core/advanced";

/*
 * Test doubles for "bring your own Fiber node" (tests/unit/fiber-byo.spec.ts and tests/e2e/fund-fiber-node.spec.ts): a CKB
 * testnet node and indexer that answers the JSON-RPC calls CCC makes to read a wallet and send a transfer. It keeps a
 * set of live cells, records every call and every transaction sent, and never touches a real network.
 */

export interface Script {
  codeHash: string;
  hashType: "type" | "data" | "data1" | "data2";
  args: string;
}

export interface ChainCell {
  txHash: string;
  index: number;
  capacity: bigint;
  lock: Script;
  type: Script | null;
  data: string;
}

/** CKB testnet's secp256k1-blake160 lock, the lock of a plain wallet or Fiber node address. */
export const SECP256K1_TESTNET = {
  codeHash: "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8",
  hashType: "type",
} as const;

/** The public CKB testnet endpoints CCC's default testnet client talks to. */
export const CKB_TESTNET_RPC = {
  WS: "wss://testnet.ckb.dev/ws",
  HTTP: ["https://testnet.ckb.dev/**", "https://testnet.ckbapp.dev/**"],
} as const;

export const SHANNONS_PER_CKB = BigInt(100_000_000);
/** Whole CKB (or whole RUSD, also 8 decimals) in base units. */
export const units = (whole: number | string): bigint => BigInt(whole) * SHANNONS_PER_CKB;

export const randomHex = (bytes: number): string => `0x${randomBytes(bytes).toString("hex")}`;
export const secpLock = (args: string = randomHex(20)): Script => ({ ...SECP256K1_TESTNET, args });

const UDT_BYTES = 16;
/** A UDT cell's data: the amount as 16 bytes, little endian. */
export function udtData(amount: bigint): string {
  let hex = "";
  let rest = amount;
  for (let i = 0; i < UDT_BYTES; i++) {
    hex += Number(rest & BigInt(0xff)).toString(16).padStart(2, "0");
    rest >>= BigInt(8);
  }
  return `0x${hex}`;
}
export function readUdtData(data: string): bigint {
  const bytes = data.slice(2, 2 + UDT_BYTES * 2).match(/.{2}/g) ?? [];
  return bytes.reduceRight((acc, b) => (acc << BigInt(8)) + BigInt(parseInt(b, 16)), BigInt(0));
}

/* ---------------------------------------------------------------------------------------- RPC shapes */

export interface RpcScript {
  code_hash: string;
  hash_type: string;
  args: string;
}
export interface RpcOutput {
  capacity: string;
  lock: RpcScript;
  type?: RpcScript | null;
}
export interface RpcTransaction {
  version: string;
  cell_deps: { out_point: { tx_hash: string; index: string }; dep_type: string }[];
  header_deps: string[];
  inputs: { previous_output: { tx_hash: string; index: string }; since: string }[];
  outputs: RpcOutput[];
  outputs_data: string[];
  witnesses: string[];
}
interface SearchKey {
  script: RpcScript;
  script_type: "lock" | "type";
  script_search_mode?: "prefix" | "exact" | "partial";
  filter?: {
    script?: RpcScript;
    script_len_range?: [string, string];
    output_data_len_range?: [string, string];
    output_capacity_range?: [string, string];
  } | null;
  with_data?: boolean;
}
export interface JsonRpcRequest {
  id: number;
  jsonrpc: string;
  method: string;
  params: unknown[];
}

const hex = (n: bigint | number): string => `0x${BigInt(n).toString(16)}`;
export const toRpcScript = (s: Script): RpcScript => ({ code_hash: s.codeHash, hash_type: s.hashType, args: s.args });
export const fromRpcScript = (s: RpcScript): Script => ({ codeHash: s.code_hash, hashType: s.hash_type as Script["hashType"], args: s.args });
export const sameScript = (a: Script | RpcScript | null | undefined, b: Script | RpcScript | null | undefined): boolean => {
  if (!a || !b) return !a && !b;
  const x = "codeHash" in a ? a : fromRpcScript(a);
  const y = "codeHash" in b ? b : fromRpcScript(b);
  return x.codeHash.toLowerCase() === y.codeHash.toLowerCase() && x.hashType === y.hashType && x.args.toLowerCase() === y.args.toLowerCase();
};

const byteLength = (hexText: string): number => (hexText.length - 2) / 2;
/** A script's occupied size, as the indexer's script_len_range counts it: code hash, hash type and args. */
const scriptLength = (script: Script | null): number => (script ? 33 + byteLength(script.args) : 0);
const inRange = (value: number | bigint, range: [string, string] | undefined): boolean =>
  !range || (BigInt(value) >= BigInt(range[0]) && BigInt(value) < BigInt(range[1]));

function matchesScript(cell: Script | null, wanted: RpcScript, mode: SearchKey["script_search_mode"]): boolean {
  if (!cell) return false;
  const w = fromRpcScript(wanted);
  if (cell.codeHash.toLowerCase() !== w.codeHash.toLowerCase() || cell.hashType !== w.hashType) return false;
  return mode === "exact" ? cell.args.toLowerCase() === w.args.toLowerCase() : cell.args.toLowerCase().startsWith(w.args.toLowerCase());
}

const rpcCell = (c: ChainCell, withData: boolean) => ({
  block_number: "0x10",
  out_point: { tx_hash: c.txHash, index: hex(c.index) },
  output: { capacity: hex(c.capacity), lock: toRpcScript(c.lock), type: c.type ? toRpcScript(c.type) : null },
  output_data: withData ? c.data : null,
  tx_index: "0x0",
});

/** The hash CKB gives a transaction sent over RPC. */
export const rpcTransactionHash = (tx: RpcTransaction): string => cccA.JsonRpcTransformers.transactionTo(tx as never).hash();

/** A JSON-RPC error the CKB node answers with. */
export interface RpcError {
  code: number;
  message: string;
}

/**
 * A CKB testnet node with an indexer, as far as CCC uses it to read balances, collect cells and send a transaction.
 * Unknown methods answer a JSON-RPC error and are recorded, so a test can see what it did not expect.
 */
export class FakeCkbChain {
  readonly cells: ChainCell[] = [];
  readonly calls: JsonRpcRequest[] = [];
  readonly sent: RpcTransaction[] = [];
  readonly unknown: string[] = [];
  /** What send_transaction answers; by default the transaction's hash, as a node would. */
  onSend: (tx: RpcTransaction) => { result: string } | { error: RpcError } = (tx) => ({ result: rpcTransactionHash(tx) });

  addCell(cell: Partial<ChainCell> & Pick<ChainCell, "lock" | "capacity">): ChainCell {
    const full: ChainCell = { txHash: randomHex(32), index: 0, type: null, data: "0x", ...cell };
    this.cells.push(full);
    return full;
  }

  count(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }

  handle(request: JsonRpcRequest): { id: number; jsonrpc: string; result?: unknown; error?: RpcError } {
    this.calls.push(request);
    const answer = (result: unknown) => ({ id: request.id, jsonrpc: "2.0", result });
    const fail = (error: RpcError) => ({ id: request.id, jsonrpc: "2.0", error });
    switch (request.method) {
      case "get_cells": {
        const [key, , , cursor] = request.params as [SearchKey, string, string, string | null | undefined];
        // One page holds every match; the page after it is empty.
        if (cursor) return answer({ last_cursor: cursor, objects: [] });
        const found = this.search(key);
        return answer({ last_cursor: "0x01", objects: found.map((c) => rpcCell(c, key.with_data !== false)) });
      }
      case "get_cells_capacity": {
        const [key] = request.params as [SearchKey];
        const capacity = this.search(key).reduce((sum, c) => sum + c.capacity, BigInt(0));
        return answer({ capacity: hex(capacity), block_hash: randomHex(32), block_number: "0x10" });
      }
      case "get_fee_rate_statistics":
        return answer({ mean: "0x3e8", median: "0x3e8" });
      case "get_live_cell": {
        const [outPoint] = request.params as [{ tx_hash: string; index: string }];
        const cell = this.cells.find((c) => c.txHash === outPoint.tx_hash && hex(c.index) === outPoint.index);
        if (!cell) return answer({ cell: null, status: "unknown" });
        const { output, output_data } = rpcCell(cell, true);
        return answer({ cell: { output, data: { content: output_data, hash: randomHex(32) } }, status: "live" });
      }
      case "send_transaction": {
        const [tx] = request.params as [RpcTransaction];
        const outcome = this.onSend(tx);
        if ("error" in outcome) return fail(outcome.error);
        this.sent.push(tx);
        return answer(outcome.result);
      }
      default:
        this.unknown.push(request.method);
        return fail({ code: -32601, message: `Method not found: ${request.method}` });
    }
  }

  private search(key: SearchKey): ChainCell[] {
    const filter = key.filter ?? {};
    return this.cells.filter((c) => {
      const primary = key.script_type === "lock" ? c.lock : c.type;
      const other = key.script_type === "lock" ? c.type : c.lock;
      if (!matchesScript(primary, key.script, key.script_search_mode)) return false;
      if (filter.script && !matchesScript(other, filter.script, "prefix")) return false;
      if (!inRange(scriptLength(other), filter.script_len_range)) return false;
      if (!inRange(byteLength(c.data), filter.output_data_len_range)) return false;
      if (!inRange(c.capacity, filter.output_capacity_range)) return false;
      return true;
    });
  }
}
