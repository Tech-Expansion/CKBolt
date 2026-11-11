import { join } from "node:path";
import { FNN_WHITELIST_USAGE, parseFnnWhitelistArgs } from "../../../src/interfaces/cli/fnn-whitelist/cli-args";
import { runFnnWhitelist } from "../../../src/interfaces/cli/fnn-whitelist/main";
import { WhitelistError } from "../../../src/interfaces/cli/fnn-whitelist/whitelist";
import { ASSETS_ONE_LINE, FIXTURE, GOLDEN, MemoryIo } from "./fnn-whitelist.fixtures";

/** The fnn-whitelist command line (parseFnnWhitelistArgs) and the CLI on in-memory files (runFnnWhitelist). */

const HUB_YML = "fnn/hub.yml";
const DEMO_YML = "fnn/demo.yml";
const ASSETS_FILE = "fiber-assets.json";
const BOTH = ["--hub-yml", HUB_YML, "--demo-yml", DEMO_YML];
const FROM_FILE = ["--assets-file", ASSETS_FILE];
const SECRET = "supersecretvalue0123456789abcdef";

/** The kit's files before generation, and the FIBER_ASSETS file. */
const kitFiles = (overrides: Record<string, string> = {}): Record<string, string> => ({
  [ASSETS_FILE]: FIXTURE.assetsJson,
  [HUB_YML]: FIXTURE.hubYml,
  [DEMO_YML]: FIXTURE.demoYml,
  ...overrides,
});

const assetsWith = (change: (entries: Array<Record<string, unknown>>) => unknown): string => {
  const entries = JSON.parse(FIXTURE.assetsJson) as Array<Record<string, unknown>>;
  return JSON.stringify(change(entries) ?? entries);
};

describe("parseFnnWhitelistArgs", () => {
  it("reads each source, the files and the switches", () => {
    expect(parseFnnWhitelistArgs(["--hub-env", "hub.env", "--hub-yml", "h.yml"])).toEqual({
      source: { kind: "env-file", path: "hub.env" },
      hubYml: "h.yml",
      demoYml: null,
      demoAutoAccept: {},
      write: false,
      outDir: null,
      checkConfig: false,
      allowDrop: false,
    });
    expect(parseFnnWhitelistArgs(["--assets-file", "a.json", "--demo-yml", "d.yml", "--write"])).toMatchObject({
      source: { kind: "assets-file", path: "a.json" },
      hubYml: null,
      demoYml: "d.yml",
      write: true,
    });
    expect(parseFnnWhitelistArgs(["--from-env", "--check-config", "--out-dir", "/out", ...BOTH])).toMatchObject({
      source: { kind: "process-env" },
      outDir: "/out",
      checkConfig: true,
    });
  });

  it("takes --check-config alone as something to do", () => {
    expect(parseFnnWhitelistArgs(["--from-env", "--check-config"])).toMatchObject({ hubYml: null, demoYml: null, checkConfig: true });
  });

  it("collects --demo-auto-accept pairs as bigints, over several flags, spaces and empty parts aside", () => {
    const options = parseFnnWhitelistArgs([...FROM_FILE, ...BOTH, "--demo-auto-accept", " RUSD=1000000000 , CWBTC=7,", "--demo-auto-accept", "X2=340282366920938463463374607431768211456"]);
    expect(options.demoAutoAccept).toEqual({ RUSD: 1_000_000_000n, CWBTC: 7n, X2: 1n << 128n });
  });

  describe("refuses", () => {
    it.each([
      ["an unknown option", [...FROM_FILE, ...BOTH, "--force"], /unknown option --force/],
      ["a bare argument", [...FROM_FILE, HUB_YML], /unknown option fnn\/hub.yml/],
      ["a flag without its value at the end", [...FROM_FILE, "--hub-yml"], /--hub-yml needs a value/],
      ["a flag followed by another flag", [...FROM_FILE, "--hub-yml", "--write"], /--hub-yml needs a value/],
      ["a flag given twice", [...FROM_FILE, "--hub-yml", "a", "--hub-yml", "b"], /--hub-yml is given twice/],
      ["no source", [...BOTH], /exactly one of --hub-env, --assets-file and --from-env/],
      ["two sources", [...FROM_FILE, "--from-env", ...BOTH], /exactly one of/],
      ["the same source twice", [...FROM_FILE, ...FROM_FILE, ...BOTH], /--assets-file is given twice/],
      ["--write with --out-dir", [...FROM_FILE, ...BOTH, "--write", "--out-dir", "o"], /--write and --out-dir exclude each other/],
      ["nothing to do", [...FROM_FILE], /nothing to do/],
      ["nothing to do but writing", [...FROM_FILE, "--write"], /nothing to do/],
      ["an asset named twice in --demo-auto-accept", [...FROM_FILE, ...BOTH, "--demo-auto-accept", "RUSD=1", "--demo-auto-accept", "RUSD=2"], /names RUSD twice/],
    ])("%s", (_case, argv, message) => {
      expect(() => parseFnnWhitelistArgs(argv)).toThrow(WhitelistError);
      expect(() => parseFnnWhitelistArgs(argv)).toThrow(message);
    });

    it.each([["rusd=1"], ["RUSD=0"], ["RUSD=01"], ["RUSD=1.5"], ["RUSD=-1"], ["RUSD=1e9"], ["RUSD"], ["RUSD="], ["=5"], ["RUSD=1=2"], ["R=1"], ["CKB 1=1"]])(
      "the --demo-auto-accept pair %j",
      (pair) => {
        expect(() => parseFnnWhitelistArgs([...FROM_FILE, ...BOTH, "--demo-auto-accept", pair])).toThrow(/--demo-auto-accept takes ID=AMOUNT/);
      },
    );
  });
});

describe("runFnnWhitelist", () => {
  describe("a dry run (no --write, no --out-dir)", () => {
    const io = new MemoryIo(kitFiles());
    const code = runFnnWhitelist([...FROM_FILE, ...BOTH], io);

    it("writes nothing", () => {
      expect(code).toBe(0);
      expect(io.writes).toEqual([]);
      expect(io.files.get(HUB_YML)).toBe(FIXTURE.hubYml);
      expect(io.files.get(DEMO_YML)).toBe(FIXTURE.demoYml);
    });

    it("prints each file's diff and says it would change", () => {
      expect(io.stdout).toContain(`--- ${HUB_YML}\n+++ ${HUB_YML} (generated)\n@@ -64,11 +64,13 @@\n`);
      expect(io.stdout).toContain(`--- ${DEMO_YML}\n+++ ${DEMO_YML} (generated)\n@@ -61,17 +61,19 @@\n`);
      expect(io.stdout).toContain("+      auto_accept_amount: 10000000\n");
      expect(io.stdout).toContain(`${HUB_YML}: would change (dry run)\n`);
      expect(io.stdout).toContain(`${DEMO_YML}: would change (dry run)\n`);
      expect(io.stderr).toBe("");
    });

    it("says unchanged and prints no diff for files already generated", () => {
      const again = new MemoryIo(kitFiles({ [HUB_YML]: GOLDEN.hubYml, [DEMO_YML]: GOLDEN.demoYml }));
      expect(runFnnWhitelist([...FROM_FILE, ...BOTH], again)).toBe(0);
      expect(again.stdout).toBe(`${HUB_YML}: unchanged\n${DEMO_YML}: unchanged\n`);
      expect(again.writes).toEqual([]);
    });
  });

  describe("--write", () => {
    it("writes only the files that change, in place", () => {
      const io = new MemoryIo(kitFiles({ [HUB_YML]: GOLDEN.hubYml }));
      expect(runFnnWhitelist([...FROM_FILE, ...BOTH, "--write"], io)).toBe(0);
      expect(io.writes).toEqual([{ path: DEMO_YML, text: GOLDEN.demoYml }]);
      expect(io.stdout).toContain(`${HUB_YML}: unchanged\n`);
      expect(io.stdout).toContain(`${DEMO_YML}: written\n`);
    });

    it("writes both from the originals, and nothing on a second run", () => {
      const io = new MemoryIo(kitFiles());
      expect(runFnnWhitelist([...FROM_FILE, ...BOTH, "--write"], io)).toBe(0);
      expect(io.writes.map(({ path }) => path)).toEqual([HUB_YML, DEMO_YML]);
      expect(io.files.get(HUB_YML)).toBe(GOLDEN.hubYml);
      expect(io.files.get(DEMO_YML)).toBe(GOLDEN.demoYml);

      io.writes.length = 0;
      expect(runFnnWhitelist([...FROM_FILE, ...BOTH, "--write"], io)).toBe(0);
      expect(io.writes).toEqual([]);
    });

    it("touches only the file it is given", () => {
      const io = new MemoryIo(kitFiles());
      expect(runFnnWhitelist([...FROM_FILE, "--demo-yml", DEMO_YML, "--write"], io)).toBe(0);
      expect(io.writes.map(({ path }) => path)).toEqual([DEMO_YML]);
      expect(io.stdout).not.toContain(HUB_YML);
    });
  });

  describe("a token the files whitelist now and the new list leaves out", () => {
    /** FIBER_ASSETS without its last entry: the golden files whitelist one token more. */
    const fewer = (): string => assetsWith((entries) => entries.slice(0, -1));
    const golden = () => kitFiles({ [HUB_YML]: GOLDEN.hubYml, [DEMO_YML]: GOLDEN.demoYml });

    it("--write refuses it, writes nothing, and names the token and the file", () => {
      const io = new MemoryIo({ ...golden(), [ASSETS_FILE]: fewer() });
      expect(runFnnWhitelist([...FROM_FILE, ...BOTH, "--write"], io)).toBe(1);
      expect(io.writes).toEqual([]);
      expect(io.stderr).toMatch(new RegExp(`leaves out ${HUB_YML}: \\S+.*--allow-drop`));
    });

    it("--write --allow-drop writes the shorter list", () => {
      const io = new MemoryIo({ ...golden(), [ASSETS_FILE]: fewer() });
      expect(runFnnWhitelist([...FROM_FILE, ...BOTH, "--write", "--allow-drop"], io)).toBe(0);
      expect(io.writes.map(({ path }) => path)).toEqual([HUB_YML, DEMO_YML]);
    });

    it("a dry run only notes it; --out-dir (add_token.py, which compares with the files fnn runs) does not look", () => {
      const dry = new MemoryIo({ ...golden(), [ASSETS_FILE]: fewer() });
      expect(runFnnWhitelist([...FROM_FILE, ...BOTH], dry)).toBe(0);
      expect(dry.stdout).toContain("note: the new whitelist leaves out");
      const out = new MemoryIo({ ...golden(), [ASSETS_FILE]: fewer() });
      expect(runFnnWhitelist([...FROM_FILE, ...BOTH, "--out-dir", "/tmp/out"], out)).toBe(0);
      expect(out.stdout).not.toContain("leaves out");
    });

    it("--allow-drop goes with --write only", () => {
      expect(() => parseFnnWhitelistArgs([...FROM_FILE, ...BOTH, "--allow-drop"])).toThrow(WhitelistError);
      expect(parseFnnWhitelistArgs([...FROM_FILE, ...BOTH, "--write", "--allow-drop"]).allowDrop).toBe(true);
    });
  });

  describe("--out-dir", () => {
    it("writes both files into the folder by file name, changed or not, and leaves the inputs alone", () => {
      const io = new MemoryIo(kitFiles({ [HUB_YML]: GOLDEN.hubYml }));
      expect(runFnnWhitelist([...FROM_FILE, ...BOTH, "--out-dir", "/tmp/out"], io)).toBe(0);
      expect(io.writes).toEqual([
        { path: join("/tmp/out", "hub.yml"), text: GOLDEN.hubYml },
        { path: join("/tmp/out", "demo.yml"), text: GOLDEN.demoYml },
      ]);
      expect(io.files.get(HUB_YML)).toBe(GOLDEN.hubYml);
      expect(io.files.get(DEMO_YML)).toBe(FIXTURE.demoYml);
      expect(io.stdout).toContain(`${HUB_YML}: unchanged\n`);
      expect(io.stdout).toContain(`${DEMO_YML}: changed, written to /tmp/out\n`);
    });
  });

  describe("--demo-auto-accept", () => {
    it("changes fnn-demo's amount for that asset only, never fnn-hub's", () => {
      const io = new MemoryIo(kitFiles());
      expect(runFnnWhitelist([...FROM_FILE, ...BOTH, "--out-dir", "o", "--demo-auto-accept", "CWBTC=500000000"], io)).toBe(0);
      const demo = io.files.get(join("o", "demo.yml"))!;
      expect(io.files.get(join("o", "hub.yml"))).toBe(GOLDEN.hubYml);
      expect(demo.match(/auto_accept_amount: \d+/g)).toEqual(["auto_accept_amount: 1000000000", "auto_accept_amount: 500000000"]);
      expect(demo).toContain("opens with 5 cWBTC or more");
    });

    it("refuses an asset FIBER_ASSETS does not list, writing nothing", () => {
      const io = new MemoryIo(kitFiles());
      expect(runFnnWhitelist([...FROM_FILE, ...BOTH, "--write", "--demo-auto-accept", "DOGE=1"], io)).toBe(1);
      expect(io.writes).toEqual([]);
      expect(io.stderr).toContain("--demo-auto-accept names DOGE, which FIBER_ASSETS does not list");
    });

    it("refuses an amount above fnn's u128, writing nothing", () => {
      const io = new MemoryIo(kitFiles());
      expect(runFnnWhitelist([...FROM_FILE, ...BOTH, "--write", "--demo-auto-accept", `RUSD=${1n << 128n}`], io)).toBe(1);
      expect(io.writes).toEqual([]);
      expect(io.stderr).toMatch(/RUSD.*u128/);
    });
  });

  describe("refused FIBER_ASSETS: exit 1, nothing written, no diff, the reason and the usage on stderr", () => {
    const badCodeHash = assetsWith((entries) => {
      (entries[0]!.typeScript as Record<string, unknown>).codeHash = "0x1234";
    });
    const acceptAboveInbound = assetsWith((entries) => {
      entries[0]!.autoAcceptAmount = "3000000000";
    });
    const duplicateId = assetsWith((entries) => {
      entries[1]!.id = "RUSD";
    });
    const sameScript = assetsWith((entries) => {
      entries[1]!.typeScript = entries[0]!.typeScript;
    });
    const peerTypo = assetsWith((entries) => {
      entries[1]!.peerChannels = { minAmount: "1", maxAmount: "2" };
    });
    const peerZero = assetsWith((entries) => {
      entries[1]!.peerChannels = { minAmount: "0" };
    });
    const noCellDeps = assetsWith((entries) => {
      entries[0]!.cellDeps = [];
    });

    it.each([
      ["not JSON", "[{", /FIBER_ASSETS is refused: FIBER_ASSETS: must be JSON/],
      ["not a list", "{}", /FIBER_ASSETS is refused/],
      ["a bad code hash", badCodeHash, /FIBER_ASSETS\.0\.typeScript\.codeHash/],
      ["autoAcceptAmount above inboundAmount", acceptAboveInbound, /FIBER_ASSETS\.0\.autoAcceptAmount/],
      ["an id listed twice", duplicateId, /RUSD is listed twice/],
      ["a type script listed twice", sameScript, /another asset already has this type script/],
      ["an unknown key in peerChannels", peerTypo, /FIBER_ASSETS\.1\.peerChannels/],
      ["peerChannels.minAmount 0", peerZero, /FIBER_ASSETS\.1\.peerChannels\.minAmount/],
      ["no cell deps", noCellDeps, /FIBER_ASSETS\.0\.cellDeps/],
    ])("%s", (_case, assets, message) => {
      const io = new MemoryIo(kitFiles({ [ASSETS_FILE]: assets }));
      expect(runFnnWhitelist([...FROM_FILE, ...BOTH, "--write"], io)).toBe(1);
      expect(io.writes).toEqual([]);
      expect(io.stdout).toBe("");
      expect(io.stderr).toMatch(/^fnn-whitelist: /);
      expect(io.stderr).toMatch(message);
      expect(io.stderr).toContain(FNN_WHITELIST_USAGE);
    });
  });

  describe("a config file it cannot edit", () => {
    it("refuses it by path and writes neither file, even the one it could edit", () => {
      const broken = FIXTURE.demoYml.replace("  udt_whitelist:\n", "  whitelist:\n");
      const io = new MemoryIo(kitFiles({ [DEMO_YML]: broken }));
      expect(runFnnWhitelist([...FROM_FILE, ...BOTH, "--write"], io)).toBe(1);
      expect(io.writes).toEqual([]);
      expect(io.stdout).toBe("");
      expect(io.stderr).toContain(`${DEMO_YML}: expected one udt_whitelist key, found 0`);
    });

    it.each([
      ["a second udt_whitelist key", FIXTURE.hubYml.replace("  listening_addr: \"127.0.0.1:8227\"\n", "  listening_addr: \"127.0.0.1:8227\"\n  udt_whitelist: []\n"), /found 2/],
      ["the key moved under rpc", FIXTURE.hubYml.replace("ckb:\n  # Overridden", "rpc2:\n  # Overridden"), /must sit under ckb/],
      ["an inline value", FIXTURE.hubYml.replace(/ {2}udt_whitelist:\n(?: {4}.*\n)+/, "  udt_whitelist: ~\n"), /block list or \[\]/],
    ])("refuses %s in hub.yml", (_case, hubYml, message) => {
      const io = new MemoryIo(kitFiles({ [HUB_YML]: hubYml }));
      expect(runFnnWhitelist([...FROM_FILE, ...BOTH, "--out-dir", "o"], io)).toBe(1);
      expect(io.writes).toEqual([]);
      expect(io.stderr).toContain(`${HUB_YML}: `);
      expect(io.stderr).toMatch(message);
    });
  });

  it("refuses bad flags with exit 1 and the usage, touching nothing", () => {
    const io = new MemoryIo(kitFiles());
    expect(runFnnWhitelist([...FROM_FILE, ...BOTH, "--write", "--out-dir", "o"], io)).toBe(1);
    expect(io.writes).toEqual([]);
    expect(io.stderr).toBe(`fnn-whitelist: --write and --out-dir exclude each other\n\n${FNN_WHITELIST_USAGE}\n`);
  });

  describe("--hub-env", () => {
    /** hub.env as add_token.py writes it: FIBER_ASSETS single-quoted on one line, a ' in JSON as '. */
    const withApostrophe = assetsWith((entries) => {
      entries[0]!.name = "Bob's RUSD";
    }).replace(/'/g, "\\u0027");
    const hubEnv = ["# hub.env of the kit", `HUB_PROXY_SECRET=${SECRET}`, "", `FIBER_ASSETS='${withApostrophe}'`, "CKB_NETWORK=testnet", ""].join("\n");

    it("reads FIBER_ASSETS from a single-quoted line and generates the golden files", () => {
      const io = new MemoryIo(kitFiles({ "hub.env": hubEnv }));
      expect(runFnnWhitelist(["--hub-env", "hub.env", ...BOTH, "--out-dir", "o"], io)).toBe(0);
      expect(io.files.get(join("o", "hub.yml"))).toBe(GOLDEN.hubYml);
      expect(io.files.get(join("o", "demo.yml"))).toBe(GOLDEN.demoYml);
      expect(io.stdout + io.stderr).not.toContain(SECRET);
    });

    it("reads the same from a CRLF env file", () => {
      const io = new MemoryIo(kitFiles({ "hub.env": hubEnv.replace(/\n/g, "\r\n") }));
      expect(runFnnWhitelist(["--hub-env", "hub.env", ...BOTH, "--out-dir", "o"], io)).toBe(0);
      expect(io.files.get(join("o", "demo.yml"))).toBe(GOLDEN.demoYml);
    });

    it("refuses an env file without FIBER_ASSETS, naming it and not printing its values", () => {
      const io = new MemoryIo(kitFiles({ "hub.env": `HUB_PROXY_SECRET=${SECRET}\n` }));
      expect(runFnnWhitelist(["--hub-env", "hub.env", ...BOTH], io)).toBe(1);
      expect(io.stderr).toContain("FIBER_ASSETS is not set in hub.env");
      expect(io.stdout + io.stderr).not.toContain(SECRET);
      expect(io.writes).toEqual([]);
    });

    it("refuses an empty FIBER_ASSETS line", () => {
      const io = new MemoryIo(kitFiles({ "hub.env": "FIBER_ASSETS=\n" }));
      expect(runFnnWhitelist(["--hub-env", "hub.env", ...BOTH], io)).toBe(1);
      expect(io.stderr).toContain("FIBER_ASSETS is not set in hub.env");
    });
  });

  describe("--from-env", () => {
    it("reads FIBER_ASSETS from the environment", () => {
      const io = new MemoryIo(kitFiles(), { FIBER_ASSETS: ASSETS_ONE_LINE });
      expect(runFnnWhitelist(["--from-env", ...BOTH, "--out-dir", "o"], io)).toBe(0);
      expect(io.files.get(join("o", "hub.yml"))).toBe(GOLDEN.hubYml);
    });

    it("refuses an environment without it", () => {
      const io = new MemoryIo(kitFiles(), { FIBER_ASSETS: "  " });
      expect(runFnnWhitelist(["--from-env", ...BOTH], io)).toBe(1);
      expect(io.stderr).toContain("FIBER_ASSETS is not set in the environment");
    });

    it("renders `udt_whitelist: []` for an empty list", () => {
      const io = new MemoryIo(kitFiles(), { FIBER_ASSETS: "[]" });
      expect(runFnnWhitelist(["--from-env", ...BOTH, "--out-dir", "o"], io)).toBe(0);
      expect(io.files.get(join("o", "hub.yml"))).toContain("\n  udt_whitelist: []\n\nservices:\n");
    });
  });

  describe("--check-config", () => {
    const validEnv = { FIBER_ASSETS: ASSETS_ONE_LINE, CKB_NETWORK: "testnet" };

    it("prints `hub configuration ok` with the assets and peer channels of a valid environment, then generates", () => {
      const io = new MemoryIo(kitFiles(), validEnv);
      expect(runFnnWhitelist(["--from-env", "--check-config", ...BOTH, "--out-dir", "o"], io)).toBe(0);
      expect(io.stdout.startsWith("hub configuration ok: assets CKB, RUSD, CWBTC; peer channels: CWBTC from 10000000 base units\n")).toBe(true);
      expect(io.writes).toHaveLength(2);
    });

    it("works alone, without config files", () => {
      const io = new MemoryIo({}, validEnv);
      expect(runFnnWhitelist(["--from-env", "--check-config"], io)).toBe(0);
      expect(io.stdout).toMatch(/^hub configuration ok: /);
    });

    it("says none when no asset takes peer channels", () => {
      const io = new MemoryIo({}, { FIBER_ASSETS: assetsWith((entries) => entries.map(({ peerChannels: _drop, ...rest }) => rest)) });
      expect(runFnnWhitelist(["--from-env", "--check-config"], io)).toBe(0);
      expect(io.stdout).toContain("peer channels: none");
    });

    it("loads the env file's settings under the environment's", () => {
      const io = new MemoryIo({ "hub.env": `FIBER_ASSETS='${ASSETS_ONE_LINE}'\nLN_MAX_PAYMENT_PARTS=0\n` }, { LN_MAX_PAYMENT_PARTS: "1" });
      expect(runFnnWhitelist(["--hub-env", "hub.env", "--check-config"], io)).toBe(0);
      expect(io.stdout).toMatch(/^hub configuration ok: assets CKB, RUSD, CWBTC/);
    });

    it.each([
      ["a bad tunable", { ...validEnv, LN_MAX_PAYMENT_PARTS: "0" }, /LN_MAX_PAYMENT_PARTS/],
      ["a legacy inbound variable next to FIBER_ASSETS", { ...validEnv, FIBER_INBOUND_RUSD_AMOUNT: "1000" }, /FIBER_INBOUND_RUSD_AMOUNT/],
    ])("refuses an invalid environment (%s): exit 1, nothing written, no diff", (_case, env, message) => {
      const io = new MemoryIo(kitFiles(), env);
      expect(runFnnWhitelist(["--from-env", "--check-config", ...BOTH, "--out-dir", "o"], io)).toBe(1);
      expect(io.writes).toEqual([]);
      expect(io.stdout).toBe("");
      expect(io.stderr).toMatch(message);
      expect(io.stderr).toContain(FNN_WHITELIST_USAGE);
    });

    describe("checks the very FIBER_ASSETS the whitelists are generated from", () => {
      const swapsBackwards = assetsWith((entries) => {
        entries[1]!.minSats = "5000";
        entries[1]!.maxSats = "1000";
      });

      it("from --assets-file, with no FIBER_ASSETS in the environment", () => {
        const io = new MemoryIo(kitFiles());
        expect(runFnnWhitelist([...FROM_FILE, "--check-config"], io)).toBe(0);
        expect(io.stdout).toBe("hub configuration ok: assets CKB, RUSD, CWBTC; peer channels: CWBTC from 10000000 base units\n");
      });

      it("from --assets-file, over another FIBER_ASSETS in the environment", () => {
        const io = new MemoryIo(kitFiles(), { FIBER_ASSETS: "[]", CKB_NETWORK: "testnet" });
        expect(runFnnWhitelist([...FROM_FILE, "--check-config"], io)).toBe(0);
        expect(io.stdout).toMatch(/^hub configuration ok: assets CKB, RUSD, CWBTC;/);
      });

      it("from --hub-env, over a broken FIBER_ASSETS in the environment", () => {
        const io = new MemoryIo(kitFiles({ "hub.env": `FIBER_ASSETS='${ASSETS_ONE_LINE}'\n` }), { FIBER_ASSETS: "not json" });
        expect(runFnnWhitelist(["--hub-env", "hub.env", "--check-config", ...BOTH, "--out-dir", "o"], io)).toBe(0);
        expect(io.stdout).toMatch(/^hub configuration ok: assets CKB, RUSD, CWBTC;/);
        expect(io.files.get(join("o", "hub.yml"))).toBe(GOLDEN.hubYml);
      });

      it("refuses a list the schema takes but the hub does not (minSats above maxSats), writing nothing", () => {
        const io = new MemoryIo(kitFiles({ [ASSETS_FILE]: swapsBackwards }));
        expect(runFnnWhitelist([...FROM_FILE, "--check-config", ...BOTH, "--out-dir", "o"], io)).toBe(1);
        expect(io.writes).toEqual([]);
        expect(io.stdout).toBe("");
        expect(io.stderr).toMatch(/CWBTC would swap from 5000 to 1000 sats/);
      });

      it("generates that list without --check-config: only the hub's own rules catch it", () => {
        const io = new MemoryIo(kitFiles({ [ASSETS_FILE]: swapsBackwards }));
        expect(runFnnWhitelist([...FROM_FILE, ...BOTH, "--out-dir", "o"], io)).toBe(0);
        expect(io.files.get(join("o", "hub.yml"))).toBe(GOLDEN.hubYml);
      });

      it("still takes the rest of the configuration from the environment", () => {
        const io = new MemoryIo(kitFiles(), { LN_MAX_PAYMENT_PARTS: "0" });
        expect(runFnnWhitelist([...FROM_FILE, "--check-config"], io)).toBe(1);
        expect(io.stderr).toMatch(/LN_MAX_PAYMENT_PARTS/);
      });
    });
  });

  describe("--out-dir file names", () => {
    const sameName = { "a/config.yml": FIXTURE.hubYml, "b/config.yml": FIXTURE.demoYml };

    it.each([
      ["two files with the same name", ["--hub-yml", "a/config.yml", "--demo-yml", "b/config.yml"]],
      ["the same file twice", ["--hub-yml", "a/config.yml", "--demo-yml", "a/config.yml"]],
    ])("refuses %s: exit 1, nothing written", (_case, files) => {
      const io = new MemoryIo(kitFiles(sameName));
      expect(runFnnWhitelist([...FROM_FILE, ...files, "--out-dir", "o"], io)).toBe(1);
      expect(io.writes).toEqual([]);
      expect(io.stdout).toBe("");
      expect(io.stderr).toContain("--out-dir needs --hub-yml and --demo-yml files with different names");
    });

    it("takes the same names without --out-dir, where each file is written in place", () => {
      const io = new MemoryIo(kitFiles(sameName));
      expect(runFnnWhitelist([...FROM_FILE, "--hub-yml", "a/config.yml", "--demo-yml", "b/config.yml", "--write"], io)).toBe(0);
      expect(io.files.get("a/config.yml")).toBe(GOLDEN.hubYml);
      expect(io.files.get("b/config.yml")).toBe(GOLDEN.demoYml);
    });

    it("takes one file with --out-dir", () => {
      const io = new MemoryIo(kitFiles(sameName));
      expect(runFnnWhitelist([...FROM_FILE, "--demo-yml", "b/config.yml", "--out-dir", "o"], io)).toBe(0);
      expect(io.writes).toEqual([{ path: join("o", "config.yml"), text: GOLDEN.demoYml }]);
    });
  });

  describe("a file that cannot be read", () => {
    /** The io contract: a read the io refuses is a WhitelistError (main.ts's node io turns fs errors into one). */
    class RefusingIo extends MemoryIo {
      override readFile(path: string): string {
        if (!this.files.has(path)) throw new WhitelistError(`cannot read ${path}: ENOENT`);
        return super.readFile(path);
      }
    }

    it("is refused with its path, and nothing is written, not even the files read before it", () => {
      const files = kitFiles();
      delete files[DEMO_YML];
      const io = new RefusingIo(files);
      expect(runFnnWhitelist([...FROM_FILE, ...BOTH, "--write"], io)).toBe(1);
      expect(io.writes).toEqual([]);
      expect(io.stdout).toBe("");
      expect(io.stderr).toContain(`fnn-whitelist: cannot read ${DEMO_YML}`);
    });

    it("is refused for the FIBER_ASSETS source too", () => {
      const io = new RefusingIo({});
      expect(runFnnWhitelist(["--hub-env", "missing.env", ...BOTH], io)).toBe(1);
      expect(io.stderr).toContain("cannot read missing.env");
    });

    it("from an io that throws anything else, is not swallowed", () => {
      const io = new MemoryIo({ [ASSETS_FILE]: FIXTURE.assetsJson });
      expect(() => runFnnWhitelist([...FROM_FILE, ...BOTH], io)).toThrow(/ENOENT/);
    });
  });
});
