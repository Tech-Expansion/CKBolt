import { clientAddressKey } from "../client-address";
import { API_ERROR_CODE, HUB_PROXY_ERROR_CODE, HUB_PROXY_HEADER, type HubErrorCode } from "./contract";
import type { HubProxyConfig } from "./config";
import {
  FORWARDED_HEADER_VALUE_PATTERN,
  HTTP_HEADER,
  HTTP_STATUS,
  HUB_MESSAGE,
  HUB_PROXY_BASE_PATH,
  HUB_PROXY_LOG_PREFIX,
  JSON_CONTENT_TYPE,
  MS_PER_SECOND,
  NO_STORE,
  RATE_LIMIT_KEY,
  type HttpMethod,
} from "./constants";
import { FixedWindowRateLimiter } from "./rate-limit";
import { forgedRequestReason } from "./request-guard";
import { HUB_VERSION_SEGMENT, matchHubRoute, type HubRoute } from "./routes";

export interface HubProxyDeps {
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  rateLimiter: Pick<FixedWindowRateLimiter, "take">;
  /** Where server log lines go; console.error by default. */
  log?: (line: string) => void;
}

/** Response headers passed back from the hub; everything else is dropped. */
const PASSED_HEADERS = [HTTP_HEADER.CONTENT_TYPE, HTTP_HEADER.RETRY_AFTER] as const;

const isTimeout = (e: unknown): boolean => e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");

/** `{ error: { code, message } }`, never cached. */
export function errorResponse(status: number, code: HubErrorCode, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { [HTTP_HEADER.CONTENT_TYPE]: JSON_CONTENT_TYPE, [HTTP_HEADER.CACHE_CONTROL]: NO_STORE, ...headers },
  });
}

/** Who a request comes from: the address our proxy saw (null when unknown) and the key it counts against. */
export interface RequestClient {
  address: string | null;
  key: string;
}

/**
 * X-Forwarded-For means something only behind our own proxy, and only its last entry, which that proxy appends; earlier
 * entries come from the client and can be forged. Without one, callers share a key. The key is the address for IPv4
 * and its /64 network for IPv6 (../client-address.ts), so a client cannot get a fresh budget from each of its IPv6
 * addresses.
 */
export function requestClient(request: Request, trustProxy: boolean): RequestClient {
  if (!trustProxy) return { address: null, key: RATE_LIMIT_KEY.SHARED };
  const address = request.headers.get(HTTP_HEADER.FORWARDED_FOR)?.split(",").pop()?.trim();
  if (!address) return { address: null, key: RATE_LIMIT_KEY.LOCAL };
  const key = clientAddressKey(address);
  return key ? { address, key } : { address: null, key: RATE_LIMIT_KEY.UNKNOWN };
}

/** The key a request counts against (requestClient). */
export const clientKey = (request: Request, trustProxy: boolean): string => requestClient(request, trustProxy).key;

/** The request body as text, or null when it is larger than `maxBytes`. Stops reading as soon as it is. */
export async function readBodyWithin(request: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(request.headers.get(HTTP_HEADER.CONTENT_LENGTH));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
}

/** The hub's `Location: /v1/...` as seen through the proxy. */
export const proxiedLocation = (location: string): string =>
  location.startsWith(`/${HUB_VERSION_SEGMENT}/`) ? `${HUB_PROXY_BASE_PATH}${location}` : location;

const isAllowedMethod = (method: string, allowed: readonly HttpMethod[]): method is HttpMethod =>
  (allowed as readonly string[]).includes(method);

/**
 * The browser's headers the route passes on (HubRoute.forwardedHeaders: the cancel token on POST /v1/swaps/:id/cancel),
 * each only when it is one short run of visible ASCII; anything else is dropped, and the hub answers as if it was
 * missing. Never logged.
 */
export function forwardedHeaders(request: Request, route: Pick<HubRoute, "forwardedHeaders">): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of route.forwardedHeaders ?? []) {
    const value = request.headers.get(name)?.trim();
    if (value && FORWARDED_HEADER_VALUE_PATTERN.test(value)) out[name] = value;
  }
  return out;
}

/**
 * Same-origin proxy to the hub: only the v1 paths the app calls (./routes.ts; any other path, the hub's demo wallet
 * included, is a 404 that never reaches the hub), an allow-list of methods per path, writes only from the app's own
 * pages (./request-guard.ts), a body size limit, a timeout, a rate limit and no caching. With HUB_PROXY_SECRET it sends
 * the hub that secret and the client key it rate-limits by, so the hub can count each visitor; the secret never goes
 * back to the browser, and unsafe settings around it (config.problems) stop the proxy. Errors are
 * `{ error: { code, message } }`.
 */
export class HubProxy {
  private problemsLogged = false;

  constructor(
    private readonly config: HubProxyConfig,
    private readonly deps: HubProxyDeps,
  ) {}

  async handle(request: Request, segments: readonly string[]): Promise<Response> {
    const route = matchHubRoute(segments);
    if (!route) return errorResponse(HTTP_STATUS.NOT_FOUND, API_ERROR_CODE.NOT_FOUND, HUB_MESSAGE.UNKNOWN_PATH);
    const method = request.method.toUpperCase();
    if (!isAllowedMethod(method, route.methods)) {
      return errorResponse(HTTP_STATUS.METHOD_NOT_ALLOWED, HUB_PROXY_ERROR_CODE.METHOD_NOT_ALLOWED, HUB_MESSAGE.METHOD_NOT_ALLOWED, {
        [HTTP_HEADER.ALLOW]: route.methods.join(", "),
      });
    }
    const forged = forgedRequestReason(request);
    if (forged) return errorResponse(HTTP_STATUS.FORBIDDEN, HUB_PROXY_ERROR_CODE.FORBIDDEN, forged);
    if (!this.config.hubUrl) {
      return errorResponse(HTTP_STATUS.SERVICE_UNAVAILABLE, HUB_PROXY_ERROR_CODE.HUB_UNAVAILABLE, HUB_MESSAGE.NOT_CONFIGURED);
    }
    if (this.config.problems.length > 0) {
      this.logProblemsOnce();
      return errorResponse(HTTP_STATUS.SERVICE_UNAVAILABLE, HUB_PROXY_ERROR_CODE.HUB_UNAVAILABLE, HUB_MESSAGE.MISCONFIGURED);
    }

    const client = requestClient(request, this.config.trustProxy);
    const decision = this.deps.rateLimiter.take(client.key);
    if (!decision.allowed) {
      return errorResponse(HTTP_STATUS.TOO_MANY_REQUESTS, API_ERROR_CODE.RATE_LIMITED, HUB_MESSAGE.RATE_LIMITED, {
        [HTTP_HEADER.RETRY_AFTER]: String(Math.ceil(decision.retryAfterMs / MS_PER_SECOND)),
      });
    }

    const body = method === "POST" ? await readBodyWithin(request, this.config.maxBodyBytes) : undefined;
    if (body === null) return errorResponse(HTTP_STATUS.PAYLOAD_TOO_LARGE, HUB_PROXY_ERROR_CODE.PAYLOAD_TOO_LARGE, HUB_MESSAGE.BODY_TOO_LARGE);

    return this.forward(this.config.hubUrl, method, segments, body, client, forwardedHeaders(request, route));
  }

  /** The unsafe settings, once per process: every refused request would repeat them. */
  private logProblemsOnce(): void {
    if (this.problemsLogged) return;
    this.problemsLogged = true;
    const log = this.deps.log ?? ((line: string) => console.error(line));
    for (const problem of this.config.problems) log(`${HUB_PROXY_LOG_PREFIX} ${problem}`);
  }

  /**
   * What the hub is told besides the body: the headers the route passes on (a swap's cancel token), the client's address
   * behind a trusted proxy (as that proxy wrote it) and, with HUB_PROXY_SECRET, the secret and the same client key this
   * proxy rate-limits by.
   */
  private upstreamHeaders(body: string | undefined, client: RequestClient, passed: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { ...passed, [HTTP_HEADER.ACCEPT]: JSON_CONTENT_TYPE };
    if (body !== undefined) headers[HTTP_HEADER.CONTENT_TYPE] = JSON_CONTENT_TYPE;
    if (client.address) headers[HTTP_HEADER.FORWARDED_FOR] = client.address;
    if (this.config.proxySecret) {
      headers[HUB_PROXY_HEADER.SECRET] = this.config.proxySecret;
      headers[HUB_PROXY_HEADER.CLIENT] = client.key;
    }
    return headers;
  }

  private async forward(
    hubUrl: string,
    method: HttpMethod,
    segments: readonly string[],
    body: string | undefined,
    client: RequestClient,
    passed: Record<string, string>,
  ): Promise<Response> {
    const headers = this.upstreamHeaders(body, client, passed);
    let upstream: Response;
    let text: string;
    try {
      upstream = await this.deps.fetch(`${hubUrl}/${segments.map(encodeURIComponent).join("/")}`, {
        method,
        headers,
        body,
        cache: NO_STORE,
        redirect: "manual",
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
      text = await upstream.text();
    } catch (e) {
      return isTimeout(e)
        ? errorResponse(HTTP_STATUS.GATEWAY_TIMEOUT, HUB_PROXY_ERROR_CODE.HUB_TIMEOUT, HUB_MESSAGE.TIMEOUT)
        : errorResponse(HTTP_STATUS.SERVICE_UNAVAILABLE, HUB_PROXY_ERROR_CODE.HUB_UNAVAILABLE, HUB_MESSAGE.UNREACHABLE);
    }
    return new Response(text, { status: upstream.status, headers: this.responseHeaders(upstream) });
  }

  private responseHeaders(upstream: Response): Record<string, string> {
    const headers: Record<string, string> = { [HTTP_HEADER.CACHE_CONTROL]: NO_STORE };
    for (const name of PASSED_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) headers[name] = value;
    }
    const location = upstream.headers.get(HTTP_HEADER.LOCATION);
    if (location) headers[HTTP_HEADER.LOCATION] = proxiedLocation(location);
    return headers;
  }
}

/** The proxy with real dependencies: global fetch and an in-memory rate limiter on the system clock. */
export function createHubProxy(config: HubProxyConfig, now: () => number = () => Date.now()): HubProxy {
  return new HubProxy(config, {
    fetch: (input, init) => fetch(input, init),
    rateLimiter: new FixedWindowRateLimiter(config.rateLimit, now),
  });
}
