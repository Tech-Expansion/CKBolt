import { BlockList, isIP } from "node:net";
import { ALL_INTERFACES_ADDRESSES, LOCAL_NETWORKS, LOCALHOST_NAME } from "../constants/http.constants";

/** IP version of an address as BlockList names it; isIP returns 4 or 6 for an address, 0 for anything else. */
const IP_FAMILY: Readonly<Record<number, "ipv4" | "ipv6">> = { 4: "ipv4", 6: "ipv6" };

const localNetworks = new BlockList();
for (const { address, prefix, family } of LOCAL_NETWORKS) localNetworks.addSubnet(address, prefix, family);

/**
 * True for a loopback or private IP address (LOCAL_NETWORKS), IPv4-mapped IPv6 forms included ("::ffff:10.0.0.1", as
 * Node reports IPv4 peers of a dual-stack server). False for public addresses, host names and anything unreadable.
 */
export function isLocalNetworkAddress(address: string | undefined): boolean {
  const family = address === undefined ? undefined : IP_FAMILY[isIP(address)];
  return family !== undefined && address !== undefined && localNetworks.check(address, family);
}

const loopbackNetworks = new BlockList();
loopbackNetworks.addSubnet("127.0.0.0", 8, "ipv4");
loopbackNetworks.addAddress("::1", "ipv6");

/** A bind address only the machine itself can reach: localhost, 127.0.0.0/8 or ::1. */
export function isLoopbackHost(host: string): boolean {
  if (host.toLowerCase() === LOCALHOST_NAME) return true;
  const family = IP_FAMILY[isIP(host)];
  return family !== undefined && loopbackNetworks.check(host, family);
}

/** A bind address only the machine itself or its private networks can reach, or one that binds every interface. */
export const isLocalBindHost = (host: string): boolean =>
  host.toLowerCase() === LOCALHOST_NAME || ALL_INTERFACES_ADDRESSES.includes(host) || isLocalNetworkAddress(host);

/** IPv6 groups that name the network one client controls: a provider or tunnel hands out at least a /64. */
const IPV6_CLIENT_PREFIX_GROUPS = 4;
const IPV6_GROUP_COUNT = 8;
/** ::ffff:0:0/96: five zero groups, then ffff, then the IPv4 address in the last two groups. */
const IPV4_MAPPED_ZERO_GROUPS = 5;
const IPV4_MAPPED_MARK = "ffff";
const BYTE_BITS = 8;
const BYTE_MASK = 0xff;
const HEX_RADIX = 16;

/**
 * The key rate limits count a client address by: an IPv4 address as it is (also written as IPv4-mapped IPv6), an IPv6
 * address as its /64, since one client can use every address in it. Anything else (a host name, "unknown") unchanged.
 */
export function clientNetworkKey(address: string): string {
  const [bare = address] = address.split("%");
  if (isIP(bare) !== 6) return address;
  const groups = ipv6Groups(bare);
  const mapped = mappedIpv4(groups);
  if (mapped) return mapped;
  return `${groups.slice(0, IPV6_CLIENT_PREFIX_GROUPS).join(":")}::/64`;
}

/** The IPv4 address an IPv4-mapped IPv6 address carries, however it was written (dotted, hex, zeros in full); else null. */
function mappedIpv4(groups: readonly string[]): string | null {
  const isMapped =
    groups.slice(0, IPV4_MAPPED_ZERO_GROUPS).every((group) => group === "0") && groups[IPV4_MAPPED_ZERO_GROUPS] === IPV4_MAPPED_MARK;
  if (!isMapped) return null;
  return groups
    .slice(IPV4_MAPPED_ZERO_GROUPS + 1)
    .map((group) => Number.parseInt(group, HEX_RADIX))
    .flatMap((value) => [value >> BYTE_BITS, value & BYTE_MASK])
    .join(".");
}

/** The eight 16-bit groups of a valid IPv6 address, lower-case hex without leading zeros. */
function ipv6Groups(address: string): string[] {
  const [head, tail] = address.includes("::") ? address.split("::") : [address, undefined];
  const groupsOf = (text: string | undefined): string[] => (text ? text.split(":").flatMap(dottedTailGroups) : []);
  const left = groupsOf(head);
  const right = groupsOf(tail);
  const zeros = tail === undefined ? [] : Array<string>(IPV6_GROUP_COUNT - left.length - right.length).fill("0");
  return [...left, ...zeros, ...right].map((group) => Number.parseInt(group, HEX_RADIX).toString(HEX_RADIX));
}

/** A dotted IPv4 tail ("1.2.3.4") as its two IPv6 groups; any other part as it is. */
function dottedTailGroups(part: string): string[] {
  if (!part.includes(".")) return [part];
  const [a = 0, b = 0, c = 0, d = 0] = part.split(".").map(Number);
  return [((a << BYTE_BITS) | b).toString(HEX_RADIX), ((c << BYTE_BITS) | d).toString(HEX_RADIX)];
}
