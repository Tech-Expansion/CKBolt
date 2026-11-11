import type { CkbNetwork, FiberAsset } from "../../domain/types";

/** What the hub funds one inbound channel with in an asset it serves, in the asset's base units. */
export interface InboundOffer {
  asset: FiberAsset;
  amount: bigint;
  /**
   * For a UDT: the auto_accept_amount a browser node whitelists so it takes the channel without a manual accept (at most
   * `amount`). null for CKB, whose channel a browser node accepts by hand.
   */
  autoAcceptAmount: bigint | null;
}

/**
 * Channels a node may open to the hub's node in a UDT with its own tokens (FIBER_ASSETS peerChannels): the hub's node
 * accepts one funded with at least `minAmount` (base units) on its own and adds no tokens.
 */
export interface PeerChannelOffer {
  asset: FiberAsset;
  minAmount: bigint;
  /**
   * The commitment delay (epochs) the hub counts for such a channel whatever its opener chose (fnn does not report it):
   * the longest fnn accepts. The hold invoices in the asset are sized for it.
   */
  assumedCommitmentDelayEpochs: number;
}

/** An offer with whether the hub's payout liquidity lets it fund one now. */
export interface InboundOfferState extends InboundOffer {
  fundable: boolean | null;
}

/** The hub's Fiber node as other Fiber nodes (a browser node, Fiber Studio) see it: GET /v1/fiber/node. */
export interface HubFiberNode {
  nodeId: string;
  /** The CKB network the node runs on, as the node itself reports it. */
  network: CkbNetwork;
  /** Multiaddrs to dial the node at: native TCP (`p2p`) and WebSocket (`ws`, the only kind a browser node can dial). */
  addresses: { p2p: string[]; ws: string[] };
  /** The assets the hub swaps on its network, each UDT with what a Fiber node needs to whitelist it (script, cell deps). */
  assets: FiberAsset[];
  /**
   * Whether the node opens inbound channels, and with how much per asset (none when disabled). `fundable` says per offer
   * whether the hub could fund it now (the check POST /v1/fiber/inbound-channels makes); null when the node's channels
   * could not be read.
   */
  inbound: { enabled: boolean; offers: InboundOfferState[] };
  /**
   * The UDTs a node may open its own channel to the hub in, in the registry's order. Empty while nodes have opened as
   * many such channels as FIBER_PEER_CHANNELS_MAX_OPEN allows (every UDT together, any state but closed), or when the
   * node's channels could not be read.
   */
  peerChannels: PeerChannelOffer[];
}

export interface FiberNodeService {
  /** Reads the node's id and network from the node; throws 503 upstream_unavailable when it does not answer. */
  describe(): Promise<HubFiberNode>;
}

export const FIBER_NODE_SERVICE = Symbol("FIBER_NODE_SERVICE");
