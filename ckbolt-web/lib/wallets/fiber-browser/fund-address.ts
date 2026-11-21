import type { NodePresence } from "./bridge-protocol";
import { addressToScript, type CkbAddressNetwork } from "./ckb-address";
import { sameScript } from "./scripts";

/**
 * Security review W7: the funding page (/app/fiber/fund?address=…) sends CKB from the visitor's L1 wallet only to the
 * browser node's own address. A link can carry anyone's address, so the address in the URL is only a claim: the page
 * confirms it against the node itself (its tab answers the bridge's status with its address) or, while no node tab
 * runs, against the address the node kept next to its key in this browser. A link to any other address funds nothing.
 */

/** The same lock on the same network, however each address is written (full, short or a deprecated full format). */
export function sameCkbAddress(a: string, b: string): boolean {
  try {
    const left = addressToScript(a);
    const right = addressToScript(b);
    return left.network === right.network && sameScript(left.script, right.script);
  } catch {
    return false;
  }
}

/** `address` when it is a CKB address on `network`, else null. */
function onNetwork(address: unknown, network: CkbAddressNetwork): string | null {
  if (typeof address !== "string") return null;
  try {
    return addressToScript(address).network === network ? address : null;
  } catch {
    return null;
  }
}

/**
 * The node's own address: the running node's, as its tab reports it over the bridge (same origin only), else the one
 * kept next to its key in this browser; null when neither is known.
 */
export function ownNodeAddress(presence: NodePresence | null, stored: string | null, network: CkbAddressNetwork): string | null {
  const reported = presence && presence.network === network ? onNetwork(presence.address, network) : null;
  return reported ?? onNetwork(stored, network);
}

/** What the funding page may offer for a link. */
export type FundTarget =
  /** The link has no CKB address for the node's network. */
  | { kind: "missing" }
  /** The link's address is the node's own: fund `address`, the node's own spelling of it. */
  | { kind: "own"; address: string }
  /** The link's address is someone else's; `own` is the node's. */
  | { kind: "mismatch"; own: string }
  /** No node tab answered and this browser keeps no address for the node, so the link cannot be confirmed. */
  | { kind: "unconfirmed" };

/** The target for the link's address (already checked to be on the node's network, or null) and the node's own. */
export function fundTarget(linkAddress: string | null, own: string | null): FundTarget {
  if (!linkAddress) return { kind: "missing" };
  if (!own) return { kind: "unconfirmed" };
  return sameCkbAddress(linkAddress, own) ? { kind: "own", address: own } : { kind: "mismatch", own };
}
