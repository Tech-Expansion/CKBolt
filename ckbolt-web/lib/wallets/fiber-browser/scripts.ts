import type { Script } from "@/lib/hub/contract";
import type { RpcScript } from "./rpc-types";

export const scriptFromRpc = (script: RpcScript): Script => ({
  codeHash: script.code_hash,
  hashType: script.hash_type,
  args: script.args,
});

export const scriptToRpc = (script: Script): RpcScript => ({
  code_hash: script.codeHash,
  hash_type: script.hashType,
  args: script.args,
});

/** Same script, comparing hex without regard to case. */
export const sameScript = (a: Script, b: Script): boolean =>
  a.codeHash.toLowerCase() === b.codeHash.toLowerCase() && a.hashType === b.hashType && a.args.toLowerCase() === b.args.toLowerCase();
