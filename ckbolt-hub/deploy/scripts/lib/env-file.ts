import { isIP } from "node:net";
import { parseEnv } from "node:util";
import { LND_MIN_HOLD_EXPIRY_DELTA_BLOCKS } from "../../../src/common/constants/protocol.constants";
import {
  COMPOSE_FILE_SEPARATOR,
  COMPOSE_PROFILE_SEPARATOR,
  DEMO_PROFILE,
  ENV_TRUE_VALUES,
  KIT_ENV_KEY,
  PUBLIC_OVERLAY_FILE,
  SECRET_FILE_MODE,
  TUNNEL_PROFILE,
  PENDING_FILE_SUFFIX,
} from "./constants";
import { shellQuote } from "./shell";

/**
 * Completing the kit's .env on the server without reading its secrets back: a probe reports which keys are set (and the
 * values of the non-secret ones), a plan says what to add, and a script adds it on the server, generating each secret
 * there. Existing values are never changed.
 */

/** What the probe says about one key of the server's .env. `value` is null for keys the probe may not read. */
export interface EnvKeyState {
  set: boolean;
  value: string | null;
}

export type EnvProbe = ReadonlyMap<string, EnvKeyState>;

const PROBE_FIELD_SEPARATOR = "\t";
const PROBE_SET = "set";
const PROBE_EMPTY = "empty";

/** key=value entries of an env file text, in file order; comments and blank lines are skipped. */
export const envEntries = (text: string): Map<string, string> =>
  new Map(Object.entries(parseEnv(text)).filter((entry): entry is [string, string] => entry[1] !== undefined));

/**
 * A script that prints `<key>\t<set|empty>\t<value>` for each key of the env file at `path`, with the value only for the
 * `readableKeys` (the rest stay on the server). Prints nothing when the file does not exist.
 */
export function envProbeScript(path: string, readableKeys: readonly string[]): string {
  const awk = [
    `BEGIN { n = split(readable, keys, ","); for (i = 1; i <= n; i++) allowed[keys[i]] = 1 }`,
    `/^[A-Za-z_][A-Za-z0-9_]*=/ {`,
    `  key = substr($0, 1, index($0, "=") - 1); value = substr($0, index($0, "=") + 1)`,
    `  printf "%s\\t%s\\t%s\\n", key, (value == "" ? "${PROBE_EMPTY}" : "${PROBE_SET}"), ((key in allowed) ? value : "")`,
    `}`,
  ].join("\n");
  const file = shellQuote(path);
  return `if [ -f ${file} ]; then awk -v readable=${shellQuote(readableKeys.join(","))} ${shellQuote(awk)} ${file}; fi`;
}

export function parseEnvProbe(output: string, readableKeys: readonly string[]): EnvProbe {
  const probe = new Map<string, EnvKeyState>();
  for (const line of output.split("\n")) {
    const [key, state, ...rest] = line.replace(/\r$/, "").split(PROBE_FIELD_SEPARATOR);
    if (!key || (state !== PROBE_SET && state !== PROBE_EMPTY)) continue;
    probe.set(key, { set: state === PROBE_SET, value: readableKeys.includes(key) ? rest.join(PROBE_FIELD_SEPARATOR) : null });
  }
  return probe;
}

/** One key to add: a secret made on the server, or a plain value. */
export type EnvFill = { key: string; kind: "secret"; bytes: number } | { key: string; kind: "value"; value: string };

export interface EnvCompletionPlan {
  fills: EnvFill[];
  /** The non-secret values the .env will hold once the fills are written (for validation). */
  values: Map<string, string>;
}

export interface EnvCompletionInput {
  /** The kit's .env.example: which keys the .env must have, and the default of each non-secret one. */
  exampleText: string;
  probe: EnvProbe;
  /** Secret keys and their size in random bytes. */
  secretBytes: Readonly<Record<string, number>>;
  /** Filled in when the .env has no PUBLIC_IP yet; null when none could be found. */
  publicIp: string | null;
}

/** Which keys of the example are missing or empty on the server, and what to fill them with. */
export function planEnvCompletion({ exampleText, probe, secretBytes, publicIp }: EnvCompletionInput): EnvCompletionPlan {
  const fills: EnvFill[] = [];
  const values = new Map<string, string>();
  for (const [key, exampleValue] of envEntries(exampleText)) {
    const state = probe.get(key);
    if (state?.set) {
      if (state.value !== null) values.set(key, state.value);
      continue;
    }
    const bytes = secretBytes[key];
    if (bytes !== undefined) {
      fills.push({ key, kind: "secret", bytes });
      continue;
    }
    const value = key === KIT_ENV_KEY.PUBLIC_IP ? (publicIp ?? "") : exampleValue;
    values.set(key, value);
    if (state === undefined || value !== "") fills.push({ key, kind: "value", value });
  }
  return { fills, values };
}

const isTrue = (value: string | undefined): boolean => ENV_TRUE_VALUES.includes((value ?? "").trim().toLowerCase());
const listOf = (value: string | undefined, separator: string): string[] =>
  (value ?? "").split(separator).map((item) => item.trim()).filter(Boolean);

/** Settings that contradict each other, as sentences that say what to change. */
export function validateKitEnv(values: ReadonlyMap<string, string>): string[] {
  const problems: string[] = [];
  const profiles = listOf(values.get(KIT_ENV_KEY.COMPOSE_PROFILES), COMPOSE_PROFILE_SEPARATOR);
  if (isTrue(values.get(KIT_ENV_KEY.DEMO_ENABLED)) && !profiles.includes(DEMO_PROFILE)) {
    problems.push(`DEMO_ENABLED=true needs COMPOSE_PROFILES=${DEMO_PROFILE} (the demo wallet's nodes) in the server's .env`);
  }
  const files = listOf(values.get(KIT_ENV_KEY.COMPOSE_FILE), COMPOSE_FILE_SEPARATOR);
  const publicIp = values.get(KIT_ENV_KEY.PUBLIC_IP) ?? "";
  if (files.includes(PUBLIC_OVERLAY_FILE) && isIP(publicIp) !== 4) {
    problems.push(`COMPOSE_FILE lists ${PUBLIC_OVERLAY_FILE}, so PUBLIC_IP must be the server's IPv4 address (set DEPLOY_PUBLIC_IP locally)`);
  }
  // A hand secret is in `values` only when the .env leaves it empty (its value is never read back).
  if (profiles.includes(TUNNEL_PROFILE) && values.get(KIT_ENV_KEY.CLOUDFLARED_TUNNEL_TOKEN) === "") {
    problems.push(`COMPOSE_PROFILES lists ${TUNNEL_PROFILE}, so CLOUDFLARED_TUNNEL_TOKEN must hold the tunnel's token from Cloudflare (set it by hand in the server's .env)`);
  }
  const holdDelta = values.get(KIT_ENV_KEY.LND_HOLD_EXPIRY_DELTA_BLOCKS);
  if (holdDelta !== undefined && !(Number.isSafeInteger(Number(holdDelta)) && Number(holdDelta) >= LND_MIN_HOLD_EXPIRY_DELTA_BLOCKS)) {
    problems.push(`LND_HOLD_EXPIRY_DELTA_BLOCKS must be a whole number of at least ${LND_MIN_HOLD_EXPIRY_DELTA_BLOCKS}`);
  }
  return problems;
}

/** Shell that prints `bytes` random bytes as lower-case hex, on the server. */
export const randomHexCommand = (bytes: number): string => `head -c ${bytes} /dev/urandom | od -An -vtx1 | tr -d ' \\n'`;

/**
 * A script that writes the fills into the env file at `path` (owner-only), replacing empty lines of the same keys.
 * POSIX only (grep, cat), so it runs alike on the Linux server and on a macOS machine, whose sed has no plain `-i`:
 * the kept lines go to a pending copy, then back into the same file, which keeps its owner and mode.
 */
export function envCompletionScript(path: string, fills: readonly EnvFill[]): string {
  const file = shellQuote(path);
  const pending = shellQuote(`${path}${PENDING_FILE_SUFFIX}`);
  const lines = [`set -eu`, `umask 077`, `touch ${file}`, `chmod ${SECRET_FILE_MODE} ${file}`];
  for (const fill of fills) {
    const value = fill.kind === "secret" ? `"$(${randomHexCommand(fill.bytes)})"` : shellQuote(fill.value);
    // grep exits 1 when it keeps no line (an empty file): that is not a failure here.
    lines.push(`{ grep -v ${shellQuote(`^${fill.key}=`)} ${file} || true; } > ${pending}`);
    lines.push(`cat ${pending} > ${file}`, `rm -f ${pending}`);
    lines.push(`printf '%s=%s\\n' ${fill.key} ${value} >> ${file}`);
  }
  return lines.join("\n");
}

/** Lines of the example (`key=value`) whose keys the current file lacks, to append to it. */
export function missingEnvLines(exampleText: string, currentText: string): string[] {
  const current = envEntries(currentText);
  return [...envEntries(exampleText)].filter(([key]) => !current.has(key)).map(([key, value]) => `${key}=${value}`);
}

/** A script that creates `path` with a random hex secret (no newline, owner-only) unless it already holds one. */
export const secretFileScript = (path: string, bytes: number): string => {
  const file = shellQuote(path);
  return `if [ ! -s ${file} ]; then (umask 077 && printf %s "$(${randomHexCommand(bytes)})" > ${file}); fi && chmod ${SECRET_FILE_MODE} ${file}`;
};
