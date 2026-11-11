import { sha256 } from "@noble/hashes/sha2.js";
import { fromHexBytes } from "./hex";

/**
 * Fiber's P2P layer (tentacle) names a peer by a multihash of its public key: base58(0x12 0x20 || sha256(pubkey)), the
 * "Qm..." part of `/p2p/Qm...`. Checked against fnn 0.9.1's node_info. A multiaddr from the hub's config may lack that
 * part; the browser node dials it with the id added, so fnn knows whom it dials.
 */

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const MULTIHASH_SHA2_256 = 0x12;
const SHA256_BYTES = 32;
const P2P_COMPONENT = "/p2p/";

function base58(bytes: Uint8Array): string {
  const radix = BigInt(BASE58_ALPHABET.length);
  let value = BigInt(0);
  for (const byte of bytes) value = value * BigInt(256) + BigInt(byte);
  let out = "";
  while (value > BigInt(0)) {
    out = BASE58_ALPHABET[Number(value % radix)] + out;
    value = value / radix;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = BASE58_ALPHABET[0] + out;
  }
  return out;
}

/** The tentacle peer id of a Fiber node id (compressed public key, hex). */
export function peerIdOf(nodeId: string): string {
  const digest = sha256(fromHexBytes(nodeId));
  const multihash = new Uint8Array(2 + SHA256_BYTES);
  multihash[0] = MULTIHASH_SHA2_256;
  multihash[1] = SHA256_BYTES;
  multihash.set(digest, 2);
  return base58(multihash);
}

/** `address` with `/p2p/<peer id>` of `nodeId` appended, unless it already names a peer. */
export const withPeerId = (address: string, nodeId: string): string =>
  address.includes(P2P_COMPONENT) ? address : `${address.replace(/\/+$/, "")}${P2P_COMPONENT}${peerIdOf(nodeId)}`;
