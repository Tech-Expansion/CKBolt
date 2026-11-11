import { MULTIADDR_SEPARATOR, MULTIADDR_WEBSOCKET_PROTOCOLS } from "../constants/protocol.constants";

/** The protocol and value segments of a multiaddr: "/ip4/1.2.3.4/tcp/8228/ws" -> ["ip4", "1.2.3.4", "tcp", "8228", "ws"]. */
const segmentsOf = (address: string): string[] => address.split(MULTIADDR_SEPARATOR).slice(1);

/** True for a multiaddr: a path that starts with the separator and has no empty segment. */
export function isMultiaddr(address: string): boolean {
  const segments = segmentsOf(address);
  return address.startsWith(MULTIADDR_SEPARATOR) && segments.length > 0 && segments.every((segment) => segment.length > 0);
}

/** True for a multiaddr a browser node can dial: one with a `ws` or `wss` protocol segment. */
export const isWebSocketMultiaddr = (address: string): boolean =>
  isMultiaddr(address) && segmentsOf(address).some((segment) => MULTIADDR_WEBSOCKET_PROTOCOLS.includes(segment));
