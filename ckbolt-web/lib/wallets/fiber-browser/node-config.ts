/**
 * The browser node's config: fiber-js's bundled YAML for the network (getDefaultConfig, which already sets the CKB RPC
 * URL) with the peers a browser can actually reach. A WASM node cannot listen and dials WebSocket only, so the bundled
 * TCP bootnodes are replaced by WebSocket ones (the hub's, plus any configured) and the node announces no address.
 * The tokens the hub serves are added to its UDT whitelist (udt-whitelist.ts), so the node takes the hub's channels in
 * them. The edit works on lines because fiber-js keeps its YAML parser inside the bundle; the version is pinned, and
 * when a key is not found the YAML is left as it is (the node then dials the hub explicitly after start anyway).
 */

import { NODE_AUTO_ACCEPT_CKB_FUNDING_SHANNONS } from "./constants";
import { withUdtWhitelist, type WhitelistEntry } from "./udt-whitelist";

const BOOTNODES_KEY = /^(\s*)bootnode_addrs:\s*(\[\s*\])?\s*(#.*)?$/;
const ANNOUNCE_KEY = /^(\s*)announce_listening_addr:\s*\S+.*$/;
const FIBER_SECTION = /^fiber:\s*(#.*)?$/;
const ACCEPT_FUNDING_KEY = /^\s*auto_accept_channel_ckb_funding_amount:/;
const ACCEPT_FUNDING_FIELD = "auto_accept_channel_ckb_funding_amount";
const FIBER_SECTION_INDENT = "  ";
const LIST_ITEM = /^\s*-(\s|$)/;
const COMMENT_OR_BLANK = /^\s*(#.*)?$/;

const indentOf = (line: string): number => line.length - line.trimStart().length;

/**
 * Index just past the old items of the list whose key is on line `keyIndex`: its `- ` items (deeper than the key, or at
 * the key's own indent, which YAML also allows), with the comments and blank lines between them. Comments and blank
 * lines after the last item stay, since they may belong to the next key.
 */
function endOfOldItems(lines: readonly string[], keyIndex: number, keyIndent: number): number {
  let end = keyIndex + 1;
  for (let i = keyIndex + 1; i < lines.length; i++) {
    if (COMMENT_OR_BLANK.test(lines[i])) continue;
    if (!LIST_ITEM.test(lines[i]) || indentOf(lines[i]) < keyIndent) break;
    end = i + 1;
  }
  return end;
}

/**
 * Replaces the `bootnode_addrs` list with `bootnodes`, turns off `announce_listening_addr`, sets what the node puts
 * into a CKB channel it accepts automatically (a line of the `fiber` section): NODE_AUTO_ACCEPT_CKB_FUNDING_SHANNONS by
 * default, which turns automatic acceptance of CKB channels off, and puts the hub's `udtWhitelist` entries in the `ckb`
 * section's `udt_whitelist` (udt-whitelist.ts, which keeps fiber-js's own entries for other tokens). The config is built
 * afresh at every start and never saved, so a node started before a setting existed, or before the hub served a
 * token, picks it up at its next start.
 */
export function browserNodeConfig(
  defaultYaml: string,
  bootnodes: readonly string[],
  acceptFundingShannons: bigint | null = NODE_AUTO_ACCEPT_CKB_FUNDING_SHANNONS,
  udtWhitelist: readonly WhitelistEntry[] = [],
): string {
  const lines = defaultYaml.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (acceptFundingShannons !== null && ACCEPT_FUNDING_KEY.test(line)) continue;
    if (acceptFundingShannons !== null && FIBER_SECTION.test(line)) {
      out.push(line, `${FIBER_SECTION_INDENT}${ACCEPT_FUNDING_FIELD}: ${acceptFundingShannons.toString()}`);
      continue;
    }
    const bootnodesKey = BOOTNODES_KEY.exec(line);
    if (bootnodesKey) {
      const indent = bootnodesKey[1];
      if (bootnodes.length === 0) {
        out.push(`${indent}bootnode_addrs: []`);
      } else {
        out.push(`${indent}bootnode_addrs:`);
        for (const address of bootnodes) out.push(`${indent}  - ${JSON.stringify(address)}`);
      }
      i = endOfOldItems(lines, i, indent.length) - 1;
      continue;
    }
    const announce = ANNOUNCE_KEY.exec(line);
    out.push(announce ? `${announce[1]}announce_listening_addr: false` : line);
  }
  return withUdtWhitelist(out.join("\n"), udtWhitelist);
}

/**
 * The WebSocket multiaddrs a page can dial: on an https page only TLS ones (`/wss`, or `/tls/.../ws`), since browsers
 * block plain ws:// from secure pages other than localhost.
 */
export function dialableAddresses(addresses: readonly string[], secureOnly: boolean): string[] {
  const isTls = (a: string) => /\/wss(\/|$)/.test(a) || /\/tls\//.test(a);
  const isWs = (a: string) => isTls(a) || /\/ws(\/|$)/.test(a);
  return addresses.filter((a) => isWs(a) && (!secureOnly || isTls(a)));
}

/** True when plain ws:// is blocked here: an https page (localhost is a secure context over http, so it is not). */
export const needsTlsPeers = (location: { protocol: string }): boolean => location.protocol === "https:";
