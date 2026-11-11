import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CKB_GENESIS_HASH } from "../../../src/common/constants/protocol.constants";
import { btcNetworkOfChainIds, ckbNetworkOfChainHash } from "../../../src/common/utils/chain.util";
import type { BtcNetwork } from "../../../src/domain/types";

/**
 * A node's real network from the chain it names (GET /v1/health compares it with the hub's configuration):
 * - fnn: node_info `chain_hash` is the CKB genesis hash; testnet and mainnet by their genesis, anything else a devnet;
 * - LND: the `lightning` package's getWalletInfo `chains` are genesis hashes with the byte order reversed.
 * The expected hashes come from independent sources: docs/research/fiber-node.md section 4.1 and the CKB networks'
 * published genesis blocks, and the `lightning` package's own chain table (bolt02/ids.json).
 */

/** CKB testnet (Pudge) genesis, as docs/research/fiber-node.md 4.1 gives the testnet `chain_hash`. */
const CKB_TESTNET_CHAIN_HASH = "0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606";
/** CKB mainnet (Lina) genesis. */
const CKB_MAINNET_CHAIN_HASH = "0x92b197aa1fba0f63633922c61c92375c9c074a93e85963554f5499fe1450d0e5";
/** The chain_hash the local devnet's fnn-hub answered node_info with (2026-10-23). */
const LOCAL_DEVNET_CHAIN_HASH = "0xeac93bcfaad487169f94615169b26f8363de2a70ade4dbb6c602859b43109f32";

/** The `lightning` package's chain table: "<chain><network>" -> genesis hash as explorers show it. */
const LIGHTNING_PACKAGE_CHAINS = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "..", "node_modules", "lightning", "bolt02", "ids.json"), "utf8"),
) as { chains: Record<string, string> };

/** What getWalletInfo puts in `chains` for a chain: the package reverses the genesis bytes (bolt02/chain_id.js). */
const chainIdOf = (packageKey: string): string => {
  const genesis = LIGHTNING_PACKAGE_CHAINS.chains[packageKey];
  if (!genesis) throw new Error(`test setup: the lightning package has no chain ${packageKey}`);
  return Buffer.from(genesis, "hex").reverse().toString("hex");
};

describe("ckbNetworkOfChainHash (fnn node_info chain_hash -> CKB network)", () => {
  it("knows the public CKB networks by their genesis hashes", () => {
    expect(ckbNetworkOfChainHash(CKB_TESTNET_CHAIN_HASH)).toBe("testnet");
    expect(ckbNetworkOfChainHash(CKB_MAINNET_CHAIN_HASH)).toBe("mainnet");
  });

  it("names the genesis hashes in named constants that match the published ones", () => {
    expect(CKB_GENESIS_HASH).toEqual({ testnet: CKB_TESTNET_CHAIN_HASH, mainnet: CKB_MAINNET_CHAIN_HASH });
  });

  it("reads any other chain as a devnet (each devnet has its own genesis)", () => {
    expect(ckbNetworkOfChainHash(LOCAL_DEVNET_CHAIN_HASH)).toBe("devnet");
    expect(ckbNetworkOfChainHash(`0x${"10".repeat(32)}`)).toBe("devnet");
    expect(ckbNetworkOfChainHash(`0x${"00".repeat(32)}`)).toBe("devnet");
  });

  it("compares hashes without regard to the 0x prefix or the letter case", () => {
    expect(ckbNetworkOfChainHash(CKB_TESTNET_CHAIN_HASH.slice(2))).toBe("testnet");
    expect(ckbNetworkOfChainHash(CKB_MAINNET_CHAIN_HASH.toUpperCase().replace("0X", "0x"))).toBe("mainnet");
  });

  it("never mistakes a hash that only shares a prefix with a public genesis for that network", () => {
    expect(ckbNetworkOfChainHash(CKB_TESTNET_CHAIN_HASH.slice(0, -2))).toBe("devnet");
    expect(ckbNetworkOfChainHash(`${CKB_MAINNET_CHAIN_HASH}00`)).toBe("devnet");
  });
});

describe("btcNetworkOfChainIds (LND getWalletInfo chains -> Bitcoin network)", () => {
  it.each<[string, BtcNetwork]>([
    ["bitcoinmainnet", "mainnet"],
    ["bitcointestnet", "testnet"],
    ["bitcointestnet4", "testnet4"],
    ["bitcoinsignet", "signet"],
    ["bitcoinregtest", "regtest"],
  ])("reads the package's chain id of %s as %s", (packageKey, network) => {
    expect(btcNetworkOfChainIds([chainIdOf(packageKey)])).toBe(network);
  });

  it("is null for a chain the hub does not know (litecoin) and for no chain at all", () => {
    expect(btcNetworkOfChainIds([chainIdOf("litecoinmainnet")])).toBeNull();
    expect(btcNetworkOfChainIds([chainIdOf("litecointestnet")])).toBeNull();
    expect(btcNetworkOfChainIds([])).toBeNull();
  });

  it("takes the first chain it knows when the node lists several", () => {
    expect(btcNetworkOfChainIds([chainIdOf("litecoinregtest"), chainIdOf("bitcoinsignet"), chainIdOf("bitcoinregtest")])).toBe("signet");
  });

  it("does not read the genesis hash itself (not reversed) as that network", () => {
    const signetGenesisAsExplorersShowIt = LIGHTNING_PACKAGE_CHAINS.chains.bitcoinsignet ?? "";
    expect(btcNetworkOfChainIds([signetGenesisAsExplorersShowIt])).not.toBe("signet");
  });

  it("is null for a malformed chain id instead of throwing", () => {
    expect(btcNetworkOfChainIds(["zz"])).toBeNull();
    expect(btcNetworkOfChainIds([""])).toBeNull();
    expect(btcNetworkOfChainIds(["0x"])).toBeNull();
  });
});
