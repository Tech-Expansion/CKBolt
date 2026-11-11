import { expect, test } from "@playwright/test";
import { presenceOf, type BridgeContext } from "../../components/app/fiber-node/use-bridge-server";
import { CWBTC_FAUCET_DEFAULT_URL, cwbtcFaucetUrl, FAUCET_LINK_LABEL, tokenFaucets } from "../../lib/faucets";
import type { FiberNodeDto, Script, UdtWhitelistDto } from "../../lib/hub/contract";
import { channelReserveCkb, ckbNeededToAccept, newChannelCapacity } from "../../lib/wallets/fiber-browser/channel-contribution";
import { ckbToShannons } from "../../lib/wallets/fiber-browser/channels";
import { CHANNEL_FEE_MARGIN_CKB, CHANNEL_RESERVE_CKB } from "../../lib/wallets/fiber-browser/constants";
import type { FiberLike } from "../../lib/wallets/fiber-browser/fiber-js-adapter";
import { generateNodeKeys } from "../../lib/wallets/fiber-browser/keys";
import { BrowserNodeController } from "../../lib/wallets/fiber-browser/node-controller";
import { browserNodeConfig } from "../../lib/wallets/fiber-browser/node-config";
import { acquireNodeLock } from "../../lib/wallets/fiber-browser/node-lock";
import type { NodeChannel } from "../../lib/wallets/fiber-browser/node-port";
import { assetDecimals, formatAssetUnits, shownTokens, walletTokens } from "../../lib/wallets/fiber-browser/tokens";
import {
  assetsNeedingRestart,
  findNodeUdt,
  hubWhitelist,
  readUdtWhitelist,
  takesHubChannel,
  whitelistEntryOf,
  whitelistEntryYaml,
  withUdtWhitelist,
} from "../../lib/wallets/fiber-browser/udt-whitelist";
import { shortOfChannelFunds } from "../../lib/wallets/fiber-wallet/node-page";

/*
 * More tokens than CKB and RUSD (cWBTC first; any UDT the hub's FIBER_ASSETS lists): the browser node's UDT whitelist
 * built from the hub's entries (GET /v1/fiber/node `udtWhitelist`), merged into fiber-js 0.9.1's own config and read
 * back to tell when a running node needs a restart; the channel reserve every token shares; the node's liquidity per
 * hub asset; decimals from the hub; and the faucet link.
 */

/* --------------------------------------------------------------------------------------------- fixtures */

const RUSD_SCRIPT: Script = {
  codeHash: "0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a",
  hashType: "type",
  args: "0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b",
};
const CWBTC_SCRIPT: Script = {
  codeHash: "0x25c29dc317811a6f6f3985a7a9ebc4838bd388d19d0feeecf0bcd60f6c0975bb",
  hashType: "type",
  args: "0x9a1086531ed6dc69e0bd44cef5278e03faf3015b31aff60b08fb87663ce8507100000000",
};
const TYPE_ID_CODE_HASH = "0x00000000000000000000000000000000000000000000000000545950455f4944";
const RUSD_WHITELIST: UdtWhitelistDto = {
  name: "RUSD",
  script: RUSD_SCRIPT,
  cellDeps: [{ typeId: { codeHash: TYPE_ID_CODE_HASH, hashType: "type", args: "0x97d30b723c0b2c66e9cb8d4d0df4ab5d7222cbb00d4a9a2055ce2e5d7f0d8b0f" } }],
  autoAcceptAmount: "2000000000",
};
const CWBTC_WHITELIST: UdtWhitelistDto = {
  name: "cWBTC",
  script: CWBTC_SCRIPT,
  cellDeps: [{ outPoint: { txHash: "0xbf6fb538763efec2a70a6a3dcb7242787087e1030c4e7d86585bc63a9d337f5f", index: "0x0" }, depType: "code" }],
  autoAcceptAmount: "1000000000",
};
const HUB_NODE_ID = "02b6d4e3ab86a2ca2fad6fae0ecb2e1e559e0b911939872a90abdda6d20302be71";
/** The hub's Fiber node as the example in the hub's contract answers GET /v1/fiber/node. */
const HUB: FiberNodeDto = {
  nodeId: HUB_NODE_ID,
  network: "testnet",
  addresses: { p2p: [], ws: [] },
  assets: [
    { id: "CKB", udtTypeScript: null, udtWhitelist: null, peerChannels: null },
    { id: "RUSD", udtTypeScript: RUSD_SCRIPT, udtWhitelist: RUSD_WHITELIST, peerChannels: null },
    { id: "CWBTC", udtTypeScript: CWBTC_SCRIPT, udtWhitelist: CWBTC_WHITELIST, peerChannels: null },
  ],
  inbound: {
    enabled: true,
    amounts: { CKB: "200000000000", RUSD: "2000000000", CWBTC: "1000000000" },
    fundable: { CKB: true, RUSD: true, CWBTC: true },
  },
};

/** fiber-js 0.9.1's real bundled testnet config, without starting a node. */
async function bundledTestnetConfig(): Promise<string> {
  const { Fiber } = await import("@nervosnetwork/fiber-js");
  return Fiber.prototype.getDefaultConfig.call(Object.create(Fiber.prototype), "testnet", "https://rpc.example.test/");
}

const entries = (...dtos: UdtWhitelistDto[]) => dtos.map((dto) => whitelistEntryOf(dto)!);

/* ------------------------------------------------------------------------------------- whitelist entries */

test.describe("the hub's whitelist entries", () => {
  test("an entry as fnn's YAML: anchored args, a type-id cell dep, a cell dep by out point, auto_accept_amount", () => {
    const [rusd, cwbtc] = entries(RUSD_WHITELIST, CWBTC_WHITELIST);
    expect(whitelistEntryYaml(cwbtc, "    ")).toEqual([
      '    - name: "cWBTC"',
      "      script:",
      "        code_hash: 0x25c29dc317811a6f6f3985a7a9ebc4838bd388d19d0feeecf0bcd60f6c0975bb",
      "        hash_type: type",
      '        args: "^0x9a1086531ed6dc69e0bd44cef5278e03faf3015b31aff60b08fb87663ce8507100000000$"',
      "      cell_deps:",
      "        - cell_dep:",
      "            out_point:",
      "              tx_hash: 0xbf6fb538763efec2a70a6a3dcb7242787087e1030c4e7d86585bc63a9d337f5f",
      "              index: 0x0",
      "            dep_type: code",
      "      auto_accept_amount: 1000000000",
    ]);
    expect(whitelistEntryYaml(rusd, "    ")).toEqual([
      '    - name: "RUSD"',
      "      script:",
      "        code_hash: 0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a",
      "        hash_type: type",
      '        args: "^0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b$"',
      "      cell_deps:",
      "        - type_id:",
      `            code_hash: ${TYPE_ID_CODE_HASH}`,
      "            hash_type: type",
      "            args: 0x97d30b723c0b2c66e9cb8d4d0df4ab5d7222cbb00d4a9a2055ce2e5d7f0d8b0f",
      "      auto_accept_amount: 2000000000",
    ]);
  });

  test("without an auto-accept amount (the hub opens no channel in the token) the field is left out", () => {
    const [none] = entries({ ...CWBTC_WHITELIST, autoAcceptAmount: null });
    expect(none.autoAcceptAmount).toBeNull();
    const yaml = whitelistEntryYaml(none, "    ");
    expect(yaml.some((line) => line.includes("auto_accept_amount"))).toBe(false);
    expect(yaml.at(-1)).toBe("            dep_type: code");
  });

  test("every field is checked before it reaches the YAML: hex, hash types, a short name, a decimal amount; hex in lower case", () => {
    expect(whitelistEntryOf({ ...CWBTC_WHITELIST, script: { ...CWBTC_SCRIPT, args: CWBTC_SCRIPT.args.toUpperCase().replace("0X", "0x") } })?.script.args).toBe(CWBTC_SCRIPT.args);
    const bad: unknown[] = [
      null,
      { ...CWBTC_WHITELIST, name: "cWBTC\n  evil: 1" },
      { ...CWBTC_WHITELIST, name: "" },
      { ...CWBTC_WHITELIST, name: "x".repeat(33) },
      { ...CWBTC_WHITELIST, script: { ...CWBTC_SCRIPT, args: "^0x00$" } },
      { ...CWBTC_WHITELIST, script: { ...CWBTC_SCRIPT, args: "0x0" } },
      { ...CWBTC_WHITELIST, script: { ...CWBTC_SCRIPT, codeHash: "0x1234" } },
      { ...CWBTC_WHITELIST, script: { ...CWBTC_SCRIPT, hashType: "type\n" } },
      { ...CWBTC_WHITELIST, cellDeps: [] },
      { ...CWBTC_WHITELIST, cellDeps: [{ outPoint: { txHash: CWBTC_WHITELIST.script.codeHash, index: "0" }, depType: "code" }] },
      { ...CWBTC_WHITELIST, cellDeps: [{ outPoint: { txHash: CWBTC_WHITELIST.script.codeHash, index: "0x0" }, depType: "group" }] },
      { ...CWBTC_WHITELIST, cellDeps: [{ typeId: { codeHash: "0x", hashType: "type", args: "0x" } }] },
      { ...CWBTC_WHITELIST, autoAcceptAmount: "1e9" },
      { ...CWBTC_WHITELIST, autoAcceptAmount: 1000000000 },
      { ...CWBTC_WHITELIST, autoAcceptAmount: "1".repeat(40) },
    ];
    for (const dto of bad) expect(whitelistEntryOf(dto as UdtWhitelistDto), JSON.stringify(dto)?.slice(0, 80)).toBeNull();
  });

  test("the hub's entries for the UDTs it serves, in its order; CKB, an older hub's null and a broken entry give none", () => {
    expect(hubWhitelist(HUB).map((e) => e.name)).toEqual(["RUSD", "cWBTC"]);
    expect(hubWhitelist(null)).toEqual([]);
    const older = { assets: HUB.assets.map((a) => ({ ...a, udtWhitelist: null })) };
    expect(hubWhitelist(older)).toEqual([]);
    const broken = { assets: [HUB.assets[1], { ...HUB.assets[2], udtWhitelist: { ...CWBTC_WHITELIST, cellDeps: [] } }] };
    expect(hubWhitelist(broken).map((e) => e.name)).toEqual(["RUSD"]);
  });
});

/* ------------------------------------------------------------------------------ the config's whitelist */

test.describe("the browser node's whitelist in fiber-js 0.9.1's config", () => {
  test("fiber-js whitelists RUSD only on testnet, unanchored, auto-accepted from 10 RUSD", async () => {
    const original = await bundledTestnetConfig();
    expect(readUdtWhitelist(original)).toEqual([
      { name: "RUSD", codeHash: RUSD_SCRIPT.codeHash, hashType: "type", argsPattern: RUSD_SCRIPT.args, autoAcceptAmount: BigInt(1_000_000_000) },
    ]);
  });

  test("the hub's entries come first and replace fiber-js's for the same script; the rest of the config is unchanged", async () => {
    const original = await bundledTestnetConfig();
    const edited = browserNodeConfig(original, [], undefined, hubWhitelist(HUB));
    const udts = readUdtWhitelist(edited);
    // RUSD now as the hub funds it (20 RUSD) and anchored; cWBTC added; fiber-js's RUSD entry gone, not doubled.
    expect(udts).toEqual([
      { name: "RUSD", codeHash: RUSD_SCRIPT.codeHash, hashType: "type", argsPattern: `^${RUSD_SCRIPT.args}$`, autoAcceptAmount: BigInt(2_000_000_000) },
      { name: "cWBTC", codeHash: CWBTC_SCRIPT.codeHash, hashType: "type", argsPattern: `^${CWBTC_SCRIPT.args}$`, autoAcceptAmount: BigInt(1_000_000_000) },
    ]);
    expect(edited.match(/udt_whitelist:/g)).toHaveLength(1);
    expect(edited).toContain('\n  udt_whitelist:\n    - name: "RUSD"\n      script:\n');
    // The whitelist stays in the ckb section, before services.
    expect(edited.indexOf("udt_whitelist:")).toBeGreaterThan(edited.indexOf("\nckb:"));
    expect(edited.indexOf("udt_whitelist:")).toBeLessThan(edited.indexOf("\nservices:"));
    expect(edited).toMatch(/\nservices:\n {2}- fiber\n {2}- rpc\n {2}- ckb/);
    // Lines outside the whitelist and the edits of browserNodeConfig itself are as fiber-js wrote them.
    const plain = browserNodeConfig(original, []);
    const outside = (yaml: string) => {
      const lines = yaml.split("\n");
      const start = lines.findIndex((l) => l.includes("udt_whitelist:"));
      const end = lines.findIndex((l, i) => i > start && /^\S/.test(l));
      return [...lines.slice(0, start), ...lines.slice(end)];
    };
    expect(outside(edited)).toEqual(outside(plain));
  });

  test("an entry the hub does not name stays verbatim, after the hub's: RUSD keeps working with a hub that serves only cWBTC", async () => {
    const original = await bundledTestnetConfig();
    const edited = browserNodeConfig(original, [], undefined, entries(CWBTC_WHITELIST));
    expect(readUdtWhitelist(edited).map((u) => [u.name, u.argsPattern, u.autoAcceptAmount])).toEqual([
      ["cWBTC", `^${CWBTC_SCRIPT.args}$`, BigInt(1_000_000_000)],
      ["RUSD", RUSD_SCRIPT.args, BigInt(1_000_000_000)],
    ]);
    const rusdLines = original.split("\n").filter((l, i, all) => i > all.findIndex((x) => x.includes("- name: RUSD")) - 1 && i < all.findIndex((x) => x.startsWith("services:")) - 1);
    for (const line of rusdLines) expect(edited).toContain(line);
  });

  test("without the hub's entries (no hub, another network, an older hub) the config is fiber-js's", async () => {
    const original = await bundledTestnetConfig();
    expect(browserNodeConfig(original, [], undefined, [])).toBe(browserNodeConfig(original, []));
    expect(withUdtWhitelist(original, [])).toBe(original);
  });

  test("a config without a whitelist gets one under ckb; one without a ckb section is left as it is", () => {
    const yaml = 'fiber:\n  chain: testnet\nckb:\n  rpc_url: "x"\nservices:\n  - ckb\n';
    const edited = withUdtWhitelist(yaml, entries(CWBTC_WHITELIST));
    expect(edited.startsWith('fiber:\n  chain: testnet\nckb:\n  udt_whitelist:\n    - name: "cWBTC"\n')).toBe(true);
    expect(edited).toContain('      auto_accept_amount: 1000000000\n  rpc_url: "x"\nservices:\n  - ckb\n');
    expect(readUdtWhitelist(edited).map((u) => u.name)).toEqual(["cWBTC"]);
    expect(withUdtWhitelist("fiber:\n  chain: testnet\n", entries(CWBTC_WHITELIST))).toBe("fiber:\n  chain: testnet\n");
    // An empty inline list is replaced.
    const empty = withUdtWhitelist('ckb:\n  udt_whitelist: []\n  rpc_url: "x"\n', entries(CWBTC_WHITELIST));
    expect(empty).not.toContain("[]");
    expect(readUdtWhitelist(empty).map((u) => u.name)).toEqual(["cWBTC"]);
  });

  test("comments between items stay with the item they precede; items at the key's own indent are read too", () => {
    const yaml = [
      "ckb:",
      "  udt_whitelist:",
      "    # the stablecoin",
      "    - name: RUSD",
      "      script:",
      `        code_hash: ${RUSD_SCRIPT.codeHash}`,
      "        hash_type: type",
      `        args: ${RUSD_SCRIPT.args} # unanchored`,
      "      cell_deps:",
      "        - type_id:",
      `            code_hash: ${TYPE_ID_CODE_HASH}`,
      "            hash_type: type",
      "            args: 0x01",
      "    # another token",
      "    - name: OTHER",
      "      script:",
      `        code_hash: '${CWBTC_SCRIPT.codeHash}'`,
      "        hash_type: data1",
      "        args: 0x02",
      "",
      "services:",
    ].join("\n");
    expect(readUdtWhitelist(yaml).map((u) => [u.name, u.hashType, u.argsPattern, u.autoAcceptAmount])).toEqual([
      ["RUSD", "type", RUSD_SCRIPT.args, null],
      ["OTHER", "data1", "0x02", null],
    ]);
    const edited = withUdtWhitelist(yaml, entries(RUSD_WHITELIST));
    expect(edited).not.toContain("# the stablecoin");
    expect(edited).toContain("    # another token\n    - name: OTHER");
    expect(readUdtWhitelist(edited).map((u) => u.name)).toEqual(["RUSD", "OTHER"]);
    const sameIndent = 'ckb:\n  udt_whitelist:\n  - name: RUSD\n    script:\n      code_hash: 0xaa\n      hash_type: type\n      args: 0x01\n  rpc_url: "x"\n';
    expect(readUdtWhitelist(sameIndent).map((u) => u.name)).toEqual(["RUSD"]);
  });
});

/* ------------------------------------------------------------------------------- fnn's lookup, restarts */

test.describe("what the running node takes, and when it needs a restart", () => {
  test("fnn's lookup: code hash and hash type, then the args pattern as a regex; the first match wins", async () => {
    const udts = readUdtWhitelist(browserNodeConfig(await bundledTestnetConfig(), [], undefined, hubWhitelist(HUB)));
    expect(findNodeUdt(udts, CWBTC_SCRIPT)?.name).toBe("cWBTC");
    expect(findNodeUdt(udts, { ...CWBTC_SCRIPT, args: CWBTC_SCRIPT.args.toUpperCase().replace("0X", "0x") })?.name).toBe("cWBTC");
    // Anchored: a token whose args only start with cWBTC's is not cWBTC.
    expect(findNodeUdt(udts, { ...CWBTC_SCRIPT, args: `${CWBTC_SCRIPT.args}00` })).toBeNull();
    expect(findNodeUdt(udts, { ...CWBTC_SCRIPT, hashType: "data1" })).toBeNull();
    // fiber-js's own entry is unanchored: fnn would take any args that contain RUSD's.
    const bundled = readUdtWhitelist(await bundledTestnetConfig());
    expect(findNodeUdt(bundled, { ...RUSD_SCRIPT, args: `${RUSD_SCRIPT.args}ff` })?.name).toBe("RUSD");
    expect(findNodeUdt([{ name: null, codeHash: RUSD_SCRIPT.codeHash, hashType: "type", argsPattern: "([", autoAcceptAmount: null }], RUSD_SCRIPT)).toBeNull();
  });

  test("the hub's channel in a token is taken by itself only from the auto-accept amount up", async () => {
    const udts = readUdtWhitelist(browserNodeConfig(await bundledTestnetConfig(), [], undefined, hubWhitelist(HUB)));
    expect(takesHubChannel(udts, CWBTC_SCRIPT, BigInt(1_000_000_000))).toBe(true);
    expect(takesHubChannel(udts, CWBTC_SCRIPT, BigInt(999_999_999))).toBe(false);
    expect(takesHubChannel(udts, CWBTC_SCRIPT, null)).toBe(true);
    const noAuto = readUdtWhitelist(withUdtWhitelist(await bundledTestnetConfig(), entries({ ...CWBTC_WHITELIST, autoAcceptAmount: null })));
    expect(takesHubChannel(noAuto, CWBTC_SCRIPT, BigInt(1_000_000_000))).toBe(false);
  });

  test("a node started with fiber-js's config needs a restart for cWBTC, not for RUSD (10 RUSD up, the hub funds 20)", async () => {
    const bundled = readUdtWhitelist(browserNodeConfig(await bundledTestnetConfig(), []));
    expect(assetsNeedingRestart(bundled, HUB)).toEqual(["CWBTC"]);
    const started = readUdtWhitelist(browserNodeConfig(await bundledTestnetConfig(), [], undefined, hubWhitelist(HUB)));
    expect(assetsNeedingRestart(started, HUB)).toEqual([]);
    // Not running: nothing to restart. No inbound channel in the token, or an older hub without entries: no line either.
    expect(assetsNeedingRestart(null, HUB)).toEqual([]);
    expect(assetsNeedingRestart(bundled, { ...HUB, inbound: { enabled: true, amounts: { CKB: "200000000000" } } })).toEqual([]);
    expect(assetsNeedingRestart(bundled, { ...HUB, assets: HUB.assets.map((a) => ({ ...a, udtWhitelist: null })) })).toEqual([]);
    // The hub funds more RUSD than fiber-js's 10 RUSD: still taken. A hub funding 5 RUSD would need the hub's entry.
    expect(assetsNeedingRestart(bundled, { ...HUB, inbound: { enabled: true, amounts: { RUSD: "500000000" } } })).toEqual(["RUSD"]);
  });

  test("a token the node may open its own channel in (peerChannels) needs a restart only when its whitelist does not name it", async () => {
    const peer = { minAmount: "1000000", assumedCommitmentDelayEpochs: 84 };
    // The hub funds no inbound channel in cWBTC, but lets nodes open their own: fnn's open_channel needs the token listed.
    const peerOnly: FiberNodeDto = {
      ...HUB,
      assets: HUB.assets.map((a) => (a.id === "CWBTC" ? { ...a, peerChannels: peer } : a)),
      inbound: { enabled: true, amounts: { CKB: "200000000000", RUSD: "2000000000" } },
    };
    const bundled = readUdtWhitelist(browserNodeConfig(await bundledTestnetConfig(), []));
    expect(assetsNeedingRestart(bundled, peerOnly)).toEqual(["CWBTC"]);
    const started = readUdtWhitelist(browserNodeConfig(await bundledTestnetConfig(), [], undefined, hubWhitelist(peerOnly)));
    expect(assetsNeedingRestart(started, peerOnly)).toEqual([]);
    // Listed with an auto-accept amount above what the hub funds: the hub's own channel needs a restart, the node's own
    // would not, and the row asks for one restart for both.
    const rusdPeer: FiberNodeDto = {
      ...HUB,
      assets: HUB.assets.map((a) => (a.id === "RUSD" ? { ...a, peerChannels: peer } : a)),
      inbound: { enabled: true, amounts: { RUSD: "500000000" } },
    };
    expect(assetsNeedingRestart(bundled, rusdPeer)).toEqual(["RUSD"]);
    expect(assetsNeedingRestart(bundled, { ...rusdPeer, inbound: { enabled: true, amounts: {} } })).toEqual([]);
  });

  test("the controller starts the node with the hub's whitelist and keeps what it started with; stopped, it knows none", async () => {
    const configs: string[] = [];
    const fiber: FiberLike = {
      getDefaultConfig: () => 'fiber:\n  bootnode_addrs: []\nckb:\n  rpc_url: "x"\n',
      start: async (config) => {
        configs.push(config);
      },
      invokeCommand: async (name) => {
        if (name === "node_info") return { version: "0.9.1", pubkey: HUB_NODE_ID, default_funding_lock_script: { code_hash: CWBTC_SCRIPT.codeHash, hash_type: "type", args: "0x01" } };
        throw new Error(`unexpected ${name}`);
      },
      stop: async () => undefined,
    };
    const controller = new BrowserNodeController({
      config: { network: "testnet", ckbRpcUrl: "x", bootnodes: [] },
      load: async () => fiber,
      lock: (name) => acquireNodeLock(name, null),
    });
    expect(controller.getState().udts).toBeNull();
    expect(await controller.start(generateNodeKeys(), [], hubWhitelist(HUB))).toBe(true);
    expect(configs[0]).toContain(`args: "^${CWBTC_SCRIPT.args}$"`);
    expect(controller.getState().udts?.map((u) => u.name)).toEqual(["RUSD", "cWBTC"]);
    await controller.stop();
    expect(controller.getState().udts).toBeNull();
    // Started without the hub (it had not answered): no token whitelisted, so the hub's cWBTC needs a restart.
    expect(await controller.start(generateNodeKeys(), [])).toBe(true);
    expect(controller.getState().udts).toEqual([]);
    expect(assetsNeedingRestart(controller.getState().udts, HUB)).toEqual(["RUSD", "CWBTC"]);
  });
});

/* -------------------------------------------------------------------------------------- reserves, funds */

test.describe("channel reserves per token", () => {
  test("every token the hub lists takes the same CKB reserve; CKB its own", () => {
    expect(CHANNEL_RESERVE_CKB).toEqual({ CKB: 99, UDT: 180 });
    // An xUDT cell such as cWBTC's needs at least 146 CKB.
    expect(CHANNEL_RESERVE_CKB.UDT).toBeGreaterThanOrEqual(146);
    for (const asset of ["RUSD", "CWBTC", "XUDT2"]) {
      expect(channelReserveCkb(asset), asset).toBe(180);
      expect(ckbNeededToAccept(asset, 49_000), asset).toBe(180 + CHANNEL_FEE_MARGIN_CKB);
      expect(newChannelCapacity(asset, BigInt(1_000_000_000), 1_200), asset).toEqual({ send: BigInt(0), receive: BigInt(1_000_000_000) });
    }
    expect(channelReserveCkb("CKB")).toBe(99);
    expect(ckbNeededToAccept("CKB", 1_200)).toBe(1_201);
  });

  test("the swap card sends a node short of cWBTC's reserve to Add funds, as for RUSD (no token is left without the guard)", () => {
    expect(shortOfChannelFunds({ onChainCkb: ckbToShannons(180), contributionCkb: 1_200 }, "CWBTC")).toBe(true);
    expect(shortOfChannelFunds({ onChainCkb: ckbToShannons(181), contributionCkb: 1_200 }, "CWBTC")).toBe(false);
    expect(shortOfChannelFunds({ onChainCkb: ckbToShannons(180), contributionCkb: 1_200 }, "XUDT2")).toBe(true);
  });
});

/* ----------------------------------------------------------------------------- liquidity, tokens, decimals */

test.describe("the node's tokens and liquidity follow the hub's assets", () => {
  const channel = (udt: Script | null, local: bigint, remote: bigint): NodeChannel => ({
    channelId: `0x${"11".repeat(32)}`,
    peerId: HUB_NODE_ID,
    udtTypeScript: udt,
    state: "ChannelReady",
    isPublic: false,
    enabled: true,
    localBalance: local,
    remoteBalance: remote,
  });

  test("the node tab reports CKB and every asset the hub serves, cWBTC included, over the hub's channels", () => {
    const ctx = {
      state: { phase: "running", info: null, error: null, exclusive: true, udts: [] },
      node: null,
      network: "testnet",
      hubNode: HUB,
      hubConnected: true,
      channels: [channel(CWBTC_SCRIPT, BigInt(0), BigInt(1_000_000_000))],
      balance: null,
      contributionCkb: null,
    } as unknown as BridgeContext;
    expect(presenceOf(ctx).liquidity).toEqual({
      CKB: { send: "0", receive: "0" },
      RUSD: { send: "0", receive: "0" },
      CWBTC: { send: "0", receive: "1000000000" },
    });
    // A hub on another network: CKB only.
    expect(presenceOf({ ...ctx, hubNode: { ...HUB, network: "mainnet" } }).liquidity).toEqual({ CKB: { send: "0", receive: "0" } });
  });

  test("decimals come from the hub; a token it did not list shows in base units and is not offered", () => {
    const assets = [
      { id: "CKB", symbol: "CKB", decimals: 8 },
      { id: "CWBTC", symbol: "cWBTC", decimals: 8 },
      { id: "SIX", symbol: "SIX", decimals: 6 },
    ];
    expect(assetDecimals("CKB", [])).toBe(8);
    expect(assetDecimals("SIX", assets)).toBe(6);
    expect(assetDecimals("RUSD", assets)).toBeNull();
    expect(formatAssetUnits("150000000", 8, "cWBTC")).toBe("1.5 cWBTC");
    expect(formatAssetUnits("1500000", 6, "SIX")).toBe("1.5 SIX");
    expect(formatAssetUnits("1250000000", null, "RUSD")).toBe("1,250,000,000 base units of RUSD");
    // The node's checks keep every token the hub's node lists; a view offers only those with known decimals.
    expect(walletTokens(HUB, assets).map((t) => [t.id, t.symbol, t.decimals])).toEqual([
      ["CKB", "CKB", 8],
      ["RUSD", "RUSD", 8],
      ["CWBTC", "cWBTC", 8],
    ]);
    expect(shownTokens(HUB, assets).map((t) => t.id)).toEqual(["CKB", "CWBTC"]);
  });
});

/* ---------------------------------------------------------------------------------------------- faucets */

test.describe("the cWBTC faucet", () => {
  test("NEXT_PUBLIC_CWBTC_FAUCET_URL when it is an http(s) URL, else faucet-cwbtc.ckb.dev", () => {
    expect(CWBTC_FAUCET_DEFAULT_URL).toBe("https://faucet-cwbtc.ckb.dev");
    expect(cwbtcFaucetUrl(undefined)).toBe(CWBTC_FAUCET_DEFAULT_URL);
    expect(cwbtcFaucetUrl("  ")).toBe(CWBTC_FAUCET_DEFAULT_URL);
    expect(cwbtcFaucetUrl("https://ckbolt-faucet.texlabs.org")).toBe("https://ckbolt-faucet.texlabs.org/");
    expect(cwbtcFaucetUrl("javascript:alert(1)")).toBe(CWBTC_FAUCET_DEFAULT_URL);
    expect(cwbtcFaucetUrl("not a url")).toBe(CWBTC_FAUCET_DEFAULT_URL);
  });

  test("a link for each token the hub serves that has a faucet, by its symbol", () => {
    const tokens = [
      { id: "CKB", symbol: "CKB" },
      { id: "RUSD", symbol: "RUSD" },
      { id: "CWBTC", symbol: "cWBTC" },
    ];
    expect(tokenFaucets(tokens, "https://faucet.example.test/")).toEqual([{ id: "CWBTC", symbol: "cWBTC", href: "https://faucet.example.test/" }]);
    expect(tokenFaucets(tokens.slice(0, 2))).toEqual([]);
    expect(FAUCET_LINK_LABEL("cWBTC")).toBe("Get test cWBTC");
  });
});
