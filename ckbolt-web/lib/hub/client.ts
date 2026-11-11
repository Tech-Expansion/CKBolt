import {
  API_ERROR_CODE,
  API_ROUTES,
  HUB_PROXY_ERROR_CODE,
  SWAP_CANCEL_TOKEN_HEADER,
  type AssetDto,
  type CreateInboundChannelBody,
  type CreateLightningInboundChannelBody,
  type CreateQuoteBody,
  type CreateSwapBody,
  type CreatedSwapDto,
  type FiberNodeDto,
  type HealthDto,
  type HubErrorCode,
  type InboundChannelDto,
  type InboundChannelOpeningDto,
  type LightningInboundChannelDto,
  type LightningInboundChannelOpeningDto,
  type LightningNodeDto,
  type ListBody,
  type QuoteDto,
  type SwapDto,
  type SwapEventDto,
} from "./contract";
import {
  HTTP_HEADER,
  HTTP_STATUS,
  HUB_MESSAGE,
  HUB_PROXY_BASE_PATH,
  JSON_CONTENT_TYPE,
  NO_STORE,
  type HttpMethod,
} from "./constants";
import { hubResourcePath } from "./routes";

/** An error from the hub or the proxy in front of it, with the `{ error: { code, message } }` it answered. */
export class HubApiError extends Error {
  constructor(
    /** HTTP status; 0 when no answer arrived. */
    readonly status: number,
    readonly code: HubErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HubApiError";
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HubClientOptions {
  /** Where the hub API is mounted; the same-origin proxy by default. */
  baseUrl?: string;
  fetch?: FetchLike;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** The `{ error }` body of a failed answer as a HubApiError; a generic one when the body is not that shape. */
export function parseHubError(status: number, body: unknown): HubApiError {
  const error = isRecord(body) && isRecord(body.error) ? body.error : null;
  if (error && typeof error.code === "string" && typeof error.message === "string") {
    return new HubApiError(status, error.code as HubErrorCode, error.message);
  }
  return new HubApiError(status, API_ERROR_CODE.INTERNAL, HUB_MESSAGE.UNREADABLE);
}

/** Anything thrown while talking to the hub, as a HubApiError. */
export const toHubApiError = (e: unknown): HubApiError =>
  e instanceof HubApiError ? e : new HubApiError(0, API_ERROR_CODE.INTERNAL, HUB_MESSAGE.UNEXPECTED);

const isHealthDto = (body: unknown): body is HealthDto =>
  isRecord(body) && (body.status === "ok" || body.status === "degraded") && isRecord(body.lightning) && isRecord(body.fiber);

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** Typed client for the hub's REST API v1, through the web app's proxy: the calls the app makes (./routes.ts). */
export class HubClient {
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;

  constructor(options: HubClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? HUB_PROXY_BASE_PATH).replace(/\/+$/, "");
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
  }

  /** The hub answers 503 with a HealthDto when a node is unreachable; that is a report, not an error. */
  async health(): Promise<HealthDto> {
    const { res, body } = await this.send("GET", hubResourcePath(API_ROUTES.HEALTH));
    if (isHealthDto(body) && (res.ok || res.status === HTTP_STATUS.SERVICE_UNAVAILABLE)) return body;
    throw parseHubError(res.status, body);
  }

  async listAssets(): Promise<AssetDto[]> {
    return (await this.call<ListBody<AssetDto>>("GET", hubResourcePath(API_ROUTES.ASSETS))).data;
  }

  createQuote(body: CreateQuoteBody): Promise<QuoteDto> {
    return this.call("POST", hubResourcePath(API_ROUTES.QUOTES), body);
  }

  /** The swap, with its cancel token: the caller keeps the token in memory or drops it, and never shows or stores it. */
  createSwap(body: CreateSwapBody): Promise<CreatedSwapDto> {
    return this.call("POST", hubResourcePath(API_ROUTES.SWAPS), body);
  }

  /**
   * Cancels a swap nobody has paid (its hold invoice too), with the token POST /v1/swaps answered: the swap as the hub
   * saved it. Asking again answers the same; 403 cancel_refused without the right token, 409 conflict once a payment
   * arrived. The hub reads no body, but the proxy takes only JSON writes, so it sends an empty object.
   */
  cancelSwap(id: string, cancelToken: string): Promise<SwapDto> {
    return this.call("POST", hubResourcePath(API_ROUTES.SWAPS, id, API_ROUTES.SWAP_CANCEL), {}, { [SWAP_CANCEL_TOKEN_HEADER]: cancelToken });
  }

  getSwap(id: string): Promise<SwapDto> {
    return this.call("GET", hubResourcePath(API_ROUTES.SWAPS, id));
  }

  async listSwapEvents(id: string): Promise<SwapEventDto[]> {
    return (await this.call<ListBody<SwapEventDto>>("GET", hubResourcePath(API_ROUTES.SWAPS, id, API_ROUTES.SWAP_EVENTS))).data;
  }

  /** The hub's Fiber node: id, network, addresses a browser node can dial, assets, inbound policy. */
  getFiberNode(): Promise<FiberNodeDto> {
    return this.call("GET", hubResourcePath(API_ROUTES.FIBER_NODE));
  }

  /** Asks the hub's Fiber node to open a channel to `body.nodeId`, which must be connected to it (202 when started). */
  requestInboundChannel(body: CreateInboundChannelBody): Promise<InboundChannelOpeningDto> {
    return this.call("POST", hubResourcePath(API_ROUTES.FIBER_INBOUND_CHANNELS), body);
  }

  /** The channels between the hub's Fiber node and `nodeId`, as the hub sees them. */
  async listInboundChannels(nodeId: string): Promise<InboundChannelDto[]> {
    return (await this.call<ListBody<InboundChannelDto>>("GET", hubResourcePath(API_ROUTES.FIBER_INBOUND_CHANNELS, nodeId))).data;
  }

  /** The hub's Lightning node: pubkey, network, the URIs a wallet adds as a peer, and the channel it opens to wallets. */
  getLightningNode(): Promise<LightningNodeDto> {
    return this.call("GET", hubResourcePath(API_ROUTES.LIGHTNING_NODE));
  }

  /** Asks the hub's Lightning node to open a channel to `body.pubkey`, which must be its peer already (202 when started). */
  requestLightningInboundChannel(body: CreateLightningInboundChannelBody): Promise<LightningInboundChannelOpeningDto> {
    return this.call("POST", hubResourcePath(API_ROUTES.LIGHTNING_INBOUND_CHANNELS), body);
  }

  /** The channels between the hub's Lightning node and the wallet `pubkey`, as the hub sees them. */
  async listLightningInboundChannels(pubkey: string): Promise<LightningInboundChannelDto[]> {
    return (await this.call<ListBody<LightningInboundChannelDto>>("GET", hubResourcePath(API_ROUTES.LIGHTNING_INBOUND_CHANNELS, pubkey))).data;
  }

  private async call<T>(method: HttpMethod, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
    const answer = await this.send(method, path, body, extraHeaders);
    if (!answer.res.ok) throw parseHubError(answer.res.status, answer.body);
    return answer.body as T;
  }

  private async send(method: HttpMethod, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<{ res: Response; body: unknown }> {
    const headers: Record<string, string> = { [HTTP_HEADER.ACCEPT]: JSON_CONTENT_TYPE, ...extraHeaders };
    if (body !== undefined) headers[HTTP_HEADER.CONTENT_TYPE] = JSON_CONTENT_TYPE;
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: NO_STORE,
      });
    } catch {
      throw new HubApiError(0, HUB_PROXY_ERROR_CODE.HUB_UNAVAILABLE, HUB_MESSAGE.UNREACHABLE);
    }
    return { res, body: await readJson(res) };
  }
}
