import { HTTP_HEADER, HUB_MESSAGE, JSON_CONTENT_TYPE, SAFE_HTTP_METHODS, SEC_FETCH_SITE_SAME_ORIGIN } from "./constants";

/**
 * Cross-site request forgery guard of the hub proxy. Another site can make a visitor's browser send a "simple" POST
 * (`fetch(..., { mode: "no-cors" })` or a form) with a text/plain body and no preflight; the proxy would then spend that
 * visitor's rate-limit budget and daily caps at the hub. So every write must:
 * - not be marked by the browser as coming from anywhere but this origin (`Sec-Fetch-Site`, sent by current browsers);
 * - not carry an `Origin` other than this server's own (for older browsers), compared by host with the request URL,
 *   `Host` and `X-Forwarded-Host`. A page cannot set those on a cross-origin request; the scheme is left out because
 *   TLS ends at the platform's edge;
 * - declare a JSON body (`content-type: application/json`, parameters allowed), which no simple request can.
 * Reads (GET) pass: another site's page cannot read the answers, which carry no CORS headers.
 */

/** The media type of a Content-Type value, lower-case and without parameters (`application/json; charset=utf-8`). */
export const mediaTypeOf = (contentType: string | null): string => (contentType ?? "").split(";")[0].trim().toLowerCase();

/** Whether `method` changes something, so it must come from the app's own pages. */
export const isWriteMethod = (method: string): boolean => !SAFE_HTTP_METHODS.includes(method.toUpperCase());

/** The hosts (with any port) this request was sent to: its URL's, `Host`, and every `X-Forwarded-Host` entry. */
function ownHosts(request: Request): string[] {
  const forwarded = request.headers.get(HTTP_HEADER.FORWARDED_HOST)?.split(",") ?? [];
  return [new URL(request.url).host, request.headers.get(HTTP_HEADER.HOST), ...forwarded]
    .map((host) => host?.trim().toLowerCase())
    .filter((host): host is string => Boolean(host));
}

/** The host of an http(s) `Origin` value (`https://ckbolt.example` gives `ckbolt.example`); null for `null` or garbage. */
function originHost(origin: string): string | null {
  try {
    const url = new URL(origin.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.host.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Why a request must be refused as forged (a HUB_MESSAGE sentence), or null when it may go on. */
export function forgedRequestReason(request: Request): string | null {
  if (!isWriteMethod(request.method)) return null;
  const site = request.headers.get(HTTP_HEADER.SEC_FETCH_SITE);
  if (site !== null && site.trim().toLowerCase() !== SEC_FETCH_SITE_SAME_ORIGIN) return HUB_MESSAGE.CROSS_SITE;
  const origin = request.headers.get(HTTP_HEADER.ORIGIN);
  if (origin !== null) {
    const host = originHost(origin);
    if (!host || !ownHosts(request).includes(host)) return HUB_MESSAGE.CROSS_SITE;
  }
  if (mediaTypeOf(request.headers.get(HTTP_HEADER.CONTENT_TYPE)) !== JSON_CONTENT_TYPE) return HUB_MESSAGE.NOT_JSON;
  return null;
}
