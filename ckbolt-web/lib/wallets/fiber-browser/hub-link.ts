import type { FiberNodeDto } from "@/lib/hub/contract";
import { FIBER_NODE_ID_PATTERN } from "@/lib/hub/constants";
import type { BrowserFiberNode } from "./node-port";
import { fiberErrorMessage } from "./errors";
import { dialableAddresses } from "./node-config";
import { withPeerId } from "./peer-id";
import { normalizeNodeId } from "./hex";
import { storageKey, type KeyValueStore } from "./storage";
import { STORAGE_NAME } from "./constants";

/**
 * The hub node's WebSocket addresses this page can dial (TLS only when `secureOnly`, i.e. on an https page), each with
 * the hub's peer id, so fnn knows whom it dials.
 */
export function hubDialAddresses(hubNode: Pick<FiberNodeDto, "nodeId" | "addresses"> | null, secureOnly: boolean): string[] {
  if (!hubNode) return [];
  return dialableAddresses(hubNode.addresses.ws, secureOnly).map((address) => withPeerId(address, hubNode.nodeId));
}

export interface HubDialResult {
  /** The address that worked, or null. */
  address: string | null;
  /** The last error when none worked. */
  error: string | null;
}

/**
 * Dials the hub's node at each WebSocket address until one works. A WASM node cannot listen, so the hub can never dial
 * it: the browser always connects first, and fnn reconnects slowly by itself, so the page dials on every start.
 */
export async function dialHub(node: Pick<BrowserFiberNode, "connectPeer">, addresses: readonly string[]): Promise<HubDialResult> {
  let error: string | null = addresses.length === 0 ? "The hub lists no WebSocket address this page can dial." : null;
  for (const address of addresses) {
    try {
      await node.connectPeer(address);
      return { address, error: null };
    } catch (e) {
      error = fiberErrorMessage(e);
    }
  }
  return { address: null, error };
}

/** True when the hub's node is among the node's peers. */
export const isHubConnected = (peers: readonly string[], hubNodeId: string | null | undefined): boolean =>
  !!hubNodeId && peers.includes(hubNodeId);

const hubNodeIdKey = (network: string): string => storageKey(network, STORAGE_NAME.HUB_NODE_ID);

/** The hub's node id as last read on `network`, or null (none kept, not a node id, or storage blocked). */
export function readKnownHubNodeId(store: KeyValueStore | null, network: string): string | null {
  try {
    const kept = store?.getItem(hubNodeIdKey(network)) ?? "";
    return FIBER_NODE_ID_PATTERN.test(kept) ? normalizeNodeId(kept) : null;
  } catch {
    return null;
  }
}

/** Keeps the hub's node id for `network`, so it is known while the hub cannot be reached. */
export function rememberHubNodeId(store: KeyValueStore | null, network: string, nodeId: string): void {
  try {
    store?.setItem(hubNodeIdKey(network), normalizeNodeId(nodeId));
  } catch {
    // Blocked storage: the id is known while the page is open.
  }
}

/** Every id the hub is known by: as read now on any network, and as last read on this one. */
export const hubNodeIdsOf = (...ids: (string | null | undefined)[]): string[] =>
  [...new Set(ids.filter((id): id is string => !!id).map(normalizeNodeId))];
