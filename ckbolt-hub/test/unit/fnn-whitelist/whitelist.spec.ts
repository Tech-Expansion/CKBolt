import { FNN_MAX_AUTO_ACCEPT_AMOUNT, FNN_NODE_ROLE } from "../../../src/common/constants/fnn-config.constants";
import { droppedTokens, renderWhitelist, replaceWhitelist, whitelistedScripts, whitelistEntries, WhitelistError, type WhitelistEntry } from "../../../src/interfaces/cli/fnn-whitelist/whitelist";
import { OUT_POINT_DEP, SCRIPT_A, SCRIPT_B, TYPE_ID_DEP, udt } from "./fnn-whitelist.fixtures";

/** whitelistEntries (what each node auto-accepts), renderWhitelist (the YAML lines) and replaceWhitelist (the file edit). */

const HUB = FNN_NODE_ROLE.HUB;
const DEMO = FNN_NODE_ROLE.DEMO;
const U128_MAX = (1n << 128n) - 1n;

const entry = (overrides: Partial<WhitelistEntry> = {}): WhitelistEntry => ({
  name: "TKN",
  script: SCRIPT_A,
  cellDeps: [TYPE_ID_DEP],
  autoAcceptAmount: null,
  decimals: 8,
  ...overrides,
});

/** The rendered lines without the comment lines: the YAML fnn reads. */
const yamlOnly = (lines: readonly string[]): string[] => lines.filter((line) => !line.trimStart().startsWith("#"));

describe("whitelistEntries", () => {
  it("keeps FIBER_ASSETS order, names each entry by its symbol and carries script, cell deps and decimals", () => {
    const udts = [udt("RUSD"), udt("CWBTC", {}, "cWBTC")];
    udts[1]!.asset.udtTypeScript = SCRIPT_B;
    udts[1]!.asset.cellDeps = [OUT_POINT_DEP];
    udts[1]!.asset.decimals = 6;

    expect(whitelistEntries(udts, DEMO)).toEqual([
      { name: "RUSD", script: SCRIPT_A, cellDeps: [TYPE_ID_DEP], autoAcceptAmount: null, decimals: 8 },
      { name: "cWBTC", script: SCRIPT_B, cellDeps: [OUT_POINT_DEP], autoAcceptAmount: null, decimals: 6 },
    ]);
  });

  describe("fnn-hub", () => {
    it("auto-accepts nothing for an asset without peerChannels, whatever its autoAcceptAmount", () => {
      const [only] = whitelistEntries([udt("RUSD", { inboundAmount: 2_000n, autoAcceptAmount: 1_000n })], HUB);
      expect(only!.autoAcceptAmount).toBeNull();
    });

    it("auto-accepts from peerChannels.minAmount only", () => {
      const [only] = whitelistEntries([udt("CWBTC", { autoAcceptAmount: 1_000n, peerChannels: { minAmount: 77n } })], HUB);
      expect(only!.autoAcceptAmount).toBe(77n);
    });

    it("ignores demo amounts", () => {
      const [only] = whitelistEntries([udt("RUSD")], HUB, { RUSD: 5n });
      expect(only!.autoAcceptAmount).toBeNull();
    });
  });

  describe("fnn-demo", () => {
    it("auto-accepts the asset's autoAcceptAmount", () => {
      const [only] = whitelistEntries([udt("RUSD", { autoAcceptAmount: 1_000n, peerChannels: { minAmount: 5n } })], DEMO);
      expect(only!.autoAcceptAmount).toBe(1_000n);
    });

    it("takes a configured amount over the asset's, for that asset only", () => {
      const udts = [udt("RUSD", { autoAcceptAmount: 1_000n }), udt("CWBTC", { autoAcceptAmount: 2_000n })];
      expect(whitelistEntries(udts, DEMO, { RUSD: 42n }).map((e) => e.autoAcceptAmount)).toEqual([42n, 2_000n]);
    });

    it("takes a configured amount for an asset that has none", () => {
      expect(whitelistEntries([udt("RUSD")], DEMO, { RUSD: 9n })[0]!.autoAcceptAmount).toBe(9n);
    });

    it("auto-accepts nothing when neither is set", () => {
      expect(whitelistEntries([udt("RUSD")], DEMO)[0]!.autoAcceptAmount).toBeNull();
    });
  });

  describe("fnn's u128", () => {
    it("is the documented bound", () => {
      expect(FNN_MAX_AUTO_ACCEPT_AMOUNT).toBe(U128_MAX);
    });

    it.each([
      ["fnn-hub, peerChannels.minAmount", HUB, udt("BIG", { peerChannels: { minAmount: U128_MAX } }), {}],
      ["fnn-demo, autoAcceptAmount", DEMO, udt("BIG", { autoAcceptAmount: U128_MAX }), {}],
      ["fnn-demo, configured amount", DEMO, udt("BIG"), { BIG: U128_MAX }],
    ] as const)("takes the largest u128 (%s)", (_case, role, settings, demo) => {
      expect(whitelistEntries([settings], role, demo)[0]!.autoAcceptAmount).toBe(U128_MAX);
    });

    it.each([
      ["fnn-hub, peerChannels.minAmount", HUB, udt("BIG", { peerChannels: { minAmount: U128_MAX + 1n } }), {}],
      ["fnn-demo, autoAcceptAmount", DEMO, udt("BIG", { autoAcceptAmount: U128_MAX + 1n }), {}],
      ["fnn-demo, configured amount", DEMO, udt("BIG"), { BIG: U128_MAX + 1n }],
    ] as const)("refuses an amount above u128 (%s)", (_case, role, settings, demo) => {
      expect(() => whitelistEntries([settings], role, demo)).toThrow(WhitelistError);
      expect(() => whitelistEntries([settings], role, demo)).toThrow(/BIG.*u128/);
    });
  });

  it("refuses an asset without a type script", () => {
    const settings = udt("ODD");
    settings.asset.udtTypeScript = null;
    expect(() => whitelistEntries([settings], DEMO)).toThrow(WhitelistError);
    expect(() => whitelistEntries([settings], DEMO)).toThrow(/ODD/);
  });
});

describe("renderWhitelist", () => {
  it("renders `udt_whitelist: []` for no entry, at the key's indent", () => {
    expect(renderWhitelist([], HUB, 2)).toEqual(["  udt_whitelist: []"]);
    expect(renderWhitelist([], DEMO, 0)).toEqual(["udt_whitelist: []"]);
  });

  it("lays an entry out as the kit's files do: anchored args, type id and out point cell deps, the amount last", () => {
    const lines = renderWhitelist([entry({ cellDeps: [TYPE_ID_DEP, OUT_POINT_DEP], autoAcceptAmount: 150_000_000n })], DEMO, 2);

    expect(yamlOnly(lines)).toEqual([
      "  udt_whitelist:",
      "    - name: TKN",
      "      script:",
      `        code_hash: 0x${"aa".repeat(32)}`,
      "        hash_type: type",
      `        args: "^0x${"01".repeat(20)}$"`,
      "      cell_deps:",
      "        - type_id:",
      `            code_hash: 0x${"dd".repeat(32)}`,
      "            hash_type: type",
      `            args: 0x${"ee".repeat(32)}`,
      "        - cell_dep:",
      "            out_point:",
      `              tx_hash: 0x${"cc".repeat(32)}`,
      "              index: 0x2",
      "            dep_type: dep_group",
      "      auto_accept_amount: 150000000",
    ]);
  });

  it("explains the generated list, the anchors and the amount in comments, at the indent of what they explain", () => {
    const lines = renderWhitelist([entry({ autoAcceptAmount: 150_000_000n })], DEMO, 2);
    const comments = lines.filter((line) => line.trimStart().startsWith("#"));

    expect(comments).toHaveLength(3);
    expect(lines[1]).toMatch(/^ {4}# .*FIBER_ASSETS/);
    expect(lines[lines.indexOf(`        args: "^0x${"01".repeat(20)}$"`) - 1]).toMatch(/^ {8}# .*anchor/);
    expect(lines[lines.length - 2]).toMatch(/^ {6}# .*1\.5 TKN/);
  });

  it("anchors an empty args too", () => {
    expect(renderWhitelist([entry({ script: SCRIPT_B })], HUB, 2)).toContain('        args: "^0x$"');
  });

  it("leaves auto_accept_amount and its comment out when the node accepts nothing on its own", () => {
    const lines = renderWhitelist([entry({ autoAcceptAmount: null })], HUB, 2);
    expect(lines.join("\n")).not.toContain("auto_accept_amount");
    expect(lines[lines.length - 1]).toBe(`            args: 0x${"ee".repeat(32)}`);
  });

  it("says in the fnn-hub comment that the amount is FIBER_ASSETS peerChannels.minAmount", () => {
    const lines = renderWhitelist([entry({ autoAcceptAmount: 10_000_000n })], HUB, 2);
    expect(lines[lines.length - 2]).toMatch(/0\.1 TKN.*peerChannels\.minAmount/);
    expect(lines[lines.length - 1]).toBe("      auto_accept_amount: 10000000");
  });

  it("shifts every line with the key's indent", () => {
    const at2 = renderWhitelist([entry({ autoAcceptAmount: 1n })], DEMO, 2);
    const at6 = renderWhitelist([entry({ autoAcceptAmount: 1n })], DEMO, 6);
    expect(at6).toEqual(at2.map((line) => `    ${line}`));
  });

  it.each([["RUSD"], ["cWBTC"], ["My Token"], ["x.y-z_1"], ["Yesterday"], ["NO2"], ["Nullable"], ["ON-1"], ["yes token"], ["T1"], ["NaN"]])(
    "writes the symbol %j as a plain scalar",
    (symbol) => {
      expect(renderWhitelist([entry({ name: symbol })], HUB, 2)[2]).toBe(`    - name: ${symbol}`);
    },
  );

  it.each([
    ["true"],
    ["TRUE"],
    ["False"],
    ["yes"],
    ["YES"],
    ["No"],
    ["on"],
    ["OFF"],
    ["y"],
    ["Y"],
    ["n"],
    ["N"],
    ["null"],
    ["Null"],
    ["NULL"],
  ])("double-quotes the YAML keyword %j, which plain YAML reads as a boolean or null", (symbol) => {
    expect(renderWhitelist([entry({ name: symbol })], HUB, 2)[2]).toBe(`    - name: "${symbol}"`);
  });

  it.each([["1INCH"], ["123"], ["0x10"], ["1e3"], ["1.5"], ["12:30"], ["2026-11-07"]])(
    "double-quotes the symbol %j, which starts with a digit (YAML may read a number, time or date)",
    (symbol) => {
      expect(renderWhitelist([entry({ name: symbol })], HUB, 2)[2]).toBe(`    - name: ${JSON.stringify(symbol)}`);
    },
  );

  it("writes a keyword symbol quoted in the entry, as is in the comment, and regenerates the same bytes", () => {
    const file = "ckb:\n  udt_whitelist: []\n";
    const once = replaceWhitelist(file, [entry({ name: "ON", autoAcceptAmount: 100_000_000n })], DEMO);
    expect(once).toContain('    - name: "ON"\n');
    expect(once).toContain("1 ON or more");
    expect(replaceWhitelist(once, [entry({ name: "ON", autoAcceptAmount: 100_000_000n })], DEMO)).toBe(once);
  });

  it.each([
    ["a: b", '"a: b"'],
    ["#1", '"#1"'],
    ["-x", '"-x"'],
    ['A"B', '"A\\"B"'],
    ["[x]", '"[x]"'],
    ["*ref", '"*ref"'],
    ["Ü", '"Ü"'],
    [" lead", '" lead"'],
  ])("double-quotes the symbol %j, which plain YAML would misread", (symbol, written) => {
    const lines = renderWhitelist([entry({ name: symbol })], HUB, 2);
    expect(lines[2]).toBe(`    - name: ${written}`);
    expect(JSON.parse(written)).toBe(symbol);
  });
});

describe("replaceWhitelist", () => {
  const oneEntry = [entry({ autoAcceptAmount: 5n })];
  const renderedAt2 = renderWhitelist(oneEntry, DEMO, 2).join("\n");

  it("turns `udt_whitelist: []` into the list and keeps the lines around it", () => {
    const file = "# head\nckb:\n  rpc_url: x\n  udt_whitelist: []\n  tx_tracing_polling_interval_ms: 4000\nservices:\n  - ckb\n";
    expect(replaceWhitelist(file, oneEntry, DEMO)).toBe(
      `# head\nckb:\n  rpc_url: x\n${renderedAt2}\n  tx_tracing_polling_interval_ms: 4000\nservices:\n  - ckb\n`,
    );
  });

  it("replaces the whole old list, comments inside it included, and keeps a sibling key after it", () => {
    const file = [
      "ckb:",
      "  udt_whitelist:",
      "    # old note",
      "    - name: OLD",
      "      script:",
      "        args: 0x01",
      "",
      "      # a comment inside the list",
      "    - name: OLDER",
      "      auto_accept_amount: 1",
      "  rpc_url: x",
      "",
    ].join("\n");
    expect(replaceWhitelist(file, oneEntry, DEMO)).toBe(`ckb:\n${renderedAt2}\n  rpc_url: x\n`);
  });

  it("keeps blank and comment lines that follow the list, before the next key", () => {
    const file = "ckb:\n  udt_whitelist:\n    - name: OLD\n\n  # about services\nservices: []\n";
    expect(replaceWhitelist(file, oneEntry, DEMO)).toBe(`ckb:\n${renderedAt2}\n\n  # about services\nservices: []\n`);
  });

  it("replaces a list whose items sit at the key's own indent", () => {
    const file = "ckb:\n  udt_whitelist:\n  - name: OLD\n    script: {}\n  rpc_url: x\n";
    expect(replaceWhitelist(file, oneEntry, DEMO)).toBe(`ckb:\n${renderedAt2}\n  rpc_url: x\n`);
  });

  it("replaces items written as a bare `-` line with the mapping below it", () => {
    const file = "ckb:\n  udt_whitelist:\n    -\n      name: OLD\n  rpc_url: x\n";
    expect(replaceWhitelist(file, oneEntry, DEMO)).toBe(`ckb:\n${renderedAt2}\n  rpc_url: x\n`);
  });

  it("replaces a bare `-` item at the key's own indent (an indentless list item starting on the next line)", () => {
    const file = "ckb:\n  udt_whitelist:\n  -\n    name: OLD\n  rpc_url: x\n";
    expect(replaceWhitelist(file, oneEntry, DEMO)).toBe(`ckb:\n${renderedAt2}\n  rpc_url: x\n`);
  });

  it("replaces `- name:` and bare `-` items mixed at the key's own indent, comments between them included", () => {
    const file = [
      "ckb:",
      "  udt_whitelist:",
      "  - name: A",
      "    script: {}",
      "  # between",
      "  -",
      "    name: B",
      "",
      "  - name: C",
      "  rpc_url: x",
      "",
    ].join("\n");
    const once = replaceWhitelist(file, oneEntry, DEMO);
    expect(once).toBe(`ckb:\n${renderedAt2}\n  rpc_url: x\n`);
    expect(replaceWhitelist(once, oneEntry, DEMO)).toBe(once);
  });

  it("keeps a sibling key that only starts with a dash (`-x:` is a key, not a list item)", () => {
    const file = "ckb:\n  udt_whitelist:\n  - name: OLD\n  -x: 1\n";
    expect(replaceWhitelist(file, oneEntry, DEMO)).toBe(`ckb:\n${renderedAt2}\n  -x: 1\n`);
  });

  it("keeps a bare `-` that belongs to the parent list after the whitelist", () => {
    const file = "ckb:\n  udt_whitelist:\n    - name: OLD\nservices:\n-\n  ckb\n";
    expect(replaceWhitelist(file, oneEntry, DEMO)).toBe(`ckb:\n${renderedAt2}\nservices:\n-\n  ckb\n`);
  });

  it("takes `udt_whitelist: []` with a trailing comment, and a block key with one", () => {
    expect(replaceWhitelist("ckb:\n  udt_whitelist: [] # none yet\n", oneEntry, DEMO)).toBe(`ckb:\n${renderedAt2}\n`);
    expect(replaceWhitelist("ckb:\n  udt_whitelist: # list\n    - name: OLD\n", oneEntry, DEMO)).toBe(`ckb:\n${renderedAt2}\n`);
  });

  it("keeps a file without a final line end that way", () => {
    const file = "ckb:\n  udt_whitelist:\n    - name: OLD";
    const once = replaceWhitelist(file, oneEntry, DEMO);
    expect(once).toBe(`ckb:\n${renderedAt2}`);
    expect(replaceWhitelist(once, oneEntry, DEMO)).toBe(once);
  });

  it("writes new lines with the key line's CRLF", () => {
    const file = "ckb:\r\n  udt_whitelist: []\r\nservices: []\r\n";
    expect(replaceWhitelist(file, oneEntry, DEMO)).toBe(`ckb:\r\n${renderedAt2.replace(/\n/g, "\r\n")}\r\nservices: []\r\n`);
  });

  it("does not count a commented-out key", () => {
    const file = "ckb:\n  # udt_whitelist: []\n  udt_whitelist: []\n";
    expect(replaceWhitelist(file, [], DEMO)).toBe(file);
  });

  it("takes the section from the nearest less-indented key, past comments and blank lines", () => {
    const file = "ckb:\n  rpc_url: x\n\n# a note at column 0\n  udt_whitelist: []\n";
    expect(replaceWhitelist(file, [], HUB)).toBe(file);
  });

  describe("refuses a file it cannot edit safely", () => {
    it.each([
      ["no udt_whitelist key", "ckb:\n  rpc_url: x\n", /expected one udt_whitelist key, found 0/],
      ["two udt_whitelist keys", "fiber:\n  udt_whitelist: []\nckb:\n  udt_whitelist: []\n", /expected one udt_whitelist key, found 2/],
      ["two keys under ckb", "ckb:\n  udt_whitelist: []\n  udt_whitelist:\n    - name: A\n", /found 2/],
      ["the key under fiber", "fiber:\n  udt_whitelist: []\nckb:\n  rpc_url: x\n", /must sit under ckb/],
      ["the key at the top level", "udt_whitelist: []\nckb:\n  rpc_url: x\n", /must sit under ckb/],
      ["the key nested deeper under ckb", "ckb:\n  extra:\n    udt_whitelist: []\n", /must sit under ckb/],
      ["an inline null", "ckb:\n  udt_whitelist: ~\n", /block list or \[\]/],
      ["an inline null word", "ckb:\n  udt_whitelist: null\n", /block list or \[\]/],
      ["an inline flow list", "ckb:\n  udt_whitelist: [{name: A}]\n", /block list or \[\]/],
      ["an inline map", "ckb:\n  udt_whitelist: {}\n", /block list or \[\]/],
      ["[] followed by list items", "ckb:\n  udt_whitelist: []\n    - name: A\n", /cannot be followed by list items/],
      ["[] followed by indentless items", "ckb:\n  udt_whitelist: []\n  - name: A\n", /cannot be followed by list items/],
      ["[] followed by a bare - item", "ckb:\n  udt_whitelist: []\n  -\n    name: A\n", /cannot be followed by list items/],
    ])("%s", (_case, file, message) => {
      expect(() => replaceWhitelist(file, [], HUB)).toThrow(WhitelistError);
      expect(() => replaceWhitelist(file, [], HUB)).toThrow(message);
    });
  });
});

describe("whitelistedScripts and droppedTokens (the drop guard)", () => {
  const file = (entries: string): string => `ckb:\n  rpc_url: "x"\n  udt_whitelist:\n${entries}\nservices:\n  - ckb\n`;
  const rusd = (args: string) =>
    `    - name: RUSD\n      script:\n        code_hash: 0xAB\n        hash_type: type\n        ${args}\n      cell_deps:\n        - type_id:\n            code_hash: 0xcd\n            hash_type: type\n            args: 0x99`;

  it("reads each entry's own script, anchored or not, in lower case; a cell dep's script is not an entry", () => {
    expect(whitelistedScripts(file(rusd('args: "^0x01$"')))).toEqual(new Map([["0xab 0x01", "RUSD"]]));
    expect(whitelistedScripts(file(rusd("args: 0x01")))).toEqual(new Map([["0xab 0x01", "RUSD"]]));
    expect(whitelistedScripts("ckb:\n  udt_whitelist: []\n")).toEqual(new Map());
  });

  it("names what the new file leaves out, and nothing when only the anchors change", () => {
    expect(droppedTokens(file(rusd("args: 0x01")), file(rusd('args: "^0x01$"')))).toEqual([]);
    expect(droppedTokens(file(rusd("args: 0x01")), "ckb:\n  udt_whitelist: []\n")).toEqual(["RUSD"]);
  });
});
