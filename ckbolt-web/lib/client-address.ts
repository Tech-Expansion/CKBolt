/**
 * The key a client's IP address is counted under by rate limits and daily caps. An IPv4 address is one key. IPv6
 * addresses are cheap: a single subscriber usually gets a whole /64 and can use a new address for every request, so
 * IPv6 clients are counted per /64 network. Pure: no I/O, so the proxy and the tests share it.
 */

/** IPv6 clients are counted per network of this many leading bits. */
export const IPV6_CLIENT_PREFIX_BITS = 64;

const IPV6_GROUPS = 8;
const IPV6_GROUP_BITS = 16;
const IPV6_GROUP_MAX = 0xffff;
const IPV4_OCTETS = 4;
const IPV4_OCTET_MAX = 255;
const OCTET_BITS = 8;
/** An IPv4-mapped IPv6 address is ::ffff:a.b.c.d: five zero groups, then ffff, then the IPv4 address. */
const IPV4_MAPPED_MARKER_GROUP = 5;
const HEX = 16;

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV4_WITH_PORT = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/;
const HEX_GROUP = /^[0-9a-f]{1,4}$/;
/** `[2001:db8::1]` or `[2001:db8::1]:443`, as some proxies write an IPv6 client. */
const BRACKETED = /^\[([^\]]+)\](?::\d{1,5})?$/;

/** The four octets of a dotted-quad IPv4 address, or null. */
function parseIpv4(text: string): number[] | null {
  const match = IPV4_PATTERN.exec(text);
  if (!match) return null;
  const octets = match.slice(1, IPV4_OCTETS + 1).map(Number);
  return octets.every((o) => o <= IPV4_OCTET_MAX) ? octets : null;
}

/** Hex groups as 16-bit numbers, or null when one is not 1 to 4 hex digits. */
function parseGroups(parts: string[]): number[] | null {
  if (parts.length === 1 && parts[0] === "") return [];
  return parts.every((p) => HEX_GROUP.test(p)) ? parts.map((p) => parseInt(p, HEX)) : null;
}

/** The eight 16-bit groups of an IPv6 address (full, compressed, or with an IPv4 tail), or null. */
function parseIpv6(text: string): number[] | null {
  let address = text.toLowerCase();
  // An IPv4 tail (::ffff:1.2.3.4) stands for the last two groups.
  const lastColon = address.lastIndexOf(":");
  if (lastColon >= 0 && address.includes(".", lastColon)) {
    const octets = parseIpv4(address.slice(lastColon + 1));
    if (!octets) return null;
    const high = (octets[0] << OCTET_BITS) | octets[1];
    const low = (octets[2] << OCTET_BITS) | octets[3];
    address = `${address.slice(0, lastColon + 1)}${high.toString(HEX)}:${low.toString(HEX)}`;
  }
  const halves = address.split("::");
  if (halves.length > 2) return null;
  if (halves.length === 1) {
    const groups = parseGroups(address.split(":"));
    return groups && groups.length === IPV6_GROUPS ? groups : null;
  }
  const head = parseGroups(halves[0].split(":"));
  const tail = parseGroups(halves[1].split(":"));
  // "::" stands for at least one zero group.
  if (!head || !tail || head.length + tail.length > IPV6_GROUPS - 1) return null;
  return [...head, ...new Array<number>(IPV6_GROUPS - head.length - tail.length).fill(0), ...tail];
}

/** Groups as RFC 5952 text: lower-case hex without leading zeros, the longest run of two or more zero groups as "::". */
function formatIpv6(groups: number[]): string {
  let bestStart = -1;
  let bestLength = 1;
  for (let i = 0; i < groups.length; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let end = i;
    while (end < groups.length && groups[end] === 0) end++;
    if (end - i > bestLength) [bestStart, bestLength] = [i, end - i];
    i = end;
  }
  const hex = (part: number[]) => part.map((g) => g.toString(HEX)).join(":");
  if (bestStart < 0) return hex(groups);
  return `${hex(groups.slice(0, bestStart))}::${hex(groups.slice(bestStart + bestLength))}`;
}

/** The first `bits` bits of an address; the rest are zero. */
function networkOf(groups: number[], bits: number): number[] {
  return groups.map((g, i) => {
    const kept = Math.min(Math.max(bits - i * IPV6_GROUP_BITS, 0), IPV6_GROUP_BITS);
    return g & ((IPV6_GROUP_MAX << (IPV6_GROUP_BITS - kept)) & IPV6_GROUP_MAX);
  });
}

const isIpv4Mapped = (groups: number[]): boolean =>
  groups.slice(0, IPV4_MAPPED_MARKER_GROUP).every((g) => g === 0) && groups[IPV4_MAPPED_MARKER_GROUP] === IPV6_GROUP_MAX;

const ipv4Text = (octets: number[]): string => octets.join(".");

/**
 * The rate-limit key of a client address, such as the last X-Forwarded-For entry:
 * - IPv4: the address itself (`203.0.113.7`), with an optional `:port` dropped;
 * - IPv6: its /64 network in RFC 5952 form (`2001:db8:1:2::/64`), brackets, a `:port` after them and a `%zone` dropped;
 * - IPv4-mapped IPv6 (`::ffff:203.0.113.7`): the IPv4 address, so one client does not get two keys;
 * - anything else: null.
 */
export function clientAddressKey(raw: string): string | null {
  let text = raw.trim();
  const bracketed = BRACKETED.exec(text);
  if (bracketed) text = bracketed[1];
  else text = IPV4_WITH_PORT.exec(text)?.[1] ?? text;

  const v4 = parseIpv4(text);
  if (v4) return ipv4Text(v4);

  const zone = text.indexOf("%");
  const groups = parseIpv6(zone >= 0 ? text.slice(0, zone) : text);
  if (!groups) return null;
  if (isIpv4Mapped(groups)) {
    const [high, low] = groups.slice(IPV6_GROUPS - 2);
    return ipv4Text([high >> OCTET_BITS, high & IPV4_OCTET_MAX, low >> OCTET_BITS, low & IPV4_OCTET_MAX]);
  }
  return `${formatIpv6(networkOf(groups, IPV6_CLIENT_PREFIX_BITS))}/${IPV6_CLIENT_PREFIX_BITS}`;
}
