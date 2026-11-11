import type { Script } from "@/lib/hub/contract";
import { decodeBech32, encodeBech32, fromWords, toWords } from "@/lib/bech32";
import { validateCkbAddress } from "@/lib/payment-request";
import { fromHexBytes, toHexBytes } from "./hex";
import {
  CKB_ADDRESS_PREFIX,
  CKB_FULL_ADDRESS_FORMAT,
  CKB_FULL_DATA_ADDRESS_FORMAT,
  CKB_FULL_TYPE_ADDRESS_FORMAT,
  CKB_HASH_TYPE_BYTE,
  CKB_SHORT_ADDRESS_FORMAT,
  CKB_SHORT_ADDRESS_LOCKS,
} from "./constants";

const CODE_HASH_BYTES = 32;

export type CkbAddressNetwork = "mainnet" | "testnet";

/** The full-format CKB address (RFC 0021, bech32m) of a lock script: where to send CKB to the node. */
export function scriptToAddress(script: Script, network: CkbAddressNetwork): string {
  const codeHash = fromHexBytes(script.codeHash);
  if (codeHash.length !== CODE_HASH_BYTES) throw new Error("A lock script's code hash has 32 bytes.");
  const args = fromHexBytes(script.args);
  const payload = new Uint8Array(1 + CODE_HASH_BYTES + 1 + args.length);
  payload[0] = CKB_FULL_ADDRESS_FORMAT;
  payload.set(codeHash, 1);
  payload[1 + CODE_HASH_BYTES] = CKB_HASH_TYPE_BYTE[script.hashType];
  payload.set(args, 2 + CODE_HASH_BYTES);
  return encodeBech32(CKB_ADDRESS_PREFIX[network], toWords(payload), "bech32m");
}

const HASH_TYPE_OF_BYTE = new Map(Object.entries(CKB_HASH_TYPE_BYTE).map(([name, byte]) => [byte, name as Script["hashType"]]));

/**
 * The lock script a CKB address (RFC 0021) stands for, and its network: the full format, the deprecated full formats
 * and the short format of the three known locks. Throws with a sentence when the text is not such an address.
 */
export function addressToScript(address: string): { network: CkbAddressNetwork; script: Script } {
  const text = address.trim();
  const network = validateCkbAddress(text);
  const bytes = fromWords(decodeBech32(text).words);
  const format = bytes[0];
  if (format === CKB_SHORT_ADDRESS_FORMAT) {
    const codeHash = CKB_SHORT_ADDRESS_LOCKS[network][bytes[1]];
    if (!codeHash) throw new Error("This short CKB address names an unknown lock. Use the full address.");
    return { network, script: { codeHash, hashType: "type", args: toHexBytes(bytes.slice(2)) } };
  }
  const codeHash = toHexBytes(bytes.slice(1, 1 + CODE_HASH_BYTES));
  if (format === CKB_FULL_ADDRESS_FORMAT) {
    const hashType = HASH_TYPE_OF_BYTE.get(bytes[1 + CODE_HASH_BYTES]);
    if (!hashType) throw new Error("This CKB address names an unknown hash type.");
    return { network, script: { codeHash, hashType, args: toHexBytes(bytes.slice(2 + CODE_HASH_BYTES)) } };
  }
  const hashType: Script["hashType"] = format === CKB_FULL_TYPE_ADDRESS_FORMAT ? "type" : "data";
  if (format !== CKB_FULL_DATA_ADDRESS_FORMAT && format !== CKB_FULL_TYPE_ADDRESS_FORMAT) throw new Error("This is not a CKB address.");
  return { network, script: { codeHash, hashType, args: toHexBytes(bytes.slice(1 + CODE_HASH_BYTES)) } };
}
