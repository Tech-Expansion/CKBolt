import type { Network } from "@/lib/bolt11";
import { lightningNetworkLabel } from "@/lib/hub/format";
import { LN_WALLET_MESSAGE } from "./messages";

/**
 * Names wallets and the hub use for Bitcoin networks, mapped to the invoice family their BOLT11 prefix shows (lnbc,
 * lntb, lntbs, lnbcrt). Some report "bitcoin" for mainnet; testnet3 and testnet4 share "lntb".
 */
const NETWORK_FAMILY: Readonly<Record<string, Network>> = {
  mainnet: "mainnet",
  bitcoin: "mainnet",
  testnet: "testnet",
  testnet3: "testnet",
  testnet4: "testnet",
  signet: "signet",
  regtest: "regtest",
};

/** The invoice family of a network name (case-insensitive), or null for an empty or unknown name. */
export function toNetworkFamily(name: string | null | undefined): Network | null {
  const key = name?.trim().toLowerCase();
  return key ? (NETWORK_FAMILY[key] ?? null) : null;
}

/** The hub's Lightning network for a sentence: "Bitcoin signet", or "a Bitcoin test network" when it did not say. */
export const hubNetworkLabel = (network: string | null | undefined): string =>
  network?.trim() ? lightningNetworkLabel(network) : LN_WALLET_MESSAGE.UNKNOWN_HUB_NETWORK;
