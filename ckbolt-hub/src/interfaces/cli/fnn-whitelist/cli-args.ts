import { ASSET_ID_PATTERN } from "../../../common/constants/assets.constants";
import { WhitelistError } from "./whitelist";

/** Where FIBER_ASSETS comes from: an env file (hub.env), a file holding the JSON list, or this process's environment. */
export type AssetsSource = { kind: "env-file"; path: string } | { kind: "assets-file"; path: string } | { kind: "process-env" };

export interface FnnWhitelistOptions {
  source: AssetsSource;
  hubYml: string | null;
  demoYml: string | null;
  /** fnn-demo's auto-accept amount per asset id, where it should differ from the asset's autoAcceptAmount. */
  demoAutoAccept: Record<string, bigint>;
  /** Write the changed files in place. */
  write: boolean;
  /** Write every generated file into this folder (by its file name) instead; the inputs stay as they are. */
  outDir: string | null;
  /** Validate the whole hub configuration (loadHubConfig) of this process's environment first. */
  checkConfig: boolean;
  /** With --write: let the new whitelist leave out a token the file names now (refused otherwise). */
  allowDrop: boolean;
}

export const FNN_WHITELIST_USAGE = [
  "Usage: fnn-whitelist (--hub-env <hub.env> | --assets-file <fiber-assets.json> | --from-env)",
  "                     [--hub-yml <fnn/hub.yml>] [--demo-yml <fnn/demo.yml>] [--demo-auto-accept ID=AMOUNT[,ID=AMOUNT]]",
  "                     [--write [--allow-drop] | --out-dir <folder>] [--check-config]",
  "Rewrites only ckb.udt_whitelist of each file from FIBER_ASSETS and prints the diff; without --write or --out-dir it",
  "changes nothing. fnn-hub auto-accepts a UDT only from its peerChannels.minAmount; fnn-demo from --demo-auto-accept or",
  "the asset's autoAcceptAmount. --write refuses to leave out a token a file names now, unless --allow-drop: a channel in a",
  "token fnn no longer whitelists cannot close after fnn restarts.",
].join("\n");

const WHOLE_NUMBER = /^[1-9]\d*$/;
/** `--hub-env`, not `--env-file`: Node reads an `--env-file` anywhere on its command line, even after the script. */
const VALUE_FLAGS = ["--hub-env", "--assets-file", "--hub-yml", "--demo-yml", "--demo-auto-accept", "--out-dir"] as const;
const SWITCHES = ["--from-env", "--write", "--check-config", "--allow-drop"] as const;

/** `RUSD=1000000000,CWBTC=1000000000` as amounts by asset id; refuses a malformed pair or an id given twice. */
function parseDemoAutoAccept(value: string, into: Record<string, bigint>): void {
  for (const pair of value.split(",").map((part) => part.trim()).filter(Boolean)) {
    const [id = "", amount = "", ...rest] = pair.split("=");
    if (rest.length > 0 || !ASSET_ID_PATTERN.test(id) || !WHOLE_NUMBER.test(amount)) {
      throw new WhitelistError(`--demo-auto-accept takes ID=AMOUNT (base units, above 0), got "${pair}"`);
    }
    if (into[id] !== undefined) throw new WhitelistError(`--demo-auto-accept names ${id} twice`);
    into[id] = BigInt(amount);
  }
}

function sourceOf(values: Map<string, string>, switches: Set<string>): AssetsSource {
  const given = [values.has("--hub-env"), values.has("--assets-file"), switches.has("--from-env")].filter(Boolean).length;
  if (given !== 1) throw new WhitelistError("give exactly one of --hub-env, --assets-file and --from-env");
  if (switches.has("--from-env")) return { kind: "process-env" };
  const envFile = values.get("--hub-env");
  return envFile !== undefined ? { kind: "env-file", path: envFile } : { kind: "assets-file", path: values.get("--assets-file")! };
}

/** The command line as options; refuses unknown flags, missing values and contradictions. */
export function parseFnnWhitelistArgs(argv: readonly string[]): FnnWhitelistOptions {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  const demoAutoAccept: Record<string, bigint> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    if ((SWITCHES as readonly string[]).includes(flag)) {
      switches.add(flag);
      continue;
    }
    if (!(VALUE_FLAGS as readonly string[]).includes(flag)) throw new WhitelistError(`unknown option ${flag}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new WhitelistError(`${flag} needs a value`);
    i += 1;
    if (flag === "--demo-auto-accept") parseDemoAutoAccept(value, demoAutoAccept);
    else if (values.has(flag)) throw new WhitelistError(`${flag} is given twice`);
    else values.set(flag, value);
  }
  const options: FnnWhitelistOptions = {
    source: sourceOf(values, switches),
    hubYml: values.get("--hub-yml") ?? null,
    demoYml: values.get("--demo-yml") ?? null,
    demoAutoAccept,
    write: switches.has("--write"),
    outDir: values.get("--out-dir") ?? null,
    checkConfig: switches.has("--check-config"),
    allowDrop: switches.has("--allow-drop"),
  };
  if (options.write && options.outDir !== null) throw new WhitelistError("--write and --out-dir exclude each other");
  if (options.allowDrop && !options.write) throw new WhitelistError("--allow-drop goes with --write");
  if (options.hubYml === null && options.demoYml === null && !options.checkConfig) {
    throw new WhitelistError("nothing to do: give --hub-yml, --demo-yml or --check-config");
  }
  return options;
}
