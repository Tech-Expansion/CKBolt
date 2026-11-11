import type { LN_CHANNEL_STATE } from "../../common/constants/lightning-node.constants";

/**
 * What the hub needs from its Lightning node to open channels to wallets, through a credential that can do nothing else
 * (LND_CHANNELS_MACAROON_PATH: GetInfo, ListPeers, ListChannels, PendingChannels, WalletBalance, OpenChannelSync).
 * Implemented on LND (src/infrastructure/lightning) and by FakeLightningChannels (test/fakes). Amounts are bigint sats;
 * public keys lower-case hex.
 *
 * Errors every implementation keeps to (as LightningPort): a node that cannot be reached, or a call whose outcome is
 * unknown, throws a 503 `upstream_unavailable` HubError; anything else the node answers unexpectedly throws a plain
 * Error. openChannel throws a plain Error when the node refuses the channel (nothing was opened).
 */

export type LnChannelState = (typeof LN_CHANNEL_STATE)[keyof typeof LN_CHANNEL_STATE];

/** A channel of the node that is not closed: open (`ready`), pending open (`opening`) or pending close (`closing`). */
export interface LnChannel {
  /** The funding outpoint, txid:vout. */
  channelPoint: string;
  /** The other side's public key. */
  peer: string;
  state: LnChannelState;
  capacitySats: bigint;
  /** What the node can still send over the channel, and what the peer can. */
  localSats: bigint;
  remoteSats: bigint;
  private: boolean;
  openedByPeer: boolean;
  /** The channel's memo (LND's immutable description, set by the opener); null when it has none. */
  memo: string | null;
}

export interface OpenLnChannelArgs {
  /** A peer connected to the node. */
  peer: string;
  capacitySats: bigint;
  /** What of the capacity starts on the peer's side; below the capacity. */
  pushSats: bigint;
  /** Not announced to the network: payers reach it only through route hints. */
  private: boolean;
  memo: string;
}

/** A channel the node has started to open: its funding transaction is published. */
export interface LnChannelOpening {
  fundingTxid: string;
  outputIndex: number;
}

export interface LightningChannelsPort {
  /** Whether the node is connected to `pubkey` right now (ListPeers). */
  isConnected(pubkey: string): Promise<boolean>;
  /** Every channel that is not closed (opening and closing ones included); only those with `peer` when it is given. */
  listChannels(peer?: string): Promise<LnChannel[]>;
  /** The node's confirmed on-chain balance, sats: what it can fund a channel from. */
  confirmedOnchainSats(): Promise<bigint>;
  /**
   * Opens a channel funded from the node's on-chain wallet, from confirmed outputs only, with the static_remote_key
   * commitment (no anchor outputs: LDK wallets refuse anchors unless they keep an on-chain reserve). Resolves once the
   * funding transaction is published.
   */
  openChannel(args: OpenLnChannelArgs): Promise<LnChannelOpening>;
}
