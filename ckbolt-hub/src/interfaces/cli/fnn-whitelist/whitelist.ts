import {
  FNN_ARGS_ANCHOR,
  FNN_CONFIG_KEY as KEY,
  FNN_MAX_AUTO_ACCEPT_AMOUNT,
  FNN_NODE_ROLE,
  FNN_YAML_INDENT,
  YAML_EMPTY_LIST,
  type FnnNodeRole,
} from "../../../common/constants/fnn-config.constants";
import { formatBaseUnits } from "../../../common/utils/pricing.util";
import type { UdtAssetSettings } from "../../../config/fiber-assets.config";
import type { CellDep, Script } from "../../../domain/types";

/**
 * fnn's `ckb.udt_whitelist` for the kit's nodes, generated from FIBER_ASSETS, and the edit that puts it into a config file
 * while leaving every other byte of the file as it was. Pure: the CLI (main.ts) reads and writes the files.
 */

/** One whitelist entry (fnn's UdtArgInfo) and what its comments need. */
export interface WhitelistEntry {
  /** fnn's `name`: the asset's symbol. */
  name: string;
  script: Script;
  cellDeps: CellDep[];
  /** fnn's `auto_accept_amount`, base units; null leaves it out (fnn then accepts no channel in the UDT on its own). */
  autoAcceptAmount: bigint | null;
  decimals: number;
}

/** A config file the generator cannot edit safely, or input it refuses. */
export class WhitelistError extends Error {}

/**
 * The whitelist entries of a node, in FIBER_ASSETS order. fnn-hub auto-accepts a UDT only where nodes may open their own
 * channels to the hub (peerChannels.minAmount); fnn-demo auto-accepts the channels fnn-hub opens to it, from the amount
 * configured for it (`demoAutoAccept`) or the asset's autoAcceptAmount (the hub's inbound offer).
 */
export function whitelistEntries(
  udts: readonly UdtAssetSettings[],
  role: FnnNodeRole,
  demoAutoAccept: Readonly<Partial<Record<string, bigint>>> = {},
): WhitelistEntry[] {
  return udts.map(({ asset, peerChannels, autoAcceptAmount }) => {
    if (asset.udtTypeScript === null) throw new WhitelistError(`${asset.id} has no type script to whitelist`);
    const accept = role === FNN_NODE_ROLE.HUB ? peerChannels?.minAmount : (demoAutoAccept[asset.id] ?? autoAcceptAmount);
    if (accept !== undefined && accept > FNN_MAX_AUTO_ACCEPT_AMOUNT) throw new WhitelistError(`${asset.id}: an auto-accept amount must fit fnn's u128`);
    return { name: asset.symbol, script: asset.udtTypeScript, cellDeps: asset.cellDeps, autoAcceptAmount: accept ?? null, decimals: asset.decimals };
  });
}

/* ------------------------------------------------------------------------------------------------ rendering */

/**
 * A YAML scalar as the kit's files write it: plain when it can only read as that string, else a double-quoted (JSON)
 * string. Plain words YAML reads as a boolean or null, and anything starting with a digit, are quoted.
 */
const PLAIN_SCALAR = /^[A-Za-z][A-Za-z0-9 ._-]*$/;
const YAML_KEYWORD = /^(true|false|yes|no|on|off|y|n|null)$/i;
const scalar = (value: string): string =>
  PLAIN_SCALAR.test(value) && value === value.trim() && !YAML_KEYWORD.test(value) ? value : JSON.stringify(value);

const GENERATED_NOTE = "# Generated from the hub's FIBER_ASSETS (docs/add-token.md): change FIBER_ASSETS and generate again, not this list.";
const ARGS_NOTE = "# fnn matches args as an unanchored regex: the anchors keep the entry to this one token.";

const autoAcceptNote = (role: FnnNodeRole, entry: WhitelistEntry, amount: bigint): string => {
  const whole = `${formatBaseUnits(amount, entry.decimals)} ${entry.name}`;
  return role === FNN_NODE_ROLE.HUB
    ? `# Accepts on its own a channel a node opens to the hub with ${whole} or more (FIBER_ASSETS peerChannels.minAmount).`
    : `# Accepts on its own the channels fnn-hub opens with ${whole} or more.`;
};

/** Lines indented by `level` steps on top of `base` spaces. */
const at = (base: number, level: number, text: string): string => `${" ".repeat(base + level * FNN_YAML_INDENT)}${text}`;

/** A script's three keys; `args` anchored as a regex when it is the whitelisted script, as is for a type id. */
function scriptLines(base: number, level: number, script: Script, anchored: boolean): string[] {
  const args = anchored ? `"${FNN_ARGS_ANCHOR.START}${script.args}${FNN_ARGS_ANCHOR.END}"` : script.args;
  return [
    at(base, level, `${KEY.CODE_HASH}: ${script.codeHash}`),
    at(base, level, `${KEY.HASH_TYPE}: ${script.hashType}`),
    ...(anchored ? [at(base, level, ARGS_NOTE)] : []),
    at(base, level, `${KEY.ARGS}: ${args}`),
  ];
}

function cellDepLines(base: number, dep: CellDep): string[] {
  if ("typeId" in dep) return [at(base, 3, `- ${KEY.TYPE_ID}:`), ...scriptLines(base, 5, dep.typeId, false)];
  return [
    at(base, 3, `- ${KEY.CELL_DEP}:`),
    at(base, 5, `${KEY.OUT_POINT}:`),
    at(base, 6, `${KEY.TX_HASH}: ${dep.outPoint.txHash}`),
    at(base, 6, `${KEY.INDEX}: ${dep.outPoint.index}`),
    at(base, 5, `${KEY.DEP_TYPE}: ${dep.depType}`),
  ];
}

function entryLines(base: number, role: FnnNodeRole, entry: WhitelistEntry): string[] {
  const accept = entry.autoAcceptAmount;
  return [
    at(base, 1, `- ${KEY.NAME}: ${scalar(entry.name)}`),
    at(base, 2, `${KEY.SCRIPT}:`),
    ...scriptLines(base, 3, entry.script, true),
    at(base, 2, `${KEY.CELL_DEPS}:`),
    ...entry.cellDeps.flatMap((dep) => cellDepLines(base, dep)),
    ...(accept === null ? [] : [at(base, 2, autoAcceptNote(role, entry, accept)), at(base, 2, `${KEY.AUTO_ACCEPT_AMOUNT}: ${accept}`)]),
  ];
}

/** The whole `udt_whitelist` key and its list, the key at `keyIndent` spaces, as lines without line ends. */
export function renderWhitelist(entries: readonly WhitelistEntry[], role: FnnNodeRole, keyIndent: number): string[] {
  if (entries.length === 0) return [at(keyIndent, 0, `${KEY.UDT_WHITELIST}: ${YAML_EMPTY_LIST}`)];
  return [at(keyIndent, 0, `${KEY.UDT_WHITELIST}:`), at(keyIndent, 1, GENERATED_NOTE), ...entries.flatMap((entry) => entryLines(keyIndent, role, entry))];
}

/* ---------------------------------------------------------------------------------------------- the file edit */

const LINE_END = /\r?\n$/;
const WHITELIST_KEY = new RegExp(`^( *)${KEY.UDT_WHITELIST}:(.*)$`);
const SECTION_KEY = /^( *)([A-Za-z_][\w-]*):/;
const COMMENT = /^\s*#/;
const LIST_ITEM = /^ *-( |$)/;

interface Line {
  text: string;
  end: string;
}

const splitLines = (file: string): Line[] =>
  (file.match(/[^\n]*\n|[^\n]+$/g) ?? []).map((raw) => {
    const end = LINE_END.exec(raw)?.[0] ?? "";
    return { text: raw.slice(0, raw.length - end.length), end };
  });

const indentOf = (text: string): number => text.length - text.trimStart().length;
const isBlank = (text: string): boolean => text.trim() === "";

/** The value after `udt_whitelist:` on its own line, without a trailing comment: "" for a block list. */
const inlineValue = (rest: string): string => rest.replace(/\s+#.*$/, "").trim();

/** The section a key at `index` sits in: the nearest earlier key line indented less. */
function parentKey(lines: readonly Line[], index: number, indent: number): string | null {
  for (let i = index - 1; i >= 0; i -= 1) {
    const text = lines[i]?.text ?? "";
    if (isBlank(text) || COMMENT.test(text) || indentOf(text) >= indent) continue;
    return SECTION_KEY.exec(text)?.[2] ?? null;
  }
  return null;
}

/**
 * Index of the last line of the block list under the key at `keyIndex`: lines indented more, or list items at its level.
 * Blank and comment lines belong to it only when more of the list follows them.
 */
function blockEnd(lines: readonly Line[], keyIndex: number, keyIndent: number): number {
  let last = keyIndex;
  for (let i = keyIndex + 1; i < lines.length; i += 1) {
    const text = lines[i]?.text ?? "";
    if (isBlank(text) || COMMENT.test(text)) continue;
    const indent = indentOf(text);
    if (indent > keyIndent || (indent === keyIndent && LIST_ITEM.test(text))) last = i;
    else break;
  }
  return last;
}

/** The one `udt_whitelist` key of the file, under `ckb`; refuses a file with none, several, or one elsewhere. */
function findWhitelistKey(lines: readonly Line[]): { index: number; indent: number; inline: string } {
  const found = lines.flatMap((line, index) => {
    const match = WHITELIST_KEY.exec(line.text);
    return match ? [{ index, indent: match[1]?.length ?? 0, inline: inlineValue(match[2] ?? "") }] : [];
  });
  if (found.length !== 1) throw new WhitelistError(`expected one ${KEY.UDT_WHITELIST} key, found ${found.length}`);
  const key = found[0]!;
  if (parentKey(lines, key.index, key.indent) !== KEY.CKB) throw new WhitelistError(`${KEY.UDT_WHITELIST} must sit under ${KEY.CKB}:`);
  if (key.inline !== "" && key.inline !== YAML_EMPTY_LIST) throw new WhitelistError(`${KEY.UDT_WHITELIST} must be a block list or ${YAML_EMPTY_LIST}`);
  return key;
}

/**
 * The file with its `ckb.udt_whitelist` replaced by `entries`, every other byte kept (line ends included: new lines take
 * the key line's). The same input gives the same output, so running it twice changes nothing the second time.
 */
export function replaceWhitelist(file: string, entries: readonly WhitelistEntry[], role: FnnNodeRole): string {
  const lines = splitLines(file);
  const key = findWhitelistKey(lines);
  const end = key.inline === "" ? blockEnd(lines, key.index, key.indent) : key.index;
  if (key.inline !== "" && blockEnd(lines, key.index, key.indent) !== key.index) {
    throw new WhitelistError(`${KEY.UDT_WHITELIST}: ${key.inline} cannot be followed by list items`);
  }
  const eol = lines[key.index]?.end || "\n";
  const lastEnd = lines[end]?.end ?? "";
  const rendered = renderWhitelist(entries, role, key.indent);
  const block = rendered.map((text, i) => `${text}${i === rendered.length - 1 ? lastEnd : eol}`).join("");
  const before = lines.slice(0, key.index).map(({ text, end: e }) => text + e).join("");
  const after = lines.slice(end + 1).map(({ text, end: e }) => text + e).join("");
  return before + block + after;
}

const ENTRY_NAME = /^ *- +name: *"?([^"#]+?)"? *(#.*)?$/;
const SCRIPT_KEY = /^( *)script: *(#.*)?$/;
const SCRIPT_FIELD = /^ *(code_hash|args): *"?\^?(0x[0-9a-fA-F]*)\$?"? *(#.*)?$/;

/**
 * The tokens a config's `ckb.udt_whitelist` names, as `code_hash args` (lower case, args without the `^…$` anchors, so an
 * older unanchored file reads the same as a generated one) to the entry's name.
 */
export function whitelistedScripts(file: string): Map<string, string> {
  const lines = splitLines(file);
  const key = findWhitelistKey(lines);
  if (key.inline !== "") return new Map();
  const found = new Map<string, string>();
  let name: string | null = null;
  let scriptIndent: number | null = null;
  let codeHash: string | null = null;
  for (const { text } of lines.slice(key.index + 1, blockEnd(lines, key.index, key.indent) + 1)) {
    if (isBlank(text) || COMMENT.test(text)) continue;
    const entry = ENTRY_NAME.exec(text);
    if (entry) {
      [name, scriptIndent, codeHash] = [entry[1]?.trim() ?? null, null, null];
      continue;
    }
    const script = SCRIPT_KEY.exec(text);
    if (script) {
      [scriptIndent, codeHash] = [script[1]?.length ?? 0, null];
      continue;
    }
    if (scriptIndent === null || indentOf(text) <= scriptIndent) {
      scriptIndent = null;
      continue;
    }
    const field = SCRIPT_FIELD.exec(text);
    if (field?.[1] === KEY.CODE_HASH) codeHash = field[2]?.toLowerCase() ?? null;
    else if (field?.[1] === KEY.ARGS && codeHash !== null && name !== null) found.set(`${codeHash} ${field[2]?.toLowerCase()}`, name);
  }
  return found;
}

/** The names of the tokens `before` whitelists that `after` no longer does. */
export function droppedTokens(before: string, after: string): string[] {
  const kept = whitelistedScripts(after);
  return [...whitelistedScripts(before)].filter(([script]) => !kept.has(script)).map(([, name]) => name);
}
