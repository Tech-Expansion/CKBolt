import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fiberAssetsJson, fromFiberAssetsEntry, type UdtAssetSettings } from "../../../src/config/fiber-assets.config";
import type { CellDep, Script } from "../../../src/domain/types";
import type { FnnWhitelistIo } from "../../../src/interfaces/cli/fnn-whitelist/main";

/**
 * Shared inputs of the fnn-whitelist tests. fixtures/hub.yml and demo.yml are the kit's fnn configs frozen as they were
 * before the generator existed (`git show HEAD:deploy/testnet/fnn/*.yml`), so the tests never read the repo's live copies,
 * which the generator rewrites. fixtures/fiber-assets.json is the VPS example of .env.example (RUSD, then CWBTC) with
 * RUSD's autoAcceptAmount 1000000000 and CWBTC's peerChannels.minAmount 10000000. golden/ holds what the CLI generated
 * from them, checked by hand once.
 */

/** Files read as LF: a Windows checkout may turn them into CRLF, which the CRLF tests cover on their own. */
const readLf = (...parts: string[]): string => readFileSync(join(__dirname, ...parts), "utf8").replace(/\r\n/g, "\n");

export const FIXTURE = {
  hubYml: readLf("fixtures", "hub.yml"),
  demoYml: readLf("fixtures", "demo.yml"),
  assetsJson: readLf("fixtures", "fiber-assets.json"),
} as const;

export const GOLDEN = {
  hubYml: readLf("golden", "hub.yml"),
  demoYml: readLf("golden", "demo.yml"),
} as const;

/** FIBER_ASSETS read the way the hub reads it at start-up. */
export const udtsOf = (json: string): UdtAssetSettings[] => fiberAssetsJson.parse(json).map(fromFiberAssetsEntry);

export const FIXTURE_UDTS = udtsOf(FIXTURE.assetsJson);

/** The same JSON on one line, as an env file or `-e` carries it. */
export const ASSETS_ONE_LINE = JSON.stringify(JSON.parse(FIXTURE.assetsJson));

export const toCrlf = (text: string): string => text.replace(/\n/g, "\r\n");

/** The text before and after the `udt_whitelist` block of a file: the key line up to the last line of its list. */
export function aroundWhitelist(file: string): { before: string; after: string } {
  const lines = file.split("\n");
  const key = lines.findIndex((line) => /^ *udt_whitelist:/.test(line));
  const indent = lines[key]!.length - lines[key]!.trimStart().length;
  let last = key;
  for (let i = key + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    if (line.length - line.trimStart().length <= indent) break;
    last = i;
  }
  return { before: lines.slice(0, key).join("\n") + "\n", after: lines.slice(last + 1).join("\n") };
}

/* ---------------------------------------------------------------------------------------------- hand-made assets */

export const SCRIPT_A: Script = { codeHash: `0x${"aa".repeat(32)}`, hashType: "type", args: `0x${"01".repeat(20)}` };
export const SCRIPT_B: Script = { codeHash: `0x${"bb".repeat(32)}`, hashType: "data1", args: "0x" };
export const OUT_POINT_DEP: CellDep = { outPoint: { txHash: `0x${"cc".repeat(32)}`, index: "0x2" }, depType: "dep_group" };
export const TYPE_ID_DEP: CellDep = { typeId: { codeHash: `0x${"dd".repeat(32)}`, hashType: "type", args: `0x${"ee".repeat(32)}` } };

/** A UDT's settings as fromFiberAssetsEntry would give them; `overrides` replaces fields of the settings. */
export function udt(id: string, overrides: Partial<UdtAssetSettings> = {}, symbol = id): UdtAssetSettings {
  return {
    asset: { id, symbol, name: `${id} token`, decimals: 8, udtTypeScript: SCRIPT_A, usdRule: "usd_peg", cellDeps: [TYPE_ID_DEP] },
    terms: {},
    ...overrides,
  };
}

/* ------------------------------------------------------------------------------------------------ in-memory io */

/** The CLI's io on memory: files by path, every write recorded, stdout and stderr collected. */
export class MemoryIo implements FnnWhitelistIo {
  readonly files: Map<string, string>;
  readonly writes: Array<{ path: string; text: string }> = [];
  stdout = "";
  stderr = "";

  constructor(
    files: Record<string, string>,
    public env: NodeJS.ProcessEnv = {},
  ) {
    this.files = new Map(Object.entries(files));
  }

  readFile(path: string): string {
    const text = this.files.get(path);
    if (text === undefined) throw new Error(`ENOENT: no such file ${path}`);
    return text;
  }

  writeFile(path: string, text: string): void {
    this.writes.push({ path, text });
    this.files.set(path, text);
  }

  out(text: string): void {
    this.stdout += text;
  }

  err(text: string): void {
    this.stderr += text;
  }
}
