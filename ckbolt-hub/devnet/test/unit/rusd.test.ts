import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parse as dotenvParse } from "dotenv";
import type { Script } from "../../../src/domain/types";
import { FNN_UDT_WHITELIST_ENV, RUSD_UDT_NAME } from "../../scripts/lib/devnet.constants";
import type { FnnNodeInfo } from "../../scripts/lib/fiber";
import { nodeWhitelistsRusd, renderUdtWhitelistEnv } from "../../scripts/lib/rusd";

const RUSD: Script = { codeHash: `0x${"aa".repeat(32)}`, hashType: "data2", args: `0x${"Bc".repeat(32)}` };
const CELL_DEP = { txHash: `0x${"11".repeat(32)}`, index: 9 };

const nodeInfo = (udts: FnnNodeInfo["udt_cfg_infos"]): FnnNodeInfo => ({
  pubkey: "02".padEnd(66, "0"),
  addresses: [],
  chain_hash: "0x",
  default_funding_lock_script: { code_hash: "0x", hash_type: "type", args: "0x" },
  udt_cfg_infos: udts,
});

const fnnScript = (script: Script) => ({ code_hash: script.codeHash, hash_type: script.hashType, args: script.args });

describe("renderUdtWhitelistEnv", () => {
  const rendered = renderUdtWhitelistEnv(RUSD, CELL_DEP, 100_000_000n);

  it("writes CKB_UDT_WHITELIST as one JSON list with the RUSD stand-in only", () => {
    const value = dotenvParse(rendered)[FNN_UDT_WHITELIST_ENV];
    assert.ok(value, "CKB_UDT_WHITELIST is set");
    const whitelist = JSON.parse(value) as Array<Record<string, unknown>>;
    assert.equal(whitelist.length, 1);
    assert.deepEqual(whitelist[0], {
      name: RUSD_UDT_NAME,
      script: fnnScript(RUSD),
      auto_accept_amount: 100_000_000,
      cell_deps: [{ cell_dep: { out_point: { tx_hash: CELL_DEP.txHash, index: "0x9" }, dep_type: "code" } }],
    });
  });

  it("single-quotes the JSON so compose takes it literally", () => {
    assert.match(rendered, new RegExp(`^${FNN_UDT_WHITELIST_ENV}='\\[.*\\]'$`, "m"));
  });

  it("refuses an auto-accept amount JSON cannot carry exactly", () => {
    assert.throws(() => renderUdtWhitelistEnv(RUSD, CELL_DEP, BigInt(Number.MAX_SAFE_INTEGER) + 1n), /too large/);
    assert.doesNotThrow(() => renderUdtWhitelistEnv(RUSD, CELL_DEP, BigInt(Number.MAX_SAFE_INTEGER)));
  });

  it("is deterministic, so a re-run does not rewrite the file and recreate the fnn containers", () => {
    assert.equal(renderUdtWhitelistEnv(RUSD, CELL_DEP, 100_000_000n), rendered);
  });
});

describe("nodeWhitelistsRusd", () => {
  it("is true when the node lists the stand-in by name and script (args case-insensitive)", () => {
    const listed = { ...fnnScript(RUSD), args: RUSD.args.toUpperCase().replace("0X", "0x") };
    assert.equal(nodeWhitelistsRusd(nodeInfo([{ name: RUSD_UDT_NAME, script: listed }]), RUSD), true);
  });

  it("is false for an empty whitelist, another name, another hash type, code hash or args", () => {
    assert.equal(nodeWhitelistsRusd(nodeInfo([]), RUSD), false);
    assert.equal(nodeWhitelistsRusd(nodeInfo([{ name: "USDI", script: fnnScript(RUSD) }]), RUSD), false);
    assert.equal(nodeWhitelistsRusd(nodeInfo([{ name: RUSD_UDT_NAME, script: { ...fnnScript(RUSD), hash_type: "type" } }]), RUSD), false);
    assert.equal(nodeWhitelistsRusd(nodeInfo([{ name: RUSD_UDT_NAME, script: { ...fnnScript(RUSD), code_hash: `0x${"bb".repeat(32)}` } }]), RUSD), false);
    assert.equal(nodeWhitelistsRusd(nodeInfo([{ name: RUSD_UDT_NAME, script: { ...fnnScript(RUSD), args: "0x00" } }]), RUSD), false);
  });
});
