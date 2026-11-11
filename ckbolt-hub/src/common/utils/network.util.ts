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

/** A bind address only the machine itself or its private networks can reach, or one that binds every interface. */
export const isLocalBindHost = (host: string): boolean =>
  host.toLowerCase() === LOCALHOST_NAME || ALL_INTERFACES_ADDRESSES.includes(host) || isLocalNetworkAddress(host);
