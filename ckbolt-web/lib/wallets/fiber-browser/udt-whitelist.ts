import type { CellDepDto, FiberAssetId, FiberNodeDto, Script, UdtWhitelistDto } from "@/lib/hub/contract";

/**
 * The browser node's UDT whitelist (fnn's `ckb.udt_whitelist`): the tokens it takes channels in, and the amount from
 * which it accepts one by itself (`auto_accept_amount`). fnn reads it only when the node starts, from the config the
 * page builds then (node-config.ts), so a token the hub adds reaches the node at its next start.
 *
 * Merge policy: the hub's entries (GET /v1/fiber/node, `assets[].udtWhitelist`) come first and replace any bundled
 * entry for the same script; the entries fiber-js bundles for the network (RUSD on testnet in 0.9.1) that the hub does
 * not name stay, verbatim. So RUSD keeps working with other nodes and when the hub cannot be reached at start, a token
 * the hub serves is whitelisted exactly as the hub funds it (its cell deps and its auto-accept amount), and nothing the
 * hub sends replaces fiber-js's other entries. fnn takes the first entry whose script matches, so the hub's win.
 *
 * Everything the hub sends is checked before it is written into the YAML (hex, hash types, a short name, a decimal
 * amount); an entry that fails a check is left out, never written in part.
 */

/** A whitelist entry built from the hub's, checked: hex in lower case, the amount as a bigint. */
export interface WhitelistEntry {
  name: string;
  script: Script;
  cellDeps: CellDepDto[];
  /** Base units from which fnn accepts a channel in the token by itself; null: never by itself. */
  autoAcceptAmount: bigint | null;
}

/** An entry of a config's whitelist as fnn reads it: `argsPattern` is a regex over the args (anchored or not). */
export interface NodeUdt {
  name: string | null;
  codeHash: string;
  hashType: string;
  argsPattern: string;
  autoAcceptAmount: bigint | null;
}

const HASH = /^0x[0-9a-f]{64}$/i;
/** Script args: whole bytes of hex, at most 256 bytes (an xUDT's are 32 or 36). */
const ARGS = /^0x(?:[0-9a-f]{2}){0,256}$/i;
const HEX_QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]{0,7})$/i;
const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,31}$/;
/** fnn's amounts are u128: at most 39 digits, and no more than 2^128 - 1. */
const AMOUNT_DIGITS = /^\d{1,39}$/;
const U128_MAX = (BigInt(1) << BigInt(128)) - BigInt(1);
const AMOUNT = { test: (v: string): boolean => AMOUNT_DIGITS.test(v) && BigInt(v) <= U128_MAX };
const HASH_TYPES: readonly string[] = ["type", "data", "data1", "data2"];
const DEP_TYPES: readonly string[] = ["code", "dep_group"];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function checkedScript(v: unknown): Script | null {
  if (!isRecord(v)) return null;
  const { codeHash, hashType, args } = v;
  if (typeof codeHash !== "string" || !HASH.test(codeHash)) return null;
  if (typeof hashType !== "string" || !HASH_TYPES.includes(hashType)) return null;
  if (typeof args !== "string" || !ARGS.test(args)) return null;
  return { codeHash: codeHash.toLowerCase(), hashType: hashType as Script["hashType"], args: args.toLowerCase() };
}

function checkedCellDep(v: unknown): CellDepDto | null {
  if (!isRecord(v)) return null;
  if ("typeId" in v) {
    const typeId = checkedScript(v.typeId);
    return typeId ? { typeId } : null;
  }
  const outPoint = v.outPoint;
  if (!isRecord(outPoint) || typeof outPoint.txHash !== "string" || !HASH.test(outPoint.txHash)) return null;
  if (typeof outPoint.index !== "string" || !HEX_QUANTITY.test(outPoint.index)) return null;
  if (typeof v.depType !== "string" || !DEP_TYPES.includes(v.depType)) return null;
  return { outPoint: { txHash: outPoint.txHash.toLowerCase(), index: outPoint.index.toLowerCase() }, depType: v.depType as "code" | "dep_group" };
}

/** The hub's entry, checked field by field, or null when any field is not what fnn's whitelist takes. */
export function whitelistEntryOf(dto: UdtWhitelistDto | null | undefined): WhitelistEntry | null {
  if (!isRecord(dto) || typeof dto.name !== "string" || !NAME.test(dto.name)) return null;
  const script = checkedScript(dto.script);
  if (!script || !Array.isArray(dto.cellDeps) || dto.cellDeps.length === 0 || dto.cellDeps.length > 8) return null;
  const cellDeps = dto.cellDeps.map(checkedCellDep);
  if (cellDeps.some((dep) => dep === null)) return null;
  const amount = dto.autoAcceptAmount;
  if (amount !== null && (typeof amount !== "string" || !AMOUNT.test(amount))) return null;
  return { name: dto.name, script, cellDeps: cellDeps as CellDepDto[], autoAcceptAmount: amount === null ? null : BigInt(amount) };
}

/** The hub's entries for the UDTs it serves, those that pass the checks, in the hub's order. */
export function hubWhitelist(hubNode: Pick<FiberNodeDto, "assets"> | null): WhitelistEntry[] {
  return (hubNode?.assets ?? []).flatMap((asset) => {
    const entry = asset.udtTypeScript ? whitelistEntryOf(asset.udtWhitelist) : null;
    return entry ? [entry] : [];
  });
}

/* ------------------------------------------------------------------------------------------- YAML lines */

const CKB_SECTION = /^ckb:\s*(#.*)?$/;
const WHITELIST_KEY = /^(\s+)udt_whitelist:\s*(\[\s*\])?\s*(#.*)?$/;
const LIST_ITEM = /^(\s*)-(\s+|$)/;
const COMMENT_OR_BLANK = /^\s*(#.*)?$/;
const DEFAULT_INDENT = "  ";

const indentOf = (line: string): number => line.length - line.trimStart().length;
const isContent = (line: string): boolean => !COMMENT_OR_BLANK.test(line);

/** fnn's whitelist entry for `entry`, as YAML lines whose list dash sits at `dash` (spaces). */
export function whitelistEntryYaml(entry: WhitelistEntry, dash: string): string[] {
  const key = `${dash}  `;
  const lines = [
    `${dash}- name: ${JSON.stringify(entry.name)}`,
    `${key}script:`,
    `${key}  code_hash: ${entry.script.codeHash}`,
    `${key}  hash_type: ${entry.script.hashType}`,
    // fnn reads args as a regex: anchored, it matches this token only.
    `${key}  args: "^${entry.script.args}$"`,
    `${key}cell_deps:`,
  ];
  for (const dep of entry.cellDeps) {
    if ("typeId" in dep) {
      lines.push(`${key}  - type_id:`, `${key}      code_hash: ${dep.typeId.codeHash}`, `${key}      hash_type: ${dep.typeId.hashType}`, `${key}      args: ${dep.typeId.args}`);
    } else {
      lines.push(
        `${key}  - cell_dep:`,
        `${key}      out_point:`,
        `${key}        tx_hash: ${dep.outPoint.txHash}`,
        `${key}        index: ${dep.outPoint.index}`,
        `${key}      dep_type: ${dep.depType}`,
      );
    }
  }
  if (entry.autoAcceptAmount !== null) lines.push(`${key}auto_accept_amount: ${entry.autoAcceptAmount.toString()}`);
  return lines;
}

/** Where the `ckb` section's lines are: [start, end) with `start` its key line; null when the config has none. */
function ckbSection(lines: readonly string[]): { start: number; end: number } | null {
  const start = lines.findIndex((line) => CKB_SECTION.test(line));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (isContent(lines[i]) && indentOf(lines[i]) === 0) {
      end = i;
      break;
    }
  }
  return { start, end };
}

interface WhitelistBlock {
  /** The `udt_whitelist:` line. */
  key: number;
  keyIndent: number;
  /** Just past the last line of its last item; comments after it stay with what follows. */
  end: number;
  /** Each item's lines as [start, end): leading comments belong to the item they precede. */
  items: [number, number][];
}

/** The `udt_whitelist` list inside the `ckb` section, or null when the section has none. */
function whitelistBlock(lines: readonly string[], section: { start: number; end: number }): WhitelistBlock | null {
  for (let key = section.start + 1; key < section.end; key++) {
    const match = WHITELIST_KEY.exec(lines[key]);
    if (!match) continue;
    const keyIndent = match[1].length;
    let end = key + 1;
    const starts: number[] = [];
    let dash: number | null = null;
    if (!match[2]) {
      for (let i = key + 1; i < section.end; i++) {
        const line = lines[i];
        if (!isContent(line)) continue;
        const indent = indentOf(line);
        const item = LIST_ITEM.test(line);
        if (indent < keyIndent || (indent === keyIndent && !item)) break;
        if (item && (dash === null || indent === dash)) {
          dash ??= indent;
          starts.push(i);
        }
        end = i + 1;
      }
    }
    const items = starts.map((start, n): [number, number] => [n === 0 ? key + 1 : start, starts[n + 1] ?? end]);
    // Comments between items belong to the item after them.
    for (let n = 1; n < items.length; n++) {
      let first = starts[n];
      while (first - 1 > items[n - 1][0] && !isContent(lines[first - 1])) first--;
      items[n - 1][1] = first;
      items[n][0] = first;
    }
    return { key, keyIndent, end, items };
  }
  return null;
}

/** A YAML scalar as text: quotes and a trailing comment taken off. */
function scalar(raw: string): string {
  const text = raw.trim();
  const quote = text[0];
  if (quote === '"' || quote === "'") {
    const close = text.indexOf(quote, 1);
    return close > 0 ? text.slice(1, close) : text.slice(1);
  }
  return text.replace(/\s+#.*$/, "").trim();
}

/** One item's fields, read the way fnn reads them: its name, its script's three fields, its auto-accept amount. */
function readItem(lines: readonly string[]): NodeUdt | null {
  // Each content line with the column its key starts at: after the dash on the item's first line.
  const rows: { col: number; text: string }[] = [];
  for (const line of lines) {
    if (!isContent(line)) continue;
    const dash = LIST_ITEM.exec(line);
    if (dash && rows.length === 0) rows.push({ col: dash[0].length, text: line.slice(dash[0].length) });
    else rows.push({ col: indentOf(line), text: line.trim() });
  }
  if (rows.length === 0) return null;
  const itemCol = rows[0].col;
  const field = (text: string, name: string): string | null => {
    const m = new RegExp(`^${name}:(.*)$`).exec(text);
    return m ? scalar(m[1]) : null;
  };
  let name: string | null = null;
  let amount: bigint | null = null;
  const script: Record<string, string> = {};
  for (let i = 0; i < rows.length; i++) {
    const { col, text } = rows[i];
    if (col !== itemCol) continue;
    name = field(text, "name") ?? name;
    const auto = field(text, "auto_accept_amount");
    if (auto !== null && AMOUNT.test(auto)) amount = BigInt(auto);
    if (field(text, "script") === "") {
      const childCol = rows[i + 1]?.col;
      for (let j = i + 1; j < rows.length && rows[j].col > itemCol; j++) {
        if (rows[j].col !== childCol) continue;
        for (const key of ["code_hash", "hash_type", "args"]) {
          const value = field(rows[j].text, key);
          if (value !== null) script[key] = value;
        }
      }
    }
  }
  if (!script.code_hash || !script.hash_type || script.args === undefined) return null;
  return { name, codeHash: script.code_hash.toLowerCase(), hashType: script.hash_type, argsPattern: script.args, autoAcceptAmount: amount };
}

/** The UDT whitelist of a config, entry by entry, as fnn would read it; empty when it has none. */
export function readUdtWhitelist(yaml: string): NodeUdt[] {
  const lines = yaml.split("\n");
  const section = ckbSection(lines);
  const block = section && whitelistBlock(lines, section);
  if (!block) return [];
  return block.items.flatMap(([start, end]) => {
    const udt = readItem(lines.slice(start, end));
    return udt ? [udt] : [];
  });
}

/** The args a pattern names exactly: the pattern without its anchors, when it holds nothing else. */
const exactArgs = (pattern: string): string | null => {
  const bare = pattern.replace(/^\^/, "").replace(/\$$/, "");
  return ARGS.test(bare) ? bare.toLowerCase() : null;
};

/** True when a config's entry names exactly the script of the hub's entry (so the hub's replaces it). */
const sameEntryScript = (udt: NodeUdt, script: Script): boolean =>
  udt.codeHash === script.codeHash && udt.hashType === script.hashType && exactArgs(udt.argsPattern) === script.args;

/**
 * `yaml` with the hub's entries in its `ckb.udt_whitelist`, by the merge policy above: the hub's first, then the
 * config's own entries for scripts the hub does not name, verbatim. Without entries, or without a `ckb` section to put
 * them in, the config is left as it is.
 */
export function withUdtWhitelist(yaml: string, entries: readonly WhitelistEntry[]): string {
  if (entries.length === 0) return yaml;
  const lines = yaml.split("\n");
  const section = ckbSection(lines);
  if (!section) return yaml;
  const block = whitelistBlock(lines, section);
  if (!block) {
    const firstChild = lines.slice(section.start + 1, section.end).find(isContent);
    const indent = firstChild ? " ".repeat(indentOf(firstChild)) : DEFAULT_INDENT;
    const added = [`${indent}udt_whitelist:`, ...entries.flatMap((entry) => whitelistEntryYaml(entry, `${indent}  `))];
    return [...lines.slice(0, section.start + 1), ...added, ...lines.slice(section.start + 1)].join("\n");
  }
  const keyIndent = " ".repeat(block.keyIndent);
  const firstItem = block.items[0] ? lines.slice(block.items[0][0], block.items[0][1]).find((line) => LIST_ITEM.test(line)) : undefined;
  const dash = firstItem ? " ".repeat(indentOf(firstItem)) : `${keyIndent}  `;
  const kept = block.items.flatMap(([start, end]) => {
    const item = lines.slice(start, end);
    const udt = readItem(item);
    return udt && entries.some((entry) => sameEntryScript(udt, entry.script)) ? [] : item;
  });
  return [
    ...lines.slice(0, block.key),
    `${keyIndent}udt_whitelist:`,
    ...entries.flatMap((entry) => whitelistEntryYaml(entry, dash)),
    ...kept,
    ...lines.slice(block.end),
  ].join("\n");
}

/* --------------------------------------------------------------------------------------- what fnn does */

/** fnn's lookup: the first entry with the script's code hash and hash type whose args pattern matches its args. */
export function findNodeUdt(udts: readonly NodeUdt[], script: Script): NodeUdt | null {
  const args = script.args.toLowerCase();
  for (const udt of udts) {
    if (udt.codeHash !== script.codeHash.toLowerCase() || udt.hashType !== script.hashType) continue;
    try {
      if (new RegExp(udt.argsPattern).test(args)) return udt;
    } catch {
      // A pattern fnn could not read either: no match.
    }
  }
  return null;
}

/**
 * True when a node with this whitelist takes the hub's channel in the token by itself: the token is whitelisted with an
 * auto-accept amount at most what the hub funds the channel with (`funding`, base units; null when unknown, then any
 * auto-accept amount counts). The app accepts CKB channels itself, never a token's, so a token channel needs this.
 */
export function takesHubChannel(udts: readonly NodeUdt[], script: Script, funding: bigint | null): boolean {
  const udt = findNodeUdt(udts, script);
  return udt !== null && udt.autoAcceptAmount !== null && (funding === null || udt.autoAcceptAmount <= funding);
}

/**
 * The assets a running node with this whitelist cannot use with the hub until it restarts (the hub gives a valid entry
 * for them, so its next start fixes them): a token the hub funds inbound channels in that the node would not take by
 * itself, and a token the node may open its own channel to the hub in (`peerChannels`) that the whitelist does not name
 * at all (fnn's open_channel refuses a token the opener does not whitelist). Empty when nothing needs a restart.
 */
export function assetsNeedingRestart(udts: readonly NodeUdt[] | null, hubNode: Pick<FiberNodeDto, "assets" | "inbound">): FiberAssetId[] {
  if (udts === null) return [];
  return hubNode.assets.flatMap((asset) => {
    if (!asset.udtTypeScript) return [];
    const entry = whitelistEntryOf(asset.udtWhitelist);
    if (!entry) return [];
    const amount = hubNode.inbound.amounts[asset.id];
    const inbound = !!amount && !takesHubChannel(udts, entry.script, AMOUNT.test(amount) ? BigInt(amount) : null);
    const own = !!asset.peerChannels && findNodeUdt(udts, entry.script) === null;
    return inbound || own ? [asset.id] : [];
  });
}
