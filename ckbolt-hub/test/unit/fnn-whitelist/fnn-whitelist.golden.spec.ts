import { join } from "node:path";
import { FNN_NODE_ROLE } from "../../../src/common/constants/fnn-config.constants";
import { runFnnWhitelist } from "../../../src/interfaces/cli/fnn-whitelist/main";
import { replaceWhitelist, whitelistEntries } from "../../../src/interfaces/cli/fnn-whitelist/whitelist";
import { aroundWhitelist, FIXTURE, FIXTURE_UDTS, GOLDEN, MemoryIo, toCrlf, udtsOf } from "./fnn-whitelist.fixtures";

/**
 * The kit's real fnn configs (frozen in fixtures/) regenerated from the VPS's FIBER_ASSETS: the output must be byte for
 * byte the golden files, which were generated once by the CLI and checked by hand (RUSD and cWBTC entries with anchored
 * args; fnn-hub auto-accepts only cWBTC, from peerChannels.minAmount; fnn-demo auto-accepts both from autoAcceptAmount;
 * nothing outside the udt_whitelist block changed).
 */

const HUB = FNN_NODE_ROLE.HUB;
const DEMO = FNN_NODE_ROLE.DEMO;
const hubEntries = whitelistEntries(FIXTURE_UDTS, HUB);
const demoEntries = whitelistEntries(FIXTURE_UDTS, DEMO);

describe("fnn-whitelist on the kit's configs (golden files)", () => {
  describe("the CLI with --assets-file and --out-dir, as the golden files were made", () => {
    const io = new MemoryIo({ "assets.json": FIXTURE.assetsJson, "fnn/hub.yml": FIXTURE.hubYml, "fnn/demo.yml": FIXTURE.demoYml });
    const code = runFnnWhitelist(["--assets-file", "assets.json", "--hub-yml", "fnn/hub.yml", "--demo-yml", "fnn/demo.yml", "--out-dir", "out"], io);

    it("succeeds and writes both files into the out folder, byte for byte the golden files", () => {
      expect(code).toBe(0);
      expect(io.stderr).toBe("");
      expect(io.writes.map(({ path }) => path)).toEqual([join("out", "hub.yml"), join("out", "demo.yml")]);
      expect(io.files.get(join("out", "hub.yml"))).toBe(GOLDEN.hubYml);
      expect(io.files.get(join("out", "demo.yml"))).toBe(GOLDEN.demoYml);
    });

    it("leaves the inputs as they were", () => {
      expect(io.files.get("fnn/hub.yml")).toBe(FIXTURE.hubYml);
      expect(io.files.get("fnn/demo.yml")).toBe(FIXTURE.demoYml);
    });
  });

  describe("replaceWhitelist", () => {
    it.each([
      ["hub.yml", HUB, () => FIXTURE.hubYml, () => GOLDEN.hubYml, hubEntries],
      ["demo.yml", DEMO, () => FIXTURE.demoYml, () => GOLDEN.demoYml, demoEntries],
    ] as const)("gives the golden %s", (_name, role, input, golden, entries) => {
      expect(replaceWhitelist(input(), entries, role)).toBe(golden());
    });

    it.each([
      ["hub.yml", HUB, () => GOLDEN.hubYml, hubEntries],
      ["demo.yml", DEMO, () => GOLDEN.demoYml, demoEntries],
    ] as const)("is idempotent: the golden %s generated again gives the same bytes", (_name, role, golden, entries) => {
      expect(replaceWhitelist(golden(), entries, role)).toBe(golden());
    });

    it.each([
      ["hub.yml", () => FIXTURE.hubYml, () => GOLDEN.hubYml],
      ["demo.yml", () => FIXTURE.demoYml, () => GOLDEN.demoYml],
    ] as const)("keeps every byte of %s before and after the udt_whitelist block", (_name, input, golden) => {
      const original = aroundWhitelist(input());
      const generated = aroundWhitelist(golden());
      expect(generated.before).toBe(original.before);
      expect(generated.after).toBe(original.after);
      expect(original.before.endsWith('  rpc_url: "https://testnet.ckbapp.dev/"\n')).toBe(true);
      expect(original.after).toBe("\nservices:\n  - fiber\n  - rpc\n  - ckb\n");
    });

    it.each([
      ["hub.yml", HUB, () => FIXTURE.hubYml, () => GOLDEN.hubYml, hubEntries],
      ["demo.yml", DEMO, () => FIXTURE.demoYml, () => GOLDEN.demoYml, demoEntries],
    ] as const)("keeps CRLF line ends: %s in CRLF gives the golden file in CRLF, and again the same", (_name, role, input, golden, entries) => {
      const once = replaceWhitelist(toCrlf(input()), entries, role);
      expect(once).toBe(toCrlf(golden()));
      expect(once.replace(/\r\n/g, "")).not.toContain("\n");
      expect(replaceWhitelist(once, entries, role)).toBe(once);
    });
  });

  describe("the golden files say what the VPS needs", () => {
    const block = (file: string): string => file.slice(file.indexOf("  udt_whitelist:"), file.indexOf("\nservices:"));

    it("whitelist RUSD, then cWBTC, each with its args anchored", () => {
      for (const file of [GOLDEN.hubYml, GOLDEN.demoYml]) {
        expect(block(file).match(/- name: \S+/g)).toEqual(["- name: RUSD", "- name: cWBTC"]);
        expect(block(file)).toContain('args: "^0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b$"');
        expect(block(file)).toContain('args: "^0x9a1086531ed6dc69e0bd44cef5278e03faf3015b31aff60b08fb87663ce8507100000000$"');
      }
    });

    it("let fnn-hub auto-accept only cWBTC, from its peerChannels.minAmount", () => {
      expect(block(GOLDEN.hubYml).match(/auto_accept_amount: \d+/g)).toEqual(["auto_accept_amount: 10000000"]);
      expect(block(GOLDEN.hubYml).indexOf("auto_accept_amount")).toBeGreaterThan(block(GOLDEN.hubYml).indexOf("- name: cWBTC"));
    });

    it("let fnn-demo auto-accept both from 1000000000 base units", () => {
      expect(block(GOLDEN.demoYml).match(/auto_accept_amount: \d+/g)).toEqual(["auto_accept_amount: 1000000000", "auto_accept_amount: 1000000000"]);
    });
  });

  describe("an empty FIBER_ASSETS", () => {
    it("renders `udt_whitelist: []` and changes nothing else", () => {
      const empty = replaceWhitelist(FIXTURE.hubYml, whitelistEntries(udtsOf("[]"), HUB), HUB);
      const original = aroundWhitelist(FIXTURE.hubYml);
      expect(empty).toBe(`${original.before}  udt_whitelist: []\n${original.after}`);
    });

    it("is idempotent, and the list generated into it again is the golden file", () => {
      const empty = replaceWhitelist(FIXTURE.demoYml, [], DEMO);
      expect(replaceWhitelist(empty, [], DEMO)).toBe(empty);
      expect(replaceWhitelist(empty, demoEntries, DEMO)).toBe(GOLDEN.demoYml);
    });

    it("keeps CRLF on the one line", () => {
      const empty = replaceWhitelist(toCrlf(FIXTURE.hubYml), [], HUB);
      expect(empty).toContain("\r\n  udt_whitelist: []\r\n\r\nservices:\r\n");
      expect(empty.replace(/\r\n/g, "")).not.toContain("\n");
    });
  });
});
