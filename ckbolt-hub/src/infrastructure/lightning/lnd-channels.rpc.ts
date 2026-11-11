import { getChainBalance, getChannels, getPeers, getPendingChannels } from "lightning";
import { openChannelSync } from "./lnd-open-channel";

/**
 * The calls the channel adapter makes: the `lightning` package's reads (ListPeers, ListChannels, PendingChannels,
 * WalletBalance) and our OpenChannelSync. Injected through the adapter's constructor, so tests can hand it fakes.
 */
export const lndChannelsRpc = {
  getChainBalance,
  getChannels,
  getPeers,
  getPendingChannels,
  openChannelSync,
};

export type LndChannelsRpc = typeof lndChannelsRpc;
