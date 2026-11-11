import type { BtcNetwork } from "../../domain/types";

/** The hub's Lightning node as Lightning wallets see it: GET /v1/lightning/node. */
export interface HubLightningNode {
  pubkey: string;
  /** The Bitcoin network the node runs on, as the node itself reports it; null for a chain the hub does not know. */
  network: BtcNetwork | null;
  /** pubkey@host:port URIs a wallet adds the node as a peer with: LN_PUBLIC_URIS, else the ones the node announces. */
  uris: string[];
  /** Whether the node opens inbound channels to wallets, and their size and push (sats; the configured values). */
  inbound: { enabled: boolean; capacitySats: bigint; pushSats: bigint };
}

export interface LightningNodeService {
  /** Reads the node's key, network and URIs from the node; throws 503 upstream_unavailable when it does not answer. */
  describe(): Promise<HubLightningNode>;
  /** The URIs a wallet adds the node as a peer with (as in describe); throws 503 when the node must be asked and does not answer. */
  uris(): Promise<string[]>;
}

export const LIGHTNING_NODE_SERVICE = Symbol("LIGHTNING_NODE_SERVICE");
