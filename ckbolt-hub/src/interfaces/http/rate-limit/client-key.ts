import type { IncomingHttpHeaders } from "node:http";
import { FORWARDED_FOR_SEPARATOR, HTTP_HEADER, PROXIED_CLIENT_KEY_PATTERN, UNKNOWN_CLIENT_KEY } from "../../../common/constants/http.constants";
import { isLocalNetworkAddress } from "../../../common/utils/network.util";
import { secretsMatch } from "../../../common/utils/secret.util";
import type { HubConfig } from "../../../config/hub.config";

/** The parts of an HTTP request that identify the client (Express's Request has them). */
export interface ClientRequest {
  headers: IncomingHttpHeaders;
  socket: { remoteAddress?: string | undefined };
}

/** What decides a request's client key: HUB_TRUST_PROXY and HUB_PROXY_SECRET. */
export type ClientKeySettings = Pick<HubConfig["server"], "trustProxy" | "proxySecret">;

/** A header sent once, as a string; a repeated header (an array) counts as absent. */
const singleHeader = (headers: IncomingHttpHeaders, name: string): string | null => {
  const value = headers[name];
  return typeof value === "string" ? value : null;
};

/** The last X-Forwarded-For entry: the address the proxy in front of the hub saw. Earlier entries can be forged. */
function lastForwardedFor(header: string | string[] | undefined): string | null {
  if (header === undefined) return null;
  const list = Array.isArray(header) ? header.join(FORWARDED_FOR_SEPARATOR) : header;
  const entries = list
    .split(FORWARDED_FOR_SEPARATOR)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.at(-1) ?? null;
}

/**
 * The key a client is counted by, for the rate limits and the cap on unpaid swaps: the last X-Forwarded-For entry when
 * the hub sits behind a trusted proxy (HubConfig.server.trustProxy) and the request comes from a loopback or private
 * address (where that proxy runs), otherwise the socket address. A client on the internet that reaches the hub
 * directly cannot choose its key with the header, even when the proxy is trusted.
 */
export function clientKeyOf(request: ClientRequest, trustProxy: boolean): string {
  const { remoteAddress } = request.socket;
  const fromTrustedProxy = trustProxy && isLocalNetworkAddress(remoteAddress);
  const forwarded = fromTrustedProxy ? lastForwardedFor(request.headers[HTTP_HEADER.FORWARDED_FOR]) : null;
  return forwarded ?? remoteAddress ?? UNKNOWN_CLIENT_KEY;
}

/** Whether the request carries `secret` in X-CKBolt-Proxy-Secret, compared in constant time. */
export function carriesProxySecret(request: ClientRequest, secret: string): boolean {
  const given = singleHeader(request.headers, HTTP_HEADER.PROXY_SECRET);
  return given !== null && secretsMatch(given, secret);
}

/** The X-CKBolt-Client value, trimmed, when it is 1 to 128 printable characters; null otherwise. */
export function proxiedClientOf(request: ClientRequest): string | null {
  const value = singleHeader(request.headers, HTTP_HEADER.PROXIED_CLIENT)?.trim() ?? null;
  return value !== null && PROXIED_CLIENT_KEY_PATTERN.test(value) ? value : null;
}

/**
 * The key a request is counted by, for the rate limits, the caps on unpaid swaps and the per-client caps on inbound
 * channels. On a request with the hub's proxy secret (HUB_PROXY_SECRET), the visitor the web app's proxy names in
 * X-CKBolt-Client; otherwise, or when that header is absent or invalid, clientKeyOf (HUB_TRUST_PROXY unchanged).
 */
export function requestClientKey(request: ClientRequest, settings: ClientKeySettings): string {
  const proxied = settings.proxySecret !== null && carriesProxySecret(request, settings.proxySecret) ? proxiedClientOf(request) : null;
  return proxied ?? clientKeyOf(request, settings.trustProxy);
}
