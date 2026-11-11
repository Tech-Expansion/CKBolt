import { without0x } from "../../../src/common/utils/hex.util";
import { CKB_ADDRESS_PREFIX, CKB_FULL_ADDRESS_FORMAT, CKB_HASH_TYPE_BYTE } from "./constants";
import type { FnnScript } from "./fiber";

/** Bech32m (BIP 350), which CKB's full address format uses (RFC 0021). No length limit: CKB addresses exceed 90. */
const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32M_CONSTANT = 0x2bc830a3;
const BECH32_GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const BECH32_SEPARATOR = "1";
const CHECKSUM_GROUPS = 6;
const GROUP_BITS = 5;
const GROUP_MASK = (1 << GROUP_BITS) - 1;
const BYTE_BITS = 8;
/** The running checksum is 30 bits (six 5-bit groups); its top group picks the generators to mix in. */
const TOP_GROUP_SHIFT = (CHECKSUM_GROUPS - 1) * GROUP_BITS;
const BELOW_TOP_GROUP_MASK = (1 << TOP_GROUP_SHIFT) - 1;

function polymod(values: readonly number[]): number {
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> TOP_GROUP_SHIFT;
    checksum = ((checksum & BELOW_TOP_GROUP_MASK) << GROUP_BITS) ^ value;
    BECH32_GENERATOR.forEach((generator, bit) => {
      if ((top >>> bit) & 1) checksum ^= generator;
    });
  }
  return checksum >>> 0;
}

const expandPrefix = (prefix: string): number[] => {
  const codes = [...prefix].map((char) => char.charCodeAt(0));
  return [...codes.map((code) => code >>> GROUP_BITS), 0, ...codes.map((code) => code & GROUP_MASK)];
};

/** Regroups bytes into 5-bit groups, the last one padded with zero bits. */
function toFiveBitGroups(bytes: Uint8Array): number[] {
  const groups: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const byte of bytes) {
    accumulator = (accumulator << BYTE_BITS) | byte;
    bits += BYTE_BITS;
    while (bits >= GROUP_BITS) {
      bits -= GROUP_BITS;
      groups.push((accumulator >>> bits) & GROUP_MASK);
    }
    accumulator &= (1 << bits) - 1;
  }
  if (bits > 0) groups.push((accumulator << (GROUP_BITS - bits)) & GROUP_MASK);
  return groups;
}

export function encodeBech32m(prefix: string, bytes: Uint8Array): string {
  const data = toFiveBitGroups(bytes);
  const mod = polymod([...expandPrefix(prefix), ...data, ...new Array<number>(CHECKSUM_GROUPS).fill(0)]) ^ BECH32M_CONSTANT;
  const checksum = Array.from({ length: CHECKSUM_GROUPS }, (_, index) => (mod >>> (GROUP_BITS * (CHECKSUM_GROUPS - 1 - index))) & GROUP_MASK);
  return `${prefix}${BECH32_SEPARATOR}${[...data, ...checksum].map((group) => BECH32_CHARSET[group]).join("")}`;
}

/** The full-format CKB address of a lock script (what wallets and faucets take): ckt1... on testnet, ckb1... on mainnet. */
export function ckbAddress(lock: FnnScript, network: keyof typeof CKB_ADDRESS_PREFIX): string {
  const hashType = CKB_HASH_TYPE_BYTE[lock.hash_type];
  if (hashType === undefined) throw new Error(`Unknown CKB script hash type: ${lock.hash_type}`);
  const payload = Buffer.concat([
    Buffer.from([CKB_FULL_ADDRESS_FORMAT]),
    Buffer.from(without0x(lock.code_hash), "hex"),
    Buffer.from([hashType]),
    Buffer.from(without0x(lock.args), "hex"),
  ]);
  return encodeBech32m(CKB_ADDRESS_PREFIX[network], payload);
}
