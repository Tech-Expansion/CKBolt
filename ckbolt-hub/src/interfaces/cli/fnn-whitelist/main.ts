import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseEnv } from "node:util";
import { FNN_NODE_ROLE, type FnnNodeRole } from "../../../common/constants/fnn-config.constants";
import { fiberAssetsJson, fromFiberAssetsEntry, type UdtAssetSettings } from "../../../config/fiber-assets.config";
import { assetRegistryOf, loadHubConfig } from "../../../config/hub.config";
import { FNN_WHITELIST_USAGE, parseFnnWhitelistArgs, type AssetsSource, type FnnWhitelistOptions } from "./cli-args";
import { unifiedDiff } from "./line-diff";
import { droppedTokens, replaceWhitelist, whitelistEntries, WhitelistError } from "./whitelist";

/**
 * fnn-whitelist: generates fnn's `ckb.udt_whitelist` of the kit's fnn-hub and fnn-demo (deploy/testnet/fnn/hub.yml and
 * demo.yml) from the hub's FIBER_ASSETS, the one place tokens are configured (docs/add-token.md). Run from the repo with
 * `npm run fnn-whitelist -- ...`, or in the hub image on the server (`node dist/interfaces/cli/fnn-whitelist/main.js`),
 * which is how deploy/testnet/add_token.py validates and generates with the hub's own rules.
 */

const FIBER_ASSETS_VARIABLE = "FIBER_ASSETS";
const EXIT = { OK: 0, REFUSED: 1 } as const;

/** What the CLI touches outside itself, so tests can run it on memory. */
export interface FnnWhitelistIo {
  readFile(path: string): string;
  writeFile(path: string, text: string): void;
  env: NodeJS.ProcessEnv;
  out(text: string): void;
  err(text: string): void;
}

/** Reads a file; a file that cannot be read is refused with its path, not a stack trace. */
function readFileOrRefuse(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new WhitelistError(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Writes a file; a file that cannot be written is refused with its path, not a stack trace. */
function writeFileOrRefuse(path: string, text: string): void {
  try {
    writeFileSync(path, text, "utf8");
  } catch (error) {
    throw new WhitelistError(`cannot write ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const nodeIo = (): FnnWhitelistIo => ({
  readFile: readFileOrRefuse,
  writeFile: writeFileOrRefuse,
  env: process.env,
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
});

/** The FIBER_ASSETS JSON text from where the options say. */
function assetsText(source: AssetsSource, io: FnnWhitelistIo): string {
  if (source.kind === "assets-file") return io.readFile(source.path);
  const value = source.kind === "env-file" ? parseEnv(io.readFile(source.path))[FIBER_ASSETS_VARIABLE] : io.env[FIBER_ASSETS_VARIABLE];
  const where = source.kind === "env-file" ? source.path : "the environment";
  if (value === undefined || value.trim() === "") throw new WhitelistError(`${FIBER_ASSETS_VARIABLE} is not set in ${where}: the whitelist comes from it`);
  return value;
}

/** FIBER_ASSETS read with the hub's own schema: the same rules as at the hub's start-up. */
function readAssets(text: string): UdtAssetSettings[] {
  const parsed = fiberAssetsJson.safeParse(text);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${[FIBER_ASSETS_VARIABLE, ...issue.path].join(".")}: ${issue.message}`);
    throw new WhitelistError(`FIBER_ASSETS is refused: ${issues.join("; ")}`);
  }
  return parsed.data.map(fromFiberAssetsEntry);
}

/** --demo-auto-accept may name only the assets FIBER_ASSETS lists. */
function assertKnownDemoIds(options: FnnWhitelistOptions, udts: readonly UdtAssetSettings[]): void {
  const unknown = Object.keys(options.demoAutoAccept).filter((id) => !udts.some(({ asset }) => asset.id === id));
  if (unknown.length > 0) throw new WhitelistError(`--demo-auto-accept names ${unknown.join(", ")}, which FIBER_ASSETS does not list`);
}

/**
 * The whole hub configuration as the hub would load it from this environment (and the env file, which it does not
 * override), with the FIBER_ASSETS the whitelists are generated from, so both see the same list.
 */
function checkConfig(options: FnnWhitelistOptions, fiberAssets: string, io: FnnWhitelistIo): void {
  const fromFile = options.source.kind === "env-file" ? parseEnv(io.readFile(options.source.path)) : {};
  let config;
  try {
    config = loadHubConfig({ ...fromFile, ...io.env, [FIBER_ASSETS_VARIABLE]: fiberAssets });
  } catch (error) {
    throw new WhitelistError(error instanceof Error ? error.message : String(error));
  }
  const ids = assetRegistryOf(config).list().map((asset) => asset.id);
  const peers = Object.entries(config.fiberPeers.peerChannels.terms).map(([id, terms]) => `${id} from ${terms?.minAmount} base units`);
  io.out(`hub configuration ok: assets ${ids.join(", ")}; peer channels: ${peers.length > 0 ? peers.join(", ") : "none"}\n`);
}

interface Generated {
  path: string;
  before: string;
  after: string;
}

/** One file with its whitelist regenerated for the node `role`; nothing is written yet. */
function generate(path: string, role: FnnNodeRole, udts: readonly UdtAssetSettings[], options: FnnWhitelistOptions, io: FnnWhitelistIo): Generated {
  const before = io.readFile(path);
  const entries = whitelistEntries(udts, role, role === FNN_NODE_ROLE.DEMO ? options.demoAutoAccept : {});
  try {
    return { path, before, after: replaceWhitelist(before, entries, role) };
  } catch (error) {
    throw error instanceof WhitelistError ? new WhitelistError(`${path}: ${error.message}`) : error;
  }
}

/** Prints a generated file's diff and writes it where the options say. */
function publish({ path, before, after }: Generated, options: FnnWhitelistOptions, io: FnnWhitelistIo): void {
  const changed = after !== before;
  io.out(changed ? unifiedDiff(before, after, path, `${path} (generated)`) : "");
  if (options.outDir !== null) io.writeFile(join(options.outDir, basename(path)), after);
  else if (options.write && changed) io.writeFile(path, after);
  const verb = !changed ? "unchanged" : options.write ? "written" : options.outDir !== null ? `changed, written to ${options.outDir}` : "would change (dry run)";
  io.out(`${path}: ${verb}\n`);
}

/**
 * A token a file whitelists now and the new list leaves out: --write refuses it (no file is written) unless --allow-drop,
 * since a channel in a token fnn no longer whitelists cannot close after fnn restarts; a dry run notes it. --out-dir
 * (add_token.py on the server) compares with the files fnn runs itself.
 */
function assertNothingDropped(generated: readonly Generated[], options: FnnWhitelistOptions, io: FnnWhitelistIo): void {
  if (options.outDir !== null) return;
  const dropped = generated.flatMap(({ path, before, after }) => droppedTokens(before, after).map((name) => `${path}: ${name}`));
  if (dropped.length === 0) return;
  const what = `the new whitelist leaves out ${dropped.join(", ")}`;
  if (!options.write) return void io.out(`note: ${what}; --write refuses it without --allow-drop\n`);
  if (!options.allowDrop) {
    throw new WhitelistError(`${what}: nothing written. Put the token back in FIBER_ASSETS, or pass --allow-drop once no channel in it is left`);
  }
}

/** --out-dir writes each file under its own name, so the two must differ. */
function assertDistinctOutNames(options: FnnWhitelistOptions): void {
  if (options.outDir === null || options.hubYml === null || options.demoYml === null) return;
  if (basename(options.hubYml) === basename(options.demoYml)) throw new WhitelistError("--out-dir needs --hub-yml and --demo-yml files with different names");
}

/**
 * Runs the CLI; returns the exit code: 1 when anything is refused, with the reason on stderr. Refused input writes
 * nothing; a write that fails part-way (--write) leaves the files stdout reports as written.
 */
export function runFnnWhitelist(argv: readonly string[], io: FnnWhitelistIo): number {
  try {
    const options = parseFnnWhitelistArgs(argv);
    assertDistinctOutNames(options);
    const fiberAssets = assetsText(options.source, io);
    const udts = readAssets(fiberAssets);
    assertKnownDemoIds(options, udts);
    if (options.checkConfig) checkConfig(options, fiberAssets, io);
    const targets = [
      [options.hubYml, FNN_NODE_ROLE.HUB],
      [options.demoYml, FNN_NODE_ROLE.DEMO],
    ] as const;
    const generated = targets.flatMap(([path, role]) => (path === null ? [] : [generate(path, role, udts, options, io)]));
    assertNothingDropped(generated, options, io);
    for (const file of generated) publish(file, options, io);
    return EXIT.OK;
  } catch (error) {
    if (!(error instanceof WhitelistError)) throw error;
    io.err(`fnn-whitelist: ${error.message}\n\n${FNN_WHITELIST_USAGE}\n`);
    return EXIT.REFUSED;
  }
}

if (require.main === module) process.exitCode = runFnnWhitelist(process.argv.slice(2), nodeIo());
