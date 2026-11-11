import { BTC_GENESIS_HASH, CKB_GENESIS_HASH, CKB_OTHER_CHAIN_NETWORK } from "../constants/protocol.constants";
import type { BtcNetwork, CkbNetwork } from "../../domain/types";
import { reverseHexBytes, with0x } from "./hex.util";

/** Which network a node really runs on, from the chain it names (not from the hub's configuration). */

const sameHash = (a: string, b: string): boolean => with0x(a).toLowerCase() === with0x(b).toLowerCase();

/** The Bitcoin network whose genesis hash, byte order reversed, is `chainId`; null for any other chain. */
function btcNetworkOfChainId(chainId: string): BtcNetwork | null {
  const genesis = reverseHexBytes(chainId);
  const networks = Object.keys(BTC_GENESIS_HASH) as BtcNetwork[];
  return networks.find((network) => sameHash(BTC_GENESIS_HASH[network], genesis)) ?? null;
}

/**
 * The Bitcoin network of an LND node from the chain ids its getinfo lists (the `lightning` package's getWalletInfo
 * `chains`): the first one the hub knows, or null when it knows none of them.
 */
export function btcNetworkOfChainIds(chainIds: readonly string[]): BtcNetwork | null {
  for (const chainId of chainIds) {
    const network = btcNetworkOfChainId(chainId);
    if (network !== null) return network;
  }
  return null;
}

/** The CKB network of an fnn node from its `node_info.chain_hash`: mainnet or testnet by genesis hash, else devnet. */
export function ckbNetworkOfChainHash(chainHash: string): CkbNetwork {
  const networks = Object.keys(CKB_GENESIS_HASH) as Exclude<CkbNetwork, "devnet">[];
  return networks.find((network) => sameHash(CKB_GENESIS_HASH[network], chainHash)) ?? CKB_OTHER_CHAIN_NETWORK;
}
