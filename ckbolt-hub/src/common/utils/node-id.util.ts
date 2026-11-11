import { FIBER_NODE_ID_PATTERN, LN_NODE_URI_PATTERN, LN_PUBKEY_PATTERN } from "../constants/protocol.constants";
import { canonicalHex } from "./hex.util";

/** True for a Fiber node id (a compressed public key), with or without 0x, in either case. */
export const isFiberNodeId = (value: string): boolean => FIBER_NODE_ID_PATTERN.test(value);

/** A node's public key as the hub writes and compares it: lower-case hex without 0x (fnn accepts both). */
export const toNodeId = (value: string): string => canonicalHex(value);

/** True for a Lightning node's public key (33 bytes of hex starting with 02 or 03), in either case. */
export const isLnPubkey = (value: string): boolean => LN_PUBKEY_PATTERN.test(value);

/** A Lightning node's public key as LND writes and compares it: lower-case hex. */
export const toLnPubkey = (value: string): string => canonicalHex(value);

/** True for a Lightning node URI a wallet can add as a peer: pubkey@host:port. */
export const isLnNodeUri = (value: string): boolean => LN_NODE_URI_PATTERN.test(value);
